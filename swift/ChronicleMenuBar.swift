// swift/ChronicleMenuBar.swift — Chronicle 菜单栏 App（单文件，纯 AppKit，无 Xcode 工程）
//
// 形态：LSUIElement=true（无 Dock 图标），NSStatusItem 常驻菜单栏；三态图标：
//   运行中 chart.bar.doc.horizontal / 已暂停 pause.circle / 未运行 exclamationmark.circle
//
// 菜单（id 稳定，便于测试）：
//   status(disabled) / open-timeline / pause-15 / pause-60 / pause-forever / resume /
//   ai-tools / copy-mcp / open-data / open-logs / autostart(勾选) / quit
//
// 无头模式（验收关键，不弹 UI）：
//   --selftest                     构建菜单模型并输出 JSON（status/menu/config/autostart）
//   --action <pause15|pause60|pause-forever|resume|copy-mcp|status|permission-accessibility|permission-screen|open-timeline|open-model|open-ai|open-data|open-logs>
//                                  直接执行动作并输出 JSON；open-* 只打印 URL 不真打开
//   --port N / --config PATH / --home DIR 可覆盖配置
//
// 配置：<home>/app-config.json = {repoRoot, nodePath, home, port}（setup.mjs 写入）；
//       缺失时用默认 home + 推断 repoRoot/nodePath，并在状态行提示「配置缺失，重跑 setup」。
//
// 红线：本 App 不截屏、不录音；只通过本地 HTTP API 控制/读取状态，不碰事件内容。

import AppKit
import Foundation

// MARK: - 常量

let APP_NAME = "Chronicle"
let APP_BUNDLE_ID = "com.chronicle.menubar"
let DEFAULT_PORT = 3777
let POLL_INTERVAL_SEC: TimeInterval = 5.0
let HTTP_TIMEOUT_SEC: TimeInterval = 2.0
let DAEMON_LAUNCHD_LABEL = "com.chronicle.daemon"
let MENUBAR_LAUNCHD_LABEL = "com.chronicle.menubar"

