// swift/chronicle-daemon.swift — Chronicle 采集守护（单文件 Swift，行协议 JSON 服务）
//
// 产品红线（写进源码，代代相传）：
//   不截屏、不录音、不读屏幕像素。只记录结构化活动事件：
//   前台应用 / 窗口标题 / 浏览器当前标签 URL / 焦点元素角色与标题。
//   密码框（AXSecureTextField）内容永远不记录；隐私浏览无条件排除 URL。
//
// 由 setup.mjs 用 swiftc 编译为 host/chronicle-daemon，并安装进
// ~/.chronicle/Chronicle Helper.app（TCC 权限挂在这个 .app 上，终端是谁无关）。
//
// 协议（同 cua-helper 的行为协议模式）：stdin 每行一个 JSON 请求 {id, cmd, ...参数}；
// stdout 每行一个 JSON 响应 成功 {id, ok:true, ...数据} / 失败 {id, ok:false, error, code?}。
// 除协议行外不向 stdout 写任何内容；诊断一律 stderr。
//
// 命令集（与 daemon.mjs 调用侧一一对应）：
//   probe                            → {axGranted}（AXIsProcessTrusted）
//   start {configPath?}              → 开始观察（configPath 缺省用 <home>/config.json）
//   stop                             → 停止观察；{ok:true, stats:{totalEvents, durationMs}}
//   pause {durationSec?}             → 暂停（可选定时自动恢复）；{ok:true, pausedAt}
//   resume                           → 恢复；{ok:true, resumedAt}
//   status                           → {running, paused, segmentsDir, totalEvents,
//                                      currentSegment:{startTs,eventCount}|null,
//                                      config:{allowlist,blocklist,includeURLs,includeFocusedElement,enabled,paused}}
//   request-permissions              → AXIsProcessTrustedWithOptions(弹标准申请框)；{axGranted}
//   show-permission-card {durationSec?, kind?}  → 浮琥珀引导卡片（拖 .app 授权）；{shown}
//   hide-permission-card {kind?}     → 收卡片（幂等）
//
// 观察循环（start 后每 2 秒采样一次）：
//   NSWorkspace.frontmostApplication → {bundleId, appName, pid}
//   该 app 的聚焦窗口（AX）→ 标题
//   浏览器 → AppleScript/AX 读当前标签 URL（Chrome 系/Safari；无痕模式无条件排除）
//   AXFocusedUIElement → {role, title}（密码框跳过）
//   去重：bundleId+标题+URL+焦点全都没变 → 不产生事件
//
// 存储：<home>/segments/<UTC时间戳>/{events.jsonl, metadata.json, suppressed.jsonl}
//   每 10 分钟自动轮转新段；metadata.json = {segmentStart, segmentEnd?, eventCount}。
//   <home> 默认 ~/.chronicle，可用环境变量 CHRONICLE_HOME 覆盖（测试用）。
//
// 隐私闸门（block 永远赢）：
//   规则 {scope:"app"|"url", value:"glob"}；app 匹配 bundleId，url 匹配 URL/域名（不区分大小写）。
//   allowlist 非空时，不在 allow 内的一律不观察；命中 block 的一律不观察（即便同时命中 allow）。
//   被抑制的事件不写 events.jsonl，只写 suppressed.jsonl 的 {ts, type, scope}（不带内容）。
//
// 进程模型：NSApplication .accessory（无 Dock 图标）；主线程跑 run loop（引导卡片需要
// AppKit）；stdin 读取与观察循环在后台串行队列；stdin EOF / SIGTERM / SIGINT →
// 停观察 → 写完当前段 metadata → 退出。例外：引导卡片还在屏上时留守，卡片全数
// 收起（授权自动收卡/超时淡出/手动关闭）后再退。

import Cocoa
import Foundation

// MARK: - 常量

let PROTOCOL_VERSION = "1"
let SAMPLE_INTERVAL_SEC: TimeInterval = 2.0
let SEGMENT_LENGTH_MS: Double = 10 * 60 * 1000 // 10 分钟一段
let OSA_TIMEOUT_SEC: Double = 1.5
let CARD_POLL_SEC: TimeInterval = 1.2

/// Chrome 系浏览器：bundleId → AppleScript application id（active tab URL + 窗口 mode）。
let CHROME_FAMILY: [String: String] = [
    "com.google.chrome": "com.google.chrome",
    "com.google.chrome.canary": "com.google.chrome.canary",
    "com.microsoft.edgemac": "com.microsoft.edgemac",
    "com.brave.browser": "com.brave.browser",
    "com.operasoftware.Opera": "com.operasoftware.Opera",
    "com.vivaldi.Vivaldi": "com.vivaldi.Vivaldi",
    "company.thebrowser.Browser": "company.thebrowser.Browser", // Arc
]
let SAFARI_ID = "com.apple.Safari"
let FIREFOX_IDS: Set<String> = ["org.mozilla.firefox", "org.mozilla.firefoxdeveloperedition"]

let AMBER = NSColor(srgbRed: 245 / 255, green: 158 / 255, blue: 11 / 255, alpha: 1)

// MARK: - 工具

let isoFrac: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()
let isoPlain: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()

func isoNow() -> String { isoFrac.string(from: Date()) }

/// 段目录名：UTC 时间戳（紧凑、字典序即时间序）。注意秒是 ss（SS 是别的语义，踩过）。
func segmentDirName(_ date: Date) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone(identifier: "UTC")
    f.dateFormat = "yyyy-MM-dd'T'HH-mm-ss.SSS'Z'"
    return f.string(from: date)
}

func chronicleHome() -> URL {
    if let env = ProcessInfo.processInfo.environment["CHRONICLE_HOME"], !env.isEmpty {
        return URL(fileURLWithPath: (env as NSString).expandingTildeInPath)
    }
    return URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".chronicle")
}

/// glob 匹配：`*` 任意序列；不区分大小写。其余字符按字面。
/// 如 "com.1password.*"（前缀）、"*banking*"（包含）、"*://mail.example.com/*"（路径）。
func globMatch(_ pattern: String, _ text: String) -> Bool {
    guard pattern.contains("*") else { return pattern.caseInsensitiveCompare(text) == .orderedSame }
    let p = pattern.lowercased().split(separator: "*", omittingEmptySubsequences: false).map(String.init)
    let t = text.lowercased() as NSString
    var idx = 0
    for (i, part) in p.enumerated() {
        if part.isEmpty { continue } // 连续 ** 等价于单个 *
        let range = t.range(of: part, options: [], range: NSRange(location: idx, length: t.length - idx))
        guard range.location != NSNotFound else { return false }
        if i == 0, p[0] != "", range.location != 0 { return false } // 首个字面段必须锚定串头
        idx = range.location + range.length
    }
    if pattern.hasSuffix("*") { return true }
    return t.length - idx == 0 // 无 * 结尾：最后一个字面段必须贴到串尾
}

/// URL 规则匹配：命中完整 URL 或其 host 任一即算（子域/路径通配都靠 glob 表达）。
func urlRuleMatch(_ pattern: String, _ url: String) -> Bool {
    let u = url.lowercased()
    if globMatch(pattern, u) { return true }
    if let host = URL(string: u)?.host?.lowercased(), globMatch(pattern, host) { return true }
    return false
}

// MARK: - 配置与隐私规则

struct RulePair {
    var scope: String // "app" | "url"
    var value: String
}

struct ChronicleConfig {
    var enabled = true
    var allowlist: [RulePair] = []
    var blocklist: [RulePair] = []
    var includeURLs = true
    var includeFocusedElement = true

    static func load(path: URL?) -> ChronicleConfig {
        var cfg = ChronicleConfig()
        let url = path ?? chronicleHome().appendingPathComponent("config.json")
        guard let data = try? Data(contentsOf: url),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return cfg }
        if let b = obj["enabled"] as? Bool { cfg.enabled = b }
        if let b = obj["includeURLs"] as? Bool { cfg.includeURLs = b }
        if let b = obj["includeFocusedElement"] as? Bool { cfg.includeFocusedElement = b }
        cfg.allowlist = parseRules(obj["allowlist"])
        cfg.blocklist = parseRules(obj["blocklist"])
        return cfg
    }

    static func parseRules(_ any: Any?) -> [RulePair] {
        guard let arr = any as? [[String: Any]] else { return [] }
        return arr.compactMap { r in
            guard let scope = r["scope"] as? String, let value = r["value"] as? String else { return nil }
            return RulePair(scope: scope, value: value)
        }
    }

    /// JSON 形态（status 回传用）。
    func toJSON() -> [String: Any] {
        func rules(_ rs: [RulePair]) -> [[String: Any]] { rs.map { ["scope": $0.scope, "value": $0.value] } }
        return ["enabled": enabled,
                "allowlist": rules(allowlist),
                "blocklist": rules(blocklist),
                "includeURLs": includeURLs,
                "includeFocusedElement": includeFocusedElement]
    }

    /// 隐私闸门（block 永远赢；allowlist 非空时白名单外一律不观察）。
    /// - Returns: (observe, blockedScope)——blockedScope = "app"|"url"|nil
    func decision(bundleId: String, url: String?) -> (observe: Bool, blockedScope: String?) {
        let blockedApp = blocklist.contains { $0.scope == "app" && globMatch($0.value, bundleId) }
        if blockedApp { return (false, "app") }
        if let u = url, !u.isEmpty, blocklist.contains(where: { $0.scope == "url" && urlRuleMatch($0.value, u) }) {
            return (false, "url")
        }
        if !allowlist.isEmpty {
            let allowed = allowlist.contains { $0.scope == "app" && globMatch($0.value, bundleId) }
            if !allowed {
                if let u = url, !u.isEmpty, allowlist.contains(where: { $0.scope == "url" && urlRuleMatch($0.value, u) }) {
                    return (true, nil) // app 不在白名单但 URL 明确放行
                }
                return (false, "app")
            }
        }
        return (true, nil)
    }
}