/// 版本号：App Bundle 的 CFBundleShortVersionString（setup 从 package.json 写入）；裸二进制回退 dev。
func appVersion() -> String {
    (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "0.0.0-dev"
}

// MARK: - 配置

struct ChronicleConfigFile: Codable {
    var repoRoot: String?
    var nodePath: String?
    var home: String?
    var port: Int?
}

struct ResolvedConfig {
    var repoRoot: String
    var nodePath: String
    var home: String
    var port: Int
    var missing: Bool
    var configPath: String
}

/// 用户 HOME：优先 $HOME（测试/launchd 注入），回退 NSHomeDirectory()。
func userHome() -> String {
    if let h = ProcessInfo.processInfo.environment["HOME"], !h.isEmpty { return h }
    return NSHomeDirectory()
}

func defaultChronicleHome() -> String {
    if let h = ProcessInfo.processInfo.environment["CHRONICLE_HOME"], !h.isEmpty { return h }
    return (userHome() as NSString).appendingPathComponent(".chronicle")
}

func defaultAppConfigPath(home: String) -> String {
    (home as NSString).appendingPathComponent("app-config.json")
}

func daemonLaunchAgentPath() -> String {
    ((userHome() as NSString).appendingPathComponent("Library/LaunchAgents") as NSString)
        .appendingPathComponent("\(DAEMON_LAUNCHD_LABEL).plist")
}

func fileExists(_ path: String) -> Bool { FileManager.default.fileExists(atPath: path) }

/// 从 cwd / 可执行文件位置向上找含 daemon.mjs 的目录（安装后也能定位仓库）。
func inferRepoRoot() -> String? {
    if let env = ProcessInfo.processInfo.environment["CHRONICLE_REPO_ROOT"], !env.isEmpty, fileExists("\(env)/daemon.mjs") {
        return env
    }
    var candidates: [String] = []
    let cwd = FileManager.default.currentDirectoryPath
    candidates.append(cwd)
    let exe = CommandLine.arguments.first ?? ""
    if exe.hasPrefix("/") { candidates.append((exe as NSString).deletingLastPathComponent) }
    for start in candidates {
        var dir = start
        for _ in 0..<8 {
            if !dir.isEmpty && dir != "/" && fileExists("\(dir)/daemon.mjs") { return dir }
            let parent = (dir as NSString).deletingLastPathComponent
            if parent == dir { break }
            dir = parent
        }
    }
    return nil
}

func inferNodePath(_ configured: String?) -> String {
    let candidates: [String] = [
        configured ?? "",
        ProcessInfo.processInfo.environment["CHRONICLE_NODE"] ?? "",
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ]
    for c in candidates where !c.isEmpty {
        if FileManager.default.isExecutableFile(atPath: c) { return c }
    }
    return "/usr/bin/env" // 回退：/usr/bin/env node <script>
}

func loadResolvedConfig(configPathOverride: String?, portOverride: Int?, homeOverride: String?) -> ResolvedConfig {
    let envHome = ProcessInfo.processInfo.environment["CHRONICLE_HOME"]
    let baseHome = homeOverride ?? ((envHome?.isEmpty == false) ? envHome! : defaultChronicleHome())
    let cfgPath = configPathOverride ?? defaultAppConfigPath(home: baseHome)
    var raw: ChronicleConfigFile? = nil
    if let data = FileManager.default.contents(atPath: cfgPath) {
        raw = try? JSONDecoder().decode(ChronicleConfigFile.self, from: data)
    }
    let missing = raw == nil
    let home = raw?.home ?? baseHome
    var repoRoot = ""
    if let r = raw?.repoRoot, !r.isEmpty { repoRoot = r }        // setup 写入的仓库根优先
    else if let inferred = inferRepoRoot() { repoRoot = inferred }
    let nodePath = inferNodePath(raw?.nodePath)
    let port = portOverride ?? raw?.port ?? DEFAULT_PORT
    return ResolvedConfig(repoRoot: repoRoot, nodePath: nodePath, home: home, port: port, missing: missing, configPath: cfgPath)
}

// MARK: - 进程与 HTTP

func runProcess(_ executable: String, _ arguments: [String], timeout: TimeInterval = 15) -> (code: Int32, stdout: String, stderr: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: executable)
    p.arguments = arguments
    let outPipe = Pipe()
    let errPipe = Pipe()
    p.standardOutput = outPipe
    p.standardError = errPipe
    do { try p.run() } catch { return (-1, "", error.localizedDescription) }
    let outData = outPipe.fileHandleForReading.readDataToEndOfFile()
    let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (p.terminationStatus, String(data: outData, encoding: .utf8) ?? "", String(data: errData, encoding: .utf8) ?? "")
}

let httpSession: URLSession = {
    let cfg = URLSessionConfiguration.ephemeral
    cfg.timeoutIntervalForRequest = HTTP_TIMEOUT_SEC
    cfg.timeoutIntervalForResource = HTTP_TIMEOUT_SEC + 1.0
    return URLSession(configuration: cfg)
}()

/// 同步 HTTP JSON 请求（CLI/动作模式用；UI 轮询也在后台队列调用）。
func httpJSON(port: Int, path: String, method: String = "GET", body: [String: Any]? = nil) -> (status: Int, json: Any?)? {
    guard let url = URL(string: "http://127.0.0.1:\(port)\(path)") else { return nil }
    var req = URLRequest(url: url, timeoutInterval: HTTP_TIMEOUT_SEC)
    req.httpMethod = method
    if let body = body {
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    var result: (status: Int, json: Any?)? = nil
    let sem = DispatchSemaphore(value: 0)
    let task = httpSession.dataTask(with: req) { data, response, error in
        defer { sem.signal() }
        guard error == nil, let http = response as? HTTPURLResponse else { return }
        let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) }
        result = (http.statusCode, json)
    }
    task.resume()
    _ = sem.wait(timeout: .now() + HTTP_TIMEOUT_SEC + 2.0)
    return result
}

// MARK: - 状态模型

enum ChronicleState: String {
    case running
    case paused
    case notRunning = "not-running"
}