// MARK: - AX 小工具

func axAttrString(_ el: AXUIElement?, _ attr: CFString) -> String? {
    guard let el = el else { return nil }
    var ref: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, attr, &ref) == .success, let val = ref else { return nil }
    if let s = val as? String { return s }
    if let arr = val as? [Any] {
        for x in arr { if let s = x as? String { return s } }
    }
    return nil
}

func axAttrElement(_ el: AXUIElement?, _ attr: CFString) -> AXUIElement? {
    guard let el = el else { return nil }
    var ref: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, attr, &ref) == .success, let val = ref else { return nil }
    return unsafeBitCast(val, to: AXUIElement.self)
}

func axAttrPID(_ el: AXUIElement?) -> Int? {
    guard let el = el else { return nil }
    var ref: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, "AX_PID" as CFString, &ref) == .success, let val = ref else { return nil }
    if let n = val as? NSNumber { return n.intValue }
    if let s = val as? String { return Int(s) }
    return nil
}

// MARK: - osascript 执行（读浏览器 URL；失败静默返回 nil）

func runOSA(_ script: String, timeout: Double = OSA_TIMEOUT_SEC) -> String? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    p.arguments = ["-"]
    let inPipe = Pipe()
    let outPipe = Pipe()
    p.standardInput = inPipe
    p.standardOutput = outPipe
    p.standardError = Pipe() // 丢弃错误（权限未授予/浏览器不支持都走这里）
    var finished = false
    let killer = DispatchWorkItem { if !finished { p.terminate() } }
    DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: killer)
    do {
        try p.run()
        if let data = script.data(using: .utf8) {
            inPipe.fileHandleForWriting.write(data)
        }
        inPipe.fileHandleForWriting.closeFile()
        p.waitUntilExit()
        finished = true
        killer.cancel()
        guard p.terminationStatus == 0 else { return nil }
        let data = outPipe.fileHandleForReading.readDataToEndOfFile()
        let s = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return s.isEmpty ? nil : s
    } catch {
        finished = true
        killer.cancel()
        return nil
    }
}

// MARK: - 段（segment）

final class Segment {
    let dir: URL
    let startTs: String
    private let eventsHandle: FileHandle
    private let suppressedHandle: FileHandle
    private(set) var eventCount: Int = 0
    private(set) var suppressedCount: Int = 0

    init(root: URL) throws {
        let now = Date()
        startTs = isoNow()
        dir = root.appendingPathComponent(segmentDirName(now))
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let evPath = dir.appendingPathComponent("events.jsonl")
        let supPath = dir.appendingPathComponent("suppressed.jsonl")
        FileManager.default.createFile(atPath: evPath.path, contents: nil)
        FileManager.default.createFile(atPath: supPath.path, contents: nil)
        eventsHandle = try FileHandle(forWritingTo: evPath)
        suppressedHandle = try FileHandle(forWritingTo: supPath)
        eventsHandle.seekToEndOfFile()
        suppressedHandle.seekToEndOfFile()
        writeMetadata(end: nil)
    }

    var ageMs: Double {
        let start = isoFrac.date(from: startTs) ?? Date()
        return Date().timeIntervalSince(start) * 1000
    }

    private func metadata(end: String?) -> [String: Any] {
        var m: [String: Any] = ["segmentStart": startTs, "eventCount": eventCount]
        if let e = end { m["segmentEnd"] = e }
        return m
    }

    func writeMetadata(end: String?) {
        let url = dir.appendingPathComponent("metadata.json")
        if let data = try? JSONSerialization.data(withJSONObject: metadata(end: end), options: [.sortedKeys]) {
            try? data.write(to: url)
        }
    }

    private func append(_ handle: FileHandle, obj: [String: Any]) {
        var line = obj
        if line["ts"] == nil { line["ts"] = isoNow() }
        guard let data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]) else { return }
        var d = data
        d.append(0x0A)
        handle.write(d)
    }

    func appendEvent(_ type: String, data: [String: Any]) {
        var obj: [String: Any] = ["type": type, "data": data]
        obj["tsMs"] = Int(Date().timeIntervalSince1970 * 1000)
        append(eventsHandle, obj: obj)
        eventCount += 1
        writeMetadata(end: nil)
    }

    /// 抑制事件：只记 type+ts+scope，不带任何内容。
    func appendSuppressed(_ type: String, scope: String) {
        append(suppressedHandle, obj: ["type": type, "scope": scope])
        suppressedCount += 1
    }

    func close() {
        writeMetadata(end: isoNow())
        try? eventsHandle.close()
        try? suppressedHandle.close()
    }
}

// MARK: - 权限引导卡片（NSPanel：暗底 + 琥珀描边 + 左侧可拖 .app 图标）

final class PermissionCardController: NSObject, NSWindowDelegate {
    private(set) var panels: [String: NSPanel] = [:] // 访问限定在主线程
    private var pollTimer: Timer?
    var onAllHidden: (() -> Void)?

    /// 拖拽句柄：按住拖出的就是守护所在的 .app（TCC 记账主体）。
    final class DragIconView: NSView, NSDraggingSource {
        var appPath: String?
        private var icon: NSImage?

        override func mouseDown(with event: NSEvent) {
            guard let path = appPath else { return }
            let url = NSURL(fileURLWithPath: path)
            let item = NSDraggingItem(pasteboardWriter: url)
            let f = NSRect(x: 0, y: 0, width: bounds.width, height: bounds.height)
            item.draggingFrame = f
            let img = NSWorkspace.shared.icon(forFile: path)
            img.size = NSSize(width: 48, height: 48)
            icon = img
            item.imageComponentsProvider = { [weak self] in
                let comp = NSDraggingImageComponent(key: NSDraggingItem.ImageComponentKey("icon"))
                comp.contents = self?.icon ?? img
                return [comp]
            }
            beginDraggingSession(with: [item], event: event, source: self)
        }

        func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation { .copy }
        func draggingSession(_ session: NSDraggingSession, willBeginAt screenPoint: NSPoint) {}
        func draggingSession(_ session: NSDraggingSession, movedTo screenPoint: NSPoint) {}
        func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {}
    }

    private func cardText(kind: String) -> (title: String, body: String) {
        let name = "Chronicle Helper"
        if kind == "screen" {
            return ("Chronicle 需要屏幕录制权限",
                    "系统设置 → 隐私与安全性 → 屏幕录制：把左侧「\(name)」加进列表并勾选")
        }
        return ("Chronicle 需要辅助功能权限",
                "系统设置 → 隐私与安全性 → 辅助功能：把左侧「\(name)」图标拖进列表即可（授权后本卡片自动消失）")
    }

    /// 可拖的 .app 路径：从 .app 内运行才有；裸 CLI 时回 nil（纯文字引导）。
    private var draggableAppPath: String? {
        let bundle = Bundle.main
        if bundle.bundleIdentifier != nil, bundle.bundlePath.hasSuffix(".app") { return bundle.bundlePath }
        return nil
    }

    func show(kind: String = "accessibility", durationSec: Int = 120) {
        let text = cardText(kind: kind)
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 560, height: 112),
                            styleMask: [.borderless, .nonactivatingPanel],
                            backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.delegate = self

        let content = NSView(frame: NSRect(x: 0, y: 0, width: 560, height: 112))
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor(white: 0.12, alpha: 0.97).cgColor
        content.layer?.borderColor = AMBER.cgColor
        content.layer?.borderWidth = 1.5
        content.layer?.cornerRadius = 12

        let title = NSTextField(labelWithString: text.title)
        title.font = .systemFont(ofSize: 13, weight: .semibold)
        title.textColor = .white
        let body = NSTextField(labelWithString: text.body)
        body.font = .systemFont(ofSize: 11)
        body.textColor = NSColor.white.withAlphaComponent(0.72)
        body.lineBreakMode = .byWordWrapping
        body.maximumNumberOfLines = 2
        body.preferredMaxLayoutWidth = 400

        content.addSubview(title)
        content.addSubview(body)
        title.translatesAutoresizingMaskIntoConstraints = false
        body.translatesAutoresizingMaskIntoConstraints = false