struct StatusSnapshot {
    var reachable = false
    var running = false
    var paused = false
    var todayEvents: Int? = nil
    var axGranted: Bool? = nil
    var screenGranted: Bool? = nil

    var state: ChronicleState {
        if !reachable { return .notRunning }
        if paused { return .paused }
        return running ? .running : .notRunning
    }

    var iconName: String {
        switch state {
        case .running: return "chart.bar.doc.horizontal"
        case .paused: return "pause.circle"
        case .notRunning: return "exclamationmark.circle"
        }
    }

    func statusLabel(configMissing: Bool) -> String {
        var label: String
        switch state {
        case .running:
            if let n = todayEvents { label = "运行中 · 今日 \(n) 条事件" } else { label = "运行中" }
        case .paused:
            label = "已暂停"
        case .notRunning:
            label = "未运行"
        }
        if configMissing { label += " · 配置缺失，重跑 setup" }
        return label
    }
}

func todayPrefix() -> String {
    let fmt = DateFormatter()
    fmt.locale = Locale(identifier: "en_US_POSIX")
    fmt.timeZone = TimeZone.current
    fmt.dateFormat = "yyyy-MM-dd"
    return fmt.string(from: Date())
}

func fetchStatus(port: Int) -> (reachable: Bool, running: Bool, paused: Bool) {
    guard let res = httpJSON(port: port, path: "/api/status"), res.status == 200 else {
        return (false, false, false)
    }
    let obj = res.json as? [String: Any]
    let ok = (obj?["ok"] as? Bool) ?? false
    let st = obj?["status"] as? [String: Any]
    let running = (st?["running"] as? Bool) ?? false
    let paused = (st?["paused"] as? Bool) ?? false
    return (ok && st != nil, running, paused)
}

/// 今日事件计数：取 /api/segments?limit=1 的最新段，若它在本地“今天”内则用 eventCount。
func fetchTodayEvents(port: Int) -> Int? {
    guard let res = httpJSON(port: port, path: "/api/segments?limit=1"), res.status == 200 else { return nil }
    let obj = res.json as? [String: Any]
    guard let items = (obj?["items"] as? [[String: Any]]) ?? (obj?["segments"] as? [[String: Any]]),
          let first = items.first else { return nil }
    guard let start = first["segmentStart"] as? String, start.hasPrefix(todayPrefix()) else { return 0 }
    return (first["eventCount"] as? Int) ?? (first["eventCount"] as? NSNumber)?.intValue ?? 0
}

/// 权限状态：未运行时返回 nil（菜单不显示权限项，避免误导）。
func fetchPermissions(port: Int) -> (ax: Bool?, screen: Bool?) {
    guard let res = httpJSON(port: port, path: "/api/permissions"), res.status == 200,
          let obj = res.json as? [String: Any] else { return (nil, nil) }
    return (obj["axGranted"] as? Bool, obj["screenGranted"] as? Bool)
}

func snapshot(port: Int) -> StatusSnapshot {
    var snap = StatusSnapshot()
    let st = fetchStatus(port: port)
    snap.reachable = st.reachable
    snap.running = st.running
    snap.paused = st.paused
    if st.reachable {
        snap.todayEvents = fetchTodayEvents(port: port)
        let perms = fetchPermissions(port: port)
        snap.axGranted = perms.ax
        snap.screenGranted = perms.screen
    }
    return snap
}

// MARK: - 菜单模型

struct MenuItemModel {
    let id: String
    let label: String
    let enabled: Bool
    let checked: Bool?
}