        if let appPath = draggableAppPath {
            let drag = DragIconView(frame: NSRect(x: 16, y: 24, width: 64, height: 64))
            drag.appPath = appPath
            drag.wantsLayer = true
            drag.layer?.backgroundColor = AMBER.withAlphaComponent(0.9).cgColor
            drag.layer?.cornerRadius = 10
            let glyph = NSTextField(labelWithString: "C")
            glyph.font = .systemFont(ofSize: 30, weight: .bold)
            glyph.textColor = NSColor(white: 0.12, alpha: 1)
            glyph.alignment = .center
            glyph.frame = NSRect(x: 0, y: 18, width: 64, height: 32)
            drag.addSubview(glyph)
            content.addSubview(drag)
            NSLayoutConstraint.activate([
                title.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 96),
                title.topAnchor.constraint(equalTo: content.topAnchor, constant: 22),
                body.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 96),
                body.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 8),
                body.trailingAnchor.constraint(lessThanOrEqualTo: content.trailingAnchor, constant: -48),
            ])
        } else {
            NSLayoutConstraint.activate([
                title.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
                title.topAnchor.constraint(equalTo: content.topAnchor, constant: 22),
                body.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
                body.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 8),
                body.trailingAnchor.constraint(lessThanOrEqualTo: content.trailingAnchor, constant: -20),
            ])
        }

        let close = NSButton(title: "✕", target: self, action: #selector(closeClicked(_:)))
        close.isBordered = false
        close.font = .systemFont(ofSize: 12)
        close.contentTintColor = NSColor.white.withAlphaComponent(0.6)
        content.addSubview(close)
        close.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            close.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -10),
            close.topAnchor.constraint(equalTo: content.topAnchor, constant: 8),
            close.widthAnchor.constraint(equalToConstant: 24),
            close.heightAnchor.constraint(equalToConstant: 24),
        ])

        panel.contentView = content
        // 顶部居中（主屏可见区域上沿下方 16pt）
        if let vis = NSScreen.main?.visibleFrame {
            let x = vis.midX - 280
            let y = vis.maxY - 112 - 16
            panel.setFrameOrigin(NSPoint(x: x, y: y))
        }
        panels[kind] = panel
        panel.orderFrontRegardless()
        startPolling()
        DispatchQueue.main.asyncAfter(deadline: .now() + Double(min(max(durationSec, 5), 600))) { [weak self] in
            self?.hide(kind: kind)
        }
    }

    @objc private func closeClicked(_ sender: NSButton) {
        // 找到按钮所在的卡片 kind
        if let kind = panels.first(where: { $0.value.contentView === sender.superview })?.key {
            hide(kind: kind)
        }
    }

    func hide(kind: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard let panel = self.panels[kind] else { return }
            panel.orderOut(nil)
            self.panels.removeValue(forKey: kind)
            if self.panels.isEmpty {
                self.pollTimer?.invalidate()
                self.pollTimer = nil
                self.onAllHidden?()
            }
        }
    }

    func hideAll() { for k in Array(panels.keys) { hide(kind: k) } }

    /// 1.2s 轮询：授权生效自动收卡（对 AX 卡片生效；screen 卡片同样受益于轮询清理）。
    private func startPolling() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.pollTimer == nil else { return }
            self.pollTimer = Timer.scheduledTimer(withTimeInterval: CARD_POLL_SEC, repeats: true) { [weak self] _ in
                guard let self = self else { return }
                if AXIsProcessTrusted() {
                    self.hideAll()
                }
            }
        }
    }
}

// MARK: - 守护主体

final class Daemon {
    let stateQueue = DispatchQueue(label: "chronicle.state")
    private let outputLock = NSLock()

    // 运行状态
    private var running = false
    private var paused = false
    private var pausedAt: String?
    private var observationStartMs: Double = 0
    private var sessionTotalEvents = 0
    private var lifetimeTotalEvents = 0
    private var config = ChronicleConfig()
    private var segment: Segment?
    private var pauseAutoResumeWork: DispatchWorkItem?

    // 去重状态（连续采样相同 → 不产生事件）
    private var lastBundleId = ""
    private var lastWindowTitle = ""
    private var lastURL = ""
    private var lastFocusKey = ""
    private var lastSuppressedKey = ""

    private var sampleTimer: DispatchSourceTimer?
    private var signalSource: DispatchSourceRead? // 必须强持有：局部变量释放即取消
    private var stdinClosed = false
    private var exited = false
    let cards = PermissionCardController()

    // MARK: 协议 IO