func buildMenuModel(snap: StatusSnapshot, config: ResolvedConfig, autostartInstalled: Bool) -> [MenuItemModel] {
    let active = snap.reachable && snap.running && !snap.paused
    let paused = snap.reachable && snap.paused
    var items: [MenuItemModel] = [
        MenuItemModel(id: "status", label: snap.statusLabel(configMissing: config.missing), enabled: false, checked: nil),
    ]
    if snap.axGranted == false {
        items.append(MenuItemModel(id: "permission-accessibility", label: "需要辅助功能权限 · 点击授权", enabled: true, checked: nil))
    }
    if snap.screenGranted == false {
        items.append(MenuItemModel(id: "permission-screen", label: "需要屏幕录制权限（按需 OCR） · 点击授权", enabled: true, checked: nil))
    }
    items.append(contentsOf: [
        MenuItemModel(id: "open-timeline", label: "打开时间线", enabled: true, checked: nil),
        MenuItemModel(id: "open-model", label: "模型配置…", enabled: true, checked: nil),
        MenuItemModel(id: "pause-15", label: "暂停 15 分钟", enabled: active, checked: nil),
        MenuItemModel(id: "pause-60", label: "暂停 1 小时", enabled: active, checked: nil),
        MenuItemModel(id: "pause-forever", label: "暂停直到手动恢复", enabled: active, checked: nil),
        MenuItemModel(id: "resume", label: "恢复记录", enabled: paused, checked: nil),
        MenuItemModel(id: "ai-tools", label: "AI 工具接入…", enabled: true, checked: nil),
        MenuItemModel(id: "copy-mcp", label: "复制 MCP 配置", enabled: true, checked: nil),
        MenuItemModel(id: "open-data", label: "打开数据文件夹", enabled: true, checked: nil),
        MenuItemModel(id: "open-logs", label: "查看日志", enabled: true, checked: nil),
        MenuItemModel(id: "autostart", label: "开机自启", enabled: true, checked: autostartInstalled),
        MenuItemModel(id: "quit", label: "退出 Chronicle", enabled: true, checked: nil),
    ])
    return items
}

func menuModelJSON(_ items: [MenuItemModel]) -> [[String: Any]] {
    items.map { item in
        var dict: [String: Any] = ["id": item.id, "label": item.label, "enabled": item.enabled]
        if let checked = item.checked { dict["checked"] = checked }
        else { dict["checked"] = NSNull() }
        return dict
    }
}

func statusJSON(_ snap: StatusSnapshot) -> [String: Any] {
    var dict: [String: Any] = [
        "reachable": snap.reachable,
        "running": snap.running,
        "paused": snap.paused,
        "state": snap.state.rawValue,
        "icon": snap.iconName,
    ]
    if let n = snap.todayEvents { dict["todayEvents"] = n } else { dict["todayEvents"] = NSNull() }
    dict["axGranted"] = snap.axGranted.map { $0 as Any } ?? NSNull()
    dict["screenGranted"] = snap.screenGranted.map { $0 as Any } ?? NSNull()
    return dict
}

func configJSON(_ config: ResolvedConfig) -> [String: Any] {
    [
        "repoRoot": config.repoRoot,
        "nodePath": config.nodePath,
        "home": config.home,
        "port": config.port,
        "missing": config.missing,
        "configPath": config.configPath,
    ]
}

func isAutostartInstalled() -> Bool { fileExists(daemonLaunchAgentPath()) }

// MARK: - 动作实现（UI 与 --action 共用）

/// MCP 配置文本：优先 `node <repo>/mcp-install.mjs --print`，失败则自己拼 fallback。
func buildMcpConfig(config: ResolvedConfig) -> (source: String, config: [String: Any], text: String) {
    let installScript = (config.repoRoot as NSString).appendingPathComponent("mcp-install.mjs")
    if !config.repoRoot.isEmpty && fileExists(installScript) {
        let r = runProcess(config.nodePath, [installScript, "--print"], timeout: 20)
        if r.code == 0, let data = r.stdout.data(using: .utf8),
           let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           obj["mcpServers"] != nil {
            return ("mcp-install", obj, r.stdout.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }
    let entry = (config.repoRoot as NSString).appendingPathComponent("mcp-entry.mjs")
    let fallback: [String: Any] = ["mcpServers": ["chronicle": ["command": "node", "args": [entry]]]]
    var text = "{}"
    if let data = try? JSONSerialization.data(withJSONObject: fallback, options: [.prettyPrinted, .sortedKeys]) {
        text = String(data: data, encoding: .utf8) ?? "{}"
    }
    return ("fallback", fallback, text)
}

func pauseBody(durationSec: Int?) -> [String: Any]? {
    guard let d = durationSec else { return nil }
    return ["durationSec": d]
}

/// 执行动作；返回输出 JSON 字典。
func performAction(_ action: String, config: ResolvedConfig) -> [String: Any] {
    switch action {
    case "pause15", "pause60", "pause-forever":
        let durationSec: Int? = action == "pause15" ? 900 : (action == "pause60" ? 3600 : nil)
        guard let res = httpJSON(port: config.port, path: "/api/pause", method: "POST", body: pauseBody(durationSec: durationSec)), res.status == 200 else {
            return ["ok": false, "action": action, "error": "无法连接 Chronicle 服务（127.0.0.1:\(config.port)）"]
        }
        var out: [String: Any] = ["ok": true, "action": action, "port": config.port]
        if let d = durationSec { out["durationSec"] = d }
        out["response"] = res.json ?? NSNull()
        return out
    case "resume":
        guard let res = httpJSON(port: config.port, path: "/api/resume", method: "POST"), res.status == 200 else {
            return ["ok": false, "action": action, "error": "无法连接 Chronicle 服务（127.0.0.1:\(config.port)）"]
        }
        return ["ok": true, "action": action, "port": config.port, "response": res.json ?? NSNull()]
    case "status":
        let snap = snapshot(port: config.port)
        return ["ok": true, "action": action, "status": statusJSON(snap)]
    case "copy-mcp":
        let mcp = buildMcpConfig(config: config)
        return ["ok": true, "action": action, "source": mcp.source, "config": mcp.config, "text": mcp.text]
    case "permission-accessibility", "permission-screen":
        let path = action == "permission-screen" ? "/api/permissions/screen" : "/api/permissions/request"
        guard let res = httpJSON(port: config.port, path: path, method: "POST", body: [:]), res.status == 200 else {
            return ["ok": false, "action": action, "error": "无法连接 Chronicle 服务（127.0.0.1:\(config.port)）"]
        }
        return ["ok": true, "action": action, "port": config.port, "response": res.json ?? NSNull()]
    case "open-timeline":
        return ["ok": true, "action": action, "url": "http://127.0.0.1:\(config.port)/"]
    case "open-model":
        return ["ok": true, "action": action, "url": "http://127.0.0.1:\(config.port)/?view=model"]
    case "open-ai":
        return ["ok": true, "action": action, "url": "http://127.0.0.1:\(config.port)/?view=ai"]
    case "open-data":
        return ["ok": true, "action": action, "url": "file://\(config.home)"]
    case "open-logs":
        return ["ok": true, "action": action, "url": "file://\(config.home)/logs"]
    default:
        return ["ok": false, "action": action, "error": "未知动作: \(action)"]
    }
}

// MARK: - CLI 参数

struct CLIOptions {
    var selftest = false
    var action: String? = nil
    var port: Int? = nil
    var configPath: String? = nil
    var home: String? = nil
    var help = false
}

func parseCLI(_ argv: [String]) -> CLIOptions {
    var opts = CLIOptions()
    var i = 0
    while i < argv.count {
        let a = argv[i]
        func value() -> String? { i += 1; return i < argv.count ? argv[i] : nil }
        switch a {
        case "--selftest": opts.selftest = true
        case "--action": opts.action = value()
        case "--port": if let v = value() { opts.port = Int(v) }
        case "--config": opts.configPath = value()
        case "--home": opts.home = value()
        case "--help", "-h": opts.help = true
        default: break
        }
        i += 1
    }
    return opts
}

func printJSON(_ obj: Any, exitCode: Int32) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]),
       let text = String(data: data, encoding: .utf8) {
        print(text)
    } else {
        print("{\"ok\":false,\"error\":\"JSON 序列化失败\"}")
    }
    exit(exitCode)
}