    func respond(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return }
        var d = data
        d.append(0x0A)
        outputLock.lock()
        FileHandle.standardOutput.write(d)
        outputLock.unlock()
    }

    func respond(id: Int, ok: Bool, extra: [String: Any] = [:], error: String? = nil, code: String? = nil) {
        var obj: [String: Any] = ["id": id, "ok": ok]
        if let e = error { obj["error"] = e }
        if let c = code { obj["code"] = c }
        for (k, v) in extra { obj[k] = v }
        respond(obj)
    }

    func startStdin() {
        FileHandle.standardInput.readabilityHandler = { [weak self] h in
            let chunk = h.availableData
            guard let self = self else { return }
            if chunk.isEmpty {
                self.stateQueue.async { self.handleEOF() }
                return
            }
            RawStdin.shared.append(chunk) // 行缓冲在 handler 队列内完成
            while let line = RawStdin.shared.nextLine() {
                guard let data = line.data(using: .utf8),
                      let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                    continue // 坏行丢弃（协议要求单行 JSON）
                }
                guard let id = (obj["id"] as? Int) ?? Int(obj["id"] as? String ?? "") else { continue }
                let cmd = obj["cmd"] as? String ?? ""
                self.stateQueue.async { self.handle(id: id, cmd: cmd, params: obj) }
            }
        }
    }

    /// 信号 → 自管道（self-pipe）→ 读源（读源必须存进属性强持有，局部变量一释放
    /// 源就被取消，事件永远不触发——实测踩坑）。handler 内只做 write(2)，异步信号安全。
    func installSignalHandlers() {
        fds.withUnsafeMutableBufferPointer { buf in _ = pipe(buf.baseAddress) }
        gWriteFd = fds[1]
        signal(SIGTERM, chronoSignalHandler)
        signal(SIGINT, chronoSignalHandler)
        let src = DispatchSource.makeReadSource(fileDescriptor: fds[0], queue: stateQueue)
        src.setEventHandler { [weak self] in self?.handleEOF() }
        src.resume()
        signalSource = src
    }

    // MARK: 命令分发

    private func handle(id: Int, cmd: String, params: [String: Any]) {
        switch cmd {
        case "probe":
            respond(id: id, ok: true, extra: ["axGranted": AXIsProcessTrusted(),
                                              "protocol": PROTOCOL_VERSION])
        case "request-permissions":
            let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            let granted = AXIsProcessTrustedWithOptions(opts)
            respond(id: id, ok: true, extra: ["axGranted": granted])
        case "start":
            cmdStart(id: id, params: params)
        case "stop":
            cmdStop(id: id)
        case "pause":
            cmdPause(id: id, params: params)
        case "resume":
            cmdResume(id: id)
        case "status":
            cmdStatus(id: id)
        case "show-permission-card":
            let dur = (params["durationSec"] as? Int) ?? 120
            let kind = (params["kind"] as? String) ?? "accessibility"
            DispatchQueue.main.async { [weak self] in self?.cards.show(kind: kind, durationSec: dur) }
            respond(id: id, ok: true, extra: ["shown": true, "kind": kind])
        case "hide-permission-card":
            let kind = params["kind"] as? String
            if let k = kind { cards.hide(kind: k) } else { cards.hideAll() }
            respond(id: id, ok: true)
        default:
            respond(id: id, ok: false, error: "unknown-cmd: \(cmd)", code: "UNKNOWN_CMD")
        }
    }

    private func cmdStart(id: Int, params: [String: Any]) {
        if running {
            respond(id: id, ok: false, error: "already running", code: "ALREADY_RUNNING")
            return
        }
        let configPath: URL?
        if let p = params["configPath"] as? String, !p.isEmpty {
            configPath = URL(fileURLWithPath: (p as NSString).expandingTildeInPath)
        } else {
            configPath = nil
        }
        config = ChronicleConfig.load(path: configPath)
        guard config.enabled else {
            respond(id: id, ok: false, error: "config.enabled=false（配置文件里总开关已关闭）", code: "CONFIG_DISABLED")
            return
        }
        let home = chronicleHome()
        let segmentsRoot = home.appendingPathComponent("segments")
        try? FileManager.default.createDirectory(at: segmentsRoot, withIntermediateDirectories: true)
        do {
            segment = try Segment(root: segmentsRoot)
        } catch {
            respond(id: id, ok: false, error: "无法创建段目录: \(error.localizedDescription)", code: "SEGMENT_IO")
            return
        }
        running = true
        paused = false
        sessionTotalEvents = 0
        observationStartMs = Date().timeIntervalSince1970 * 1000
        lastBundleId = ""; lastWindowTitle = ""; lastURL = ""; lastFocusKey = ""; lastSuppressedKey = ""
        startSampler()
        respond(id: id, ok: true, extra: ["segmentsDir": segmentsRoot.path])
    }

    private func cmdStop(id: Int) {
        let stats = stopObservation()
        respond(id: id, ok: true, extra: ["stats": stats])
    }

    private func cmdPause(id: Int, params: [String: Any]) {
        guard running else {
            respond(id: id, ok: false, error: "not running", code: "NOT_RUNNING")
            return
        }
        paused = true
        pausedAt = isoNow()
        pauseAutoResumeWork?.cancel()
        if let dur = (params["durationSec"] as? Double) ?? (params["durationSec"] as? Int).map({ Double($0) }), dur > 0 {
            let w = DispatchWorkItem { [weak self] in
                guard let self = self else { return }
                self.stateQueue.async {
                    guard self.running, self.paused else { return }
                    self.paused = false
                    self.pausedAt = nil
                    self.respond(["event": "auto-resumed"])
                }
            }
            pauseAutoResumeWork = w
            stateQueue.asyncAfter(deadline: .now() + dur, execute: w)
        }
        respond(id: id, ok: true, extra: ["pausedAt": pausedAt!])
    }

    private func cmdResume(id: Int) {
        guard running else {
            respond(id: id, ok: false, error: "not running", code: "NOT_RUNNING")
            return
        }
        paused = false
        pausedAt = nil
        pauseAutoResumeWork?.cancel()
        respond(id: id, ok: true, extra: ["resumedAt": isoNow()])
    }

    private func cmdStatus(id: Int) {
        let home = chronicleHome()
        var cfgJSON = config.toJSON()
        cfgJSON["paused"] = paused
        var cur: Any = NSNull()
        if let seg = segment, running {
            cur = ["startTs": seg.startTs, "eventCount": seg.eventCount]
        }
        respond(id: id, ok: true, extra: [
            "running": running,
            "paused": paused,
            "segmentsDir": home.appendingPathComponent("segments").path,
            "totalEvents": lifetimeTotalEvents,
            "currentSegment": cur,
            "config": cfgJSON,
        ])
    }

    @discardableResult
    private func stopObservation() -> [String: Any] {
        sampleTimer?.cancel()
        sampleTimer = nil
        pauseAutoResumeWork?.cancel()
        pauseAutoResumeWork = nil
        let durationMs = running ? Int(Date().timeIntervalSince1970 * 1000 - observationStartMs) : 0
        segment?.close()
        segment = nil
        running = false
        paused = false
        pausedAt = nil
        let stats: [String: Any] = ["totalEvents": sessionTotalEvents, "durationMs": durationMs]
        return stats
    }

    // MARK: 观察循环

    private func startSampler() {
        let t = DispatchSource.makeTimerSource(queue: stateQueue)
        t.schedule(deadline: .now() + SAMPLE_INTERVAL_SEC, repeating: SAMPLE_INTERVAL_SEC)
        t.setEventHandler { [weak self] in self?.sampleOnce() }
        sampleTimer = t
        t.resume()
    }

    private func sampleOnce() {
        guard running, !paused, !exited else { return }
        guard let front = NSWorkspace.shared.frontmostApplication,
              let bundleId = front.bundleIdentifier, !bundleId.isEmpty else { return }
        let appName = front.localizedName ?? ""
        let pid = Int(front.processIdentifier)

        // 轮转检查：段满 10 分钟换新段（先于本采样的事件落盘）
        rotateIfDue()

        // ---- 隐私闸门（app 层）----
        let (observe, blockedScope) = config.decision(bundleId: bundleId, url: nil)
        if !observe, blockedScope == "app" {
            // 被抑制：连读都不读（标题/URL 一概不碰），只记状态转换，避免每 2s 重复记
            let key = "app:\(bundleId)"
            if key != lastSuppressedKey {
                segment?.appendSuppressed("sample", scope: "app")
                lastSuppressedKey = key
            }
            lastBundleId = bundleId
            lastWindowTitle = ""; lastURL = ""; lastFocusKey = ""
            return
        }

        var emitted = false

        // ---- app 切换 ----
        if bundleId != lastBundleId {
            segment?.appendEvent("app-switch", data: ["bundleId": bundleId, "appName": appName, "pid": pid])
            sessionTotalEvents += 1
            lifetimeTotalEvents += 1
            lastBundleId = bundleId
            lastWindowTitle = "" // 换 app 后窗口标题重新观察
            emitted = true
        }

        // ---- 窗口标题 ----
        var title = ""
        if pid > 0 {
            let appElem = AXUIElementCreateApplication(pid_t(pid))
            AXUIElementSetMessagingTimeout(appElem, 1.0)
            var win = axAttrElement(appElem, kAXFocusedWindowAttribute as CFString)
            if win == nil { win = axAttrElement(appElem, kAXMainWindowAttribute as CFString) }
            title = axAttrString(win, kAXTitleAttribute as CFString) ?? ""
        }
        if !title.isEmpty && title != lastWindowTitle {
            segment?.appendEvent("window-change", data: ["bundleId": bundleId, "windowTitle": title])
            sessionTotalEvents += 1
            lifetimeTotalEvents += 1
            lastWindowTitle = title
            emitted = true
        }

        // ---- 浏览器 URL（含无痕检测；无痕无条件排除）----
        if config.includeURLs, isBrowser(bundleId) {
            if let got = browserURL(bundleId: bundleId), !got.url.isEmpty {
                if got.incognito {
                    // 无痕模式：无条件排除（只记抑制转换，不记内容）
                    let key = "incognito:\(bundleId)"
                    if key != lastSuppressedKey {
                        segment?.appendSuppressed("url-change", scope: "url")
                        lastSuppressedKey = key
                    }
                    lastURL = ""
                } else {
                    // ---- 隐私闸门（url 层；block 永远赢）----
                    let (urlOK, urlScope) = config.decision(bundleId: bundleId, url: got.url)
                    if !urlOK {
                        let key = "url:\(got.url)"
                        if key != lastSuppressedKey {
                            segment?.appendSuppressed("url-change", scope: urlScope ?? "url")
                            lastSuppressedKey = key
                        }
                        lastURL = ""
                    } else if got.url != lastURL {
                        segment?.appendEvent("url-change", data: ["bundleId": bundleId, "url": got.url])
                        sessionTotalEvents += 1
                        lifetimeTotalEvents += 1
                        lastURL = got.url
                        emitted = true
                    }
                }
            } else {
                lastURL = "" // 读不到 URL（Firefox/无窗口）：清掉旧值，读到新值时能发事件
            }
        }

        // ---- 焦点元素（密码框内容永远不记录）----
        if config.includeFocusedElement {
            let sys = AXUIElementCreateSystemWide()
            AXUIElementSetMessagingTimeout(sys, 1.0)
            if let focused = axAttrElement(sys, kAXFocusedUIElementAttribute as CFString) {
                // 只记前台 app 自己的焦点元素（防系统弹窗串台）
                let fpid = axAttrPID(focused) ?? pid
                let role = axAttrString(focused, kAXRoleAttribute as CFString) ?? ""
                if fpid == pid, !role.isEmpty, role != "AXSecureTextField" {
                    let ftitle = axAttrString(focused, kAXTitleAttribute as CFString) ?? ""
                    let key = "\(role)|\(ftitle)"
                    if key != lastFocusKey {
                        var data: [String: Any] = ["bundleId": bundleId, "role": role]
                        if !ftitle.isEmpty { data["title"] = ftitle }
                        segment?.appendEvent("focus-change", data: data)
                        sessionTotalEvents += 1
                        lifetimeTotalEvents += 1
                        lastFocusKey = key
                        emitted = true
                    }
                } else if role == "AXSecureTextField" {
                    lastFocusKey = "" // 密码框期间不产生焦点事件
                }
            }
        }

        if emitted { lastSuppressedKey = "" } // 恢复观察后，下次再进被抑制上下文会重新记一条
    }

    private func rotateIfDue() {
        guard let seg = segment else { return }
        if seg.ageMs >= SEGMENT_LENGTH_MS {
            seg.close()
            let home = chronicleHome()
            let root = home.appendingPathComponent("segments")
            if let next = try? Segment(root: root) {
                segment = next
            }
        }
    }

    // MARK: 浏览器

    private func isBrowser(_ bundleId: String) -> Bool {
        let b = bundleId.lowercased()
        if CHROME_FAMILY.keys.contains(bundleId) { return true }
        if b == SAFARI_ID || FIREFOX_IDS.contains(bundleId) { return true }
        return b.contains("chrome") || b.contains("chromium") || b.contains("safari")
            || b.contains("firefox") || b.contains("edge") || b.contains("brave")
            || b.contains("vivaldi") || b.contains("opera")
    }

    /// 读当前标签 URL。Chrome 系走 AppleScript（顺带拿窗口 mode 检测无痕）；
    /// Safari 走 AppleScript；Firefox 无脚本接口 → nil（诚实降级，不猜）。
    private func browserURL(bundleId: String) -> (url: String, incognito: Bool)? {
        var out: String?
        var incognito = false
        if let asId = CHROME_FAMILY[bundleId] {
            let script = """
            tell application id "\(asId)"
                if (count of windows) = 0 then return ""
                set t to active tab of front window
                set u to URL of t
                try
                    set m to mode of front window
                on error
                    set m to "normal"
                end try
                return u & linefeed & m
            end tell
            """
            if let res = runOSA(script) {
                let parts = res.split(separator: "\n", maxSplits: 1).map(String.init)
                if let u = parts.first, !u.isEmpty, u != "missing value" {
                    out = u
                    incognito = parts.count > 1 && parts[1].lowercased().contains("incognito")
                }
            }
        } else if bundleId == SAFARI_ID {
            let script = """
            tell application id "\(SAFARI_ID)"
                if (count of documents) = 0 then return ""
                return URL of front document
            end tell
            """
            if let res = runOSA(script), !res.isEmpty, res != "missing value" {
                out = res
            }
        }
        // Firefox：无 AppleScript 标签接口；AX 地址栏不可稳定寻址 → 不读 URL（记录继续，URL 字段缺省）
        guard let u = out else { return nil }
        return (u, incognito)
    }

    // MARK: 退出

    func handleEOF() {
        guard !exited else { return }
        exited = true
        FileHandle.standardInput.readabilityHandler = nil
        if running { stopObservation() }
        // 卡片还在屏上 → 留守到全数收起再退（setup 非交互引导模式）
        let lingering = !cards.panels.isEmpty
        cards.onAllHidden = { [weak self] in
            guard let self = self, self.exited else { return }
            exit(0)
        }
        if !lingering {
            exit(0)
        } else {
            // 最长留守 10 分钟（卡片自身的 durationSec 封顶兜底之外的双保险）
            DispatchQueue.global().asyncAfter(deadline: .now() + 600) { exit(0) }
        }
    }
}

/// stdin 行缓冲。readabilityHandler 对同一句柄串行回调，无需额外加锁。
final class RawStdin {
    static let shared = RawStdin()
    private var buf = Data()
    func append(_ chunk: Data) { buf.append(chunk) }
    func nextLine() -> String? {
        guard let nlIndex = buf.firstIndex(of: 0x0A) else { return nil }
        var lineData = buf[buf.startIndex..<nlIndex]
        if lineData.last == 0x0D { lineData = lineData.dropLast() }
        buf = Data(buf[buf.index(after: nlIndex)...])
        return String(data: Data(lineData), encoding: .utf8)
    }
}

// MARK: - main

/// 信号自管道（全局变量供 C 信号 handler 读取——async-signal-safe）。
var gWriteFd: Int32 = -1
var fds: [Int32] = [0, 0]
func chronoSignalHandler(_ sig: Int32) {
    if gWriteFd >= 0 { write(gWriteFd, "s", 1) }
}

let daemon = Daemon()
daemon.installSignalHandlers()
daemon.startStdin()

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // 无 Dock 图标、无菜单栏的常驻后台
app.run()