func selftestPayload(_ config: ResolvedConfig) -> [String: Any] {
    let snap = snapshot(port: config.port)
    let autostart = isAutostartInstalled()
    let items = buildMenuModel(snap: snap, config: config, autostartInstalled: autostart)
    return [
        "app": APP_NAME,
        "bundleId": APP_BUNDLE_ID,
        "version": appVersion(),
        "config": configJSON(config),
        "status": statusJSON(snap),
        "menu": menuModelJSON(items),
        "autostart": [
            "label": DAEMON_LAUNCHD_LABEL,
            "plistPath": daemonLaunchAgentPath(),
            "installed": autostart,
        ],
    ]
}

// MARK: - UI

final class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem?
    var menu = NSMenu()
    var pollTimer: Timer?
    var resolved: ResolvedConfig!
    var current = StatusSnapshot()
    var cli: CLIOptions = CLIOptions()

    func applicationDidFinishLaunching(_ notification: Notification) {
        resolved = loadResolvedConfig(configPathOverride: cli.configPath, portOverride: cli.port, homeOverride: cli.home)
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem = item
        if let button = item.button {
            button.image = NSImage(systemSymbolName: "exclamationmark.circle", accessibilityDescription: APP_NAME)
            button.image?.isTemplate = true
            button.toolTip = APP_NAME
        }
        item.menu = menu
        rebuildMenu()
        refresh()
        let t = Timer(timeInterval: POLL_INTERVAL_SEC, repeats: true) { [weak self] _ in self?.refresh() }
        RunLoop.main.add(t, forMode: .common)
        pollTimer = t
    }

    func refresh() {
        let cfg = resolved!
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let snap = snapshot(port: cfg.port)
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.current = snap
                self.rebuildMenu()
            }
        }
    }

    func rebuildMenu() {
        let cfg = resolved ?? loadResolvedConfig(configPathOverride: nil, portOverride: nil, homeOverride: nil)
        let items = buildMenuModel(snap: current, config: cfg, autostartInstalled: isAutostartInstalled())
        menu.removeAllItems()
        let separatorBefore: Set<String> = ["open-timeline", "ai-tools", "open-data", "autostart"]
        for model in items {
            if separatorBefore.contains(model.id) { menu.addItem(.separator()) }
            let mi = NSMenuItem(title: model.label, action: selector(for: model.id), keyEquivalent: "")
            mi.target = self
            mi.isEnabled = model.enabled
            mi.representedObject = model.id
            if let checked = model.checked { mi.state = checked ? .on : .off }
            menu.addItem(mi)
        }
        if let button = statusItem?.button {
            // 优先用 App 自己的彩色图标（bundle 内 AppIcon.icns），没有则回退 SF Symbol 模板图标
            if let iconPath = Bundle.main.path(forResource: "AppIcon", ofType: "icns"),
               let img = NSImage(contentsOfFile: iconPath) {
                img.size = NSSize(width: 18, height: 18)
                img.isTemplate = false
                button.image = img
            } else {
                let img = NSImage(systemSymbolName: current.iconName, accessibilityDescription: current.statusLabel(configMissing: cfg.missing))
                img?.isTemplate = true
                button.image = img
            }
            button.toolTip = current.statusLabel(configMissing: cfg.missing)
        }
    }

    func selector(for id: String) -> Selector? {
        switch id {
        case "permission-accessibility": return #selector(actPermissionAccessibility)
        case "permission-screen": return #selector(actPermissionScreen)
        case "open-timeline": return #selector(actOpenTimeline)
        case "open-model": return #selector(actOpenModel)
        case "pause-15": return #selector(actPause15)
        case "pause-60": return #selector(actPause60)
        case "pause-forever": return #selector(actPauseForever)
        case "resume": return #selector(actResume)
        case "ai-tools": return #selector(actAITools)
        case "copy-mcp": return #selector(actCopyMCP)
        case "open-data": return #selector(actOpenData)
        case "open-logs": return #selector(actOpenLogs)
        case "autostart": return #selector(actToggleAutostart)
        case "quit": return #selector(actQuit)
        default: return nil
        }
    }

    func openURL(_ urlString: String, fallbackPath: String? = nil) {
        if let url = URL(string: urlString), NSWorkspace.shared.open(url) { return }
        if let path = fallbackPath, fileExists(path) {
            NSWorkspace.shared.open(URL(fileURLWithPath: path))
        }
    }

    func requestPermission(_ action: String) {
        let out = performAction(action, config: resolved)
        if (out["ok"] as? Bool) != true {
            showError("无法请求权限", (out["error"] as? String) ?? "请确认 Chronicle 服务在运行")
        }
        refresh()
    }

    @objc func actPermissionAccessibility() { requestPermission("permission-accessibility") }
    @objc func actPermissionScreen() { requestPermission("permission-screen") }

    @objc func actOpenTimeline() { openURL("http://127.0.0.1:\(resolved.port)/") }

    @objc func actOpenModel() { openURL("http://127.0.0.1:\(resolved.port)/?view=model") }

    func doPause(_ durationSec: Int?) {
        let _ = performAction(durationSec == nil ? "pause-forever" : (durationSec == 900 ? "pause15" : "pause60"), config: resolved)
        refresh()
    }

    @objc func actPause15() { doPause(900) }
    @objc func actPause60() { doPause(3600) }
    @objc func actPauseForever() { doPause(nil) }

    @objc func actResume() { let _ = performAction("resume", config: resolved); refresh() }

    @objc func actAITools() {
        let timeline = "http://127.0.0.1:\(resolved.port)/?view=ai"
        let install = "\(resolved.repoRoot)/INSTALL.md"
        openURL(timeline, fallbackPath: install)
    }

    @objc func actCopyMCP() {
        let mcp = buildMcpConfig(config: resolved)
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(mcp.text, forType: .string)
    }

    @objc func actOpenData() { NSWorkspace.shared.open(URL(fileURLWithPath: resolved.home)) }
    @objc func actOpenLogs() {
        let logs = "\(resolved.home)/logs"
        if !fileExists(logs) { try? FileManager.default.createDirectory(atPath: logs, withIntermediateDirectories: true) }
        NSWorkspace.shared.open(URL(fileURLWithPath: logs))
    }

    @objc func actToggleAutostart() {
        let plistPath = daemonLaunchAgentPath()
        let uid = getuid()
        let installed = fileExists(plistPath)
        if installed {
            let r = runProcess("/bin/launchctl", ["bootout", "gui/\(uid)/\(DAEMON_LAUNCHD_LABEL)"])
            if r.code != 0 { showError("关闭开机自启失败", r.stderr) }
        } else {
            var r = runProcess("/bin/launchctl", ["bootstrap", "gui/\(uid)", plistPath])
            if r.code != 0 { r = runProcess("/bin/launchctl", ["load", "-w", plistPath]) }
            if r.code != 0 { showError("开启开机自启失败", r.stderr) }
        }
        refresh()
    }

    func showError(_ title: String, _ detail: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail.trimmingCharacters(in: .whitespacesAndNewlines)
        alert.alertStyle = .warning
        alert.runModal()
    }

    @objc func actQuit() { NSApp.terminate(nil) }
}

// MARK: - main

let cli = parseCLI(Array(CommandLine.arguments.dropFirst()))

if cli.help {
    print("""
    用法: ChronicleMenuBar [--selftest] [--action <pause15|pause60|pause-forever|resume|copy-mcp|status|permission-accessibility|permission-screen|open-timeline|open-model|open-ai|open-data|open-logs>]
                           [--port N] [--config PATH] [--home DIR]
    """)
    exit(0)
}

let resolvedConfig = loadResolvedConfig(configPathOverride: cli.configPath, portOverride: cli.port, homeOverride: cli.home)

if cli.selftest {
    printJSON(selftestPayload(resolvedConfig), exitCode: 0)
}

if let action = cli.action {
    let result = performAction(action, config: resolvedConfig)
    let ok = (result["ok"] as? Bool) ?? false
    printJSON(result, exitCode: ok ? 0 : 1)
}

// 交互模式：真正的菜单栏 App
let app = NSApplication.shared
app.setActivationPolicy(.accessory) // 双保险：即便 plist 缺失也不出现 Dock 图标
let delegate = AppDelegate()
delegate.cli = cli
app.delegate = delegate
app.run()
