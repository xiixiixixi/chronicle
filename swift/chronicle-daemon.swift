// swift/chronicle-daemon.swift — Chronicle 采集守护（单文件 Swift，行协议 JSON 服务）
//
// 产品红线（写进源码，代代相传）：
//   不截屏、不录音、不读屏幕像素。只记录结构化活动事件：
//   前台应用 / 窗口标题 / 浏览器当前标签 URL / 焦点元素角色与标题。
//   密码框（AXSecureTextField）内容永远不记录；隐私浏览/无痕无条件排除内容事件。
//
// 由 setup.mjs 用 swiftc 编译为 host/chronicle-daemon，并安装进
// ~/.chronicle/Chronicle Helper.app（TCC 权限挂在这个 .app 上，终端是谁无关）。
//
// 协议（同 cua-helper 的行为协议模式）：stdin 每行一个 JSON 请求 {id, cmd, ...参数}；
// stdout 每行一个 JSON 响应 成功 {id, ok:true, ...数据} / 失败 {id, ok:false, error, code?}。
// 除协议行外不向 stdout 写任何内容；诊断一律 stderr。
//
// 命令集（与 daemon.mjs 调用侧一一对应）：
//   probe                            → {axGranted}（AXIsProcessTrusted）+ {secureInput}
//   start {configPath?}              → 开始观察（configPath 缺省用 <home>/config.json）
//   stop                             → 停止观察；{ok:true, stats:{totalEvents, durationMs}}
//   pause {durationSec?}             → 暂停（可选定时自动恢复）；{ok:true, pausedAt}
//   resume                           → 恢复；{ok:true, resumedAt}
//   status                           → {running, paused, segmentsDir, totalEvents,
//                                      currentSegment:{startTs,eventCount,suppressedEventCount}|null,
//                                      config:{allowlist,blocklist,includeURLs,includeFocusedElement,enabled,privacy,paused}}
//   decide {sample?, configPath?}    → 纯决策（无副作用、不落盘、不改运行状态）：
//                                      {observe, blockedScope, reason, redactedURL}
//   selftest {config?, configPath?}  → 内容采集自检（无副作用）：配置归一化 / AX 快照序列化与
//                                      上限 / diff / 文本输入截断 / 密码控件抑制（测试用）
//   request-permissions              → AXIsProcessTrustedWithOptions(弹标准申请框)；{axGranted}
//   request-screen-permissions       → CGRequestScreenCaptureAccess(弹屏幕录制申请框)；{screenGranted}
//   ocr-window                       → 按需截取前台单窗口做本地 Vision OCR（像素只在内存；返回文字并写入 visual-text 事件）
//   show-permission-card {durationSec?, kind?}  → 浮琥珀引导卡片（拖 .app 授权）；{shown}
//   hide-permission-card {kind?}     → 收卡片（幂等）
//
// 内容事件（R1，includeContent=true 且 AX 已授权时；否则严格退化为旧行为）：
//   window-change 增强（windowId/documentPath/url）、click（点击坐标+命中控件）、
//   shortcut（所有非文本按键：delete/return/方向键/tab/esc 等；键位+修饰键+目标控件）、
//   text-input（原文截断+目标控件，500ms 空闲 flush）、submit（无修饰键回车且有文本）、
//   selection（AXObserver 六类通知：文本/范围/选中项/bare target）、ax-snapshot（窗口 AX 树 full/diff，
//   depth≤16/node≤1200/单值≤160；窗口切换 full、文字变化 1.5s 节流 diff，文本区 value 预算 4000 字）、
//   scroll（滚轮聚合：2s 或 0.9s 空闲 flush，方向/delta/次数/时长）、
//   visible-windows（屏幕可见窗口清单：应用/标题(可选)/尺寸；浏览器与 blocklist 排除，30s 节流、内容变化才写）。
//   S2 质量：AX role 中文化（AXButton→按钮，原始 role 保留在 target.role_raw）、空标题不输出 "?"、
//   title/description/value firstNonEmpty、浏览器 AXWebArea 子树优先、浅树用 AXUIElementCopyAttributeValues 补；
//   text-input flush 读焦点 AXValue 更新 target.value，IME 合成结果进 text_composed；
//   快捷键 keyEquivalent 用 keyCode 映射（0→A/36→Return）避免 keycode-N。
//   data 统一带 bundleId/appName/pid/windowTitle(url?)；密码控件一律不读 value/文本。
//
// 观察循环（start 后每 2 秒采样一次；A 批次起改为「先读样本 → 统一决策 → 只在观察时写事件」）：
//   ① secure input（IsSecureEventInputEnabled，整机）→ 整采样抑制，不读任何内容
//   ② NSWorkspace.frontmostApplication → {bundleId, appName, pid}；app 层 block 命中 → 不读内容
//   ③ Safari + privacy.excludeSafariURLs → 不读内容
//   ④ 读浏览器当前标签 URL（Chrome 系/Safari；无痕检测；查询串不参与决策，匹配用原始 URL）
//   ⑤ ChronicleConfig.evaluate 统一决策（secure-input > app block > safari-exclude >
//      url block > incognito > allowlist > default-observe；block 永远赢）
//   ⑥ 只有 observe=true 才读窗口标题/焦点元素并写 events.jsonl；URL 落盘前按
//      privacy.redactURLQuery 脱敏（默认去掉 query/fragment）
//   ⑦ 被抑制的采样只写 suppressed.jsonl 的 {ts, type, scope, reason}（不带任何内容）；
//      只在抑制上下文切换时写一条，metadata.suppressedEventCount 同步维护
//   去重：bundleId+原始标题+原始 URL+焦点全都没变 → 不产生事件；段轮转后重新快照一次。
//
// 存储：<home>/segments/<UTC时间戳>/{events.jsonl, metadata.json, suppressed.jsonl}
//   每 10 分钟自动轮转一段（paused 期间到期段也会关闭）；段目录**懒创建**：首个事件或
//   首条抑制记录落盘时才建目录，关闭时 eventCount==0 且 suppressedEventCount==0 则删目录，
//   因此完全空闲（无前台 app/无记录）不会产生空段目录。
//   metadata.json = {segmentStart, segmentEnd?, eventCount, suppressedEventCount, closedBy?}。
//   <home> 默认 ~/.chronicle，可用环境变量 CHRONICLE_HOME 覆盖（测试用）。
//   内容采集上限：每段事件 ≤5000（超出丢弃）；click 80ms 同点去重；AX 权限缺失时只保留旧事件。
//
// 隐私闸门（block 永远赢）：
//   规则 {scope:"app"|"url", value:"glob"}；app 匹配 bundleId，url 匹配 URL/域名（不区分大小写）。
//   allowlist 非空时，不在 allow 内的一律不观察；命中 block 的一律不观察（即便同时命中 allow）。
//   secure input（整机安全输入）优先于一切规则；无痕无条件不观察内容；
//   Safari 无痕检测为启发式（见 browserSample 注释里的局限）。
//
// 仅测试用环境变量（默认不设置时生产行为不变：2s 采样 / 10min 段）：
//   CHRONICLE_SAMPLE_INTERVAL_MS        采样间隔（毫秒，默认 2000）
//   CHRONICLE_SEGMENT_MS                段时长（毫秒，默认 600000）
//   CHRONICLE_TEST_FORCE_SECURE_INPUT=1 强制视为 secure input（测试整机抑制路径）
//   CHRONICLE_TEST_FORCE_NO_AX=1        强制视为 AX 未授权（测试降级路径：只保留旧事件）
//
// 进程模型：NSApplication .accessory（无 Dock 图标）；主线程跑 run loop（引导卡片需要
// AppKit）；stdin 读取与观察循环在后台串行队列；stdin EOF / SIGTERM / SIGINT →
// 停观察 → 写完当前段 metadata → 退出。例外：引导卡片还在屏上时留守，卡片全数
// 收起（授权自动收卡/超时淡出/手动关闭）后再退。

import Cocoa
import Carbon // IsSecureEventInputEnabled（HIToolbox）
import Foundation
import ScreenCaptureKit
import Vision

// MARK: - 常量

let PROTOCOL_VERSION = "1"
let CARD_POLL_SEC: TimeInterval = 1.2

/// 仅测试用的 env 数值钩子：未设置/非法时返回默认值（生产默认 2s / 10min 不变）。
func envDouble(_ name: String, default fallback: Double, min: Double, max: Double) -> Double {
    guard let raw = ProcessInfo.processInfo.environment[name],
          let v = Double(raw.trimmingCharacters(in: .whitespaces)), v.isFinite,
          v >= min, v <= max else { return fallback }
    return v
}

let SAMPLE_INTERVAL_SEC: TimeInterval = envDouble("CHRONICLE_SAMPLE_INTERVAL_MS", default: 2000, min: 20, max: 120_000) / 1000.0
/// 内容采集常量（R1/S2）：段事件上限、文本空闲 flush、AX 快照节流与序列化上限。
let MAX_EVENTS_PER_SEGMENT = 5000
let TEXT_IDLE_FLUSH_SEC: TimeInterval = 0.5
/// 键盘鼠标空闲这么久算「人不在」（presence idle）。
let PRESENCE_IDLE_SEC: TimeInterval = 300
let AX_SNAPSHOT_MIN_INTERVAL_SEC: TimeInterval = 0.6
let AX_FORCE_SNAPSHOT_MIN_INTERVAL_SEC: TimeInterval = 0.3
let AX_MAX_DEPTH = 20
let AX_MAX_NODES = 3000
let AX_VALUE_MAX_CHARS = 500
/// 树太浅（节点 < 20，例如微信只有 6 节点）时用 AXUIElementCopyAttributeValues 补一次。
let AX_SHALLOW_TREE_NODES = 20
let AX_BULK_CHILD_LIMIT = 300
let AX_TARGET_VALUE_MAX_CHARS = 200
let CLICK_DEDUPE_SEC: TimeInterval = 0.08
let CLICK_DEDUPE_DISTANCE: Double = 3
/// 按下到抬起的位移超过该阈值记为 drag（否则仍算 click）。
let DRAG_MIN_DISTANCE: Double = 5
let CONTENT_CONTEXT_TTL_SEC: TimeInterval = 10
let SEGMENT_LENGTH_MS: Double = envDouble("CHRONICLE_SEGMENT_MS", default: 10 * 60 * 1000, min: 100, max: 24 * 60 * 60 * 1000)
let OSA_TIMEOUT_SEC: Double = 1.5

/// 辅助功能权限是否已授予；测试可用 CHRONICLE_TEST_FORCE_NO_AX=1 强制视为未授权（验证降级路径）。
func axTrusted() -> Bool {
    if ProcessInfo.processInfo.environment["CHRONICLE_TEST_FORCE_NO_AX"] == "1" { return false }
    return AXIsProcessTrusted()
}

/// secure input（整机安全输入）是否开启；测试可用 CHRONICLE_TEST_FORCE_SECURE_INPUT=1 强制。
func secureInputActive() -> Bool {
    let env = ProcessInfo.processInfo.environment
    if env["CHRONICLE_TEST_FORCE_SECURE_INPUT"] == "1" { return true }
    return IsSecureEventInputEnabled()
}

/// 无痕/隐私浏览关键词（Chrome 窗口 mode、Safari 启发式共用，小写比较）。
let PRIVATE_BROWSING_KEYWORDS: [String] = [
    "private browsing", "private window", "incognito", "inprivate",
    "无痕浏览", "无痕", "私密浏览", "隐私浏览",
]
func containsPrivateBrowsingKeyword(_ text: String) -> Bool {
    let t = text.lowercased()
    return PRIVATE_BROWSING_KEYWORDS.contains { t.contains($0) }
}


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

/// glob 匹配：`*` 任意序列；不区分大小写；其余字符按字面；整串锚定。
/// 如 "com.1password.*"（前缀）、"*banking*"（包含）、"*://mail.example.com/*"（路径）。
/// 用双指针回溯算法（按 Unicode scalar 比较，`*` 可匹配空串/换行），与 shared/privacy.mjs
/// 的 globMatch 逐字节等价——两处必须保持一致（test/privacy.test.mjs 有对拍）。
func globMatch(_ pattern: String, _ text: String) -> Bool {
    let p = Array(pattern.lowercased().unicodeScalars)
    let t = Array(text.lowercased().unicodeScalars)
    var pi = 0, ti = 0, star = -1, mark = 0
    while ti < t.count {
        if pi < p.count && p[pi] == t[ti] {
            pi += 1; ti += 1
        } else if pi < p.count && p[pi] == "*" {
            star = pi; pi += 1; mark = ti
        } else if star >= 0 {
            pi = star + 1; mark += 1; ti = mark
        } else {
            return false
        }
    }
    while pi < p.count && p[pi] == "*" { pi += 1 }
    return pi == p.count
}

/// URL 规则匹配：命中完整 URL 或其 host（不含端口）任一即算（子域/路径通配都靠 glob 表达）。
func urlRuleMatch(_ pattern: String, _ url: String) -> Bool {
    if globMatch(pattern, url) { return true }
    if let host = URL(string: url)?.host, !host.isEmpty, globMatch(pattern, host) { return true }
    return false
}

/// URL 落盘脱敏：截断第一个 `?` 或 `#` 之后的部分（保留 scheme+host+path）。
/// 与 shared/privacy.mjs redactURL 同语义（纯字符串截断，不做 URL 规范化，保证对拍一致）。
func redactURLString(_ url: String?) -> String? {
    guard let raw = url?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
    if let idx = raw.firstIndex(where: { $0 == "?" || $0 == "#" }) {
        let cut = String(raw[..<idx])
        return cut.isEmpty ? nil : cut
    }
    return raw
}

/// 窗口标题的“有意义”部分：去掉首尾空白和开头的状态符号（终端 spinner ◐/✳ 等）。
/// 只比较这部分，避免把 Claude Code 的 spinner 每次变化都记成窗口变化。
func significantWindowTitle(_ title: String) -> String {
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let start = trimmed.firstIndex(where: { $0.isLetter || $0.isNumber }) else { return "" }
    return String(trimmed[start...])
}

/// 是否应记一条 window-change：
/// - 有标题：标题有意义地变化，或窗口号变化；
/// - 无标题（弹层/工具窗）：只有焦点窗口元素换了才记，避免同一窗口标题一时读不到造成重复。
func windowChangeNeeded(title: String, previousTitle: String, windowId: String,
                        previousWindowId: String, elementChanged: Bool, hasWindow: Bool) -> Bool {
    guard hasWindow else { return false }
    if title.isEmpty { return elementChanged }
    let titleChanged = title != previousTitle
        && significantWindowTitle(title) != significantWindowTitle(previousTitle)
    return titleChanged || windowId != previousWindowId
}

/// 统计文件里非空行的数量（关闭段时与内存计数核对用；文件不存在返回 0）。
func lineCount(_ url: URL) -> Int {
    guard let data = try? Data(contentsOf: url),
          let text = String(data: data, encoding: .utf8) else { return 0 }
    return text.split(separator: "\n").reduce(into: 0) { acc, line in
        if !line.trimmingCharacters(in: .whitespaces).isEmpty { acc += 1 }
    }
}

// MARK: - 配置与隐私规则

struct RulePair {
    var scope: String // "app" | "url"
    var value: String
}

/// config.json 的 `privacy` 子段（缺省值与 shared/privacy.mjs privacySettings 一致）。
struct PrivacySettings {
    /// "heuristic"（默认，Safari 无痕启发式）| "off"（关闭启发式；不改变其他规则）。
    var safariPrivateDetection = "heuristic"
    /// 手动强制排除全部 Safari 内容（默认 false）。
    var excludeSafariURLs = false
    /// 落盘前去掉 URL 的 query/fragment（默认 true；规则匹配仍用原始 URL）。
    var redactURLQuery = true
}

/// 一次采样里参与决策的字段（内容字段只用于日志/对拍，决策只看 app/url/标志位）。
struct SampleInput {
    var bundleId: String = ""
    var url: String? = nil
    var title: String? = nil
    var focusRole: String? = nil
    var focusTitle: String? = nil
    var secureInput: Bool = false
    var incognito: Bool = false
}

/// 统一决策结果；reason 枚举与 shared/privacy.mjs evaluateSample 逐字对齐：
/// secure-input | app-blocklist | safari-url-excluded | url-blocklist | incognito |
/// allowlist-app | allowlist-url | not-in-allowlist | default-observe
struct PrivacyDecision {
    var observe: Bool
    var blockedScope: String? // "app" | "url" | "system" | nil
    var reason: String
    var redactedURL: String?
}

struct ChronicleConfig {
    var enabled = true
    var allowlist: [RulePair] = []
    var blocklist: [RulePair] = []
    var includeURLs = true
    var includeFocusedElement = true
    var privacy = PrivacySettings()
    // R1 内容采集（默认开启；旧 config 缺字段自动用默认值）
    var includeContent = true
    var contentMaxChars = 16384
    var diffMaxChars = 4096
    var inputTextMaxChars = 2000
    var selectionMaxChars = 300

    static func load(path: URL?) -> ChronicleConfig {
        let url = path ?? chronicleHome().appendingPathComponent("config.json")
        guard let data = try? Data(contentsOf: url),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return ChronicleConfig() }
        return ChronicleConfig.fromJSON(obj)
    }

    /// 从已解析 JSON 构建配置（load 与 selftest 共用；缺字段用默认、非法值归一化）。
    static func fromJSON(_ obj: [String: Any]) -> ChronicleConfig {
        var cfg = ChronicleConfig()
        if let b = obj["enabled"] as? Bool { cfg.enabled = b }
        if let b = obj["includeURLs"] as? Bool { cfg.includeURLs = b }
        if let b = obj["includeFocusedElement"] as? Bool { cfg.includeFocusedElement = b }
        cfg.allowlist = parseRules(obj["allowlist"])
        cfg.blocklist = parseRules(obj["blocklist"])
        if let b = obj["includeContent"] as? Bool { cfg.includeContent = b }
        cfg.contentMaxChars = clampInt(obj["contentMaxChars"], default: 16384, min: 256, max: 65536)
        cfg.diffMaxChars = clampInt(obj["diffMaxChars"], default: 4096, min: 256, max: 16384)
        cfg.inputTextMaxChars = clampInt(obj["inputTextMaxChars"], default: 2000, min: 32, max: 20000)
        cfg.selectionMaxChars = clampInt(obj["selectionMaxChars"], default: 300, min: 16, max: 10000)
        if let p = obj["privacy"] as? [String: Any] {
            // 非法值回落默认（与 shared/privacy.mjs privacySettings 同语义）。
            cfg.privacy.safariPrivateDetection = (p["safariPrivateDetection"] as? String) == "off" ? "off" : "heuristic"
            if let b = p["excludeSafariURLs"] as? Bool { cfg.privacy.excludeSafariURLs = b }
            if let b = p["redactURLQuery"] as? Bool { cfg.privacy.redactURLQuery = b }
        }
        return cfg
    }

    /// 整数字段归一化：非数字/非有限值回落默认；越界夹到边界（与 shared/privacy.mjs contentSettings 同边界）。
    static func clampInt(_ any: Any?, default fallback: Int, min: Int, max: Int) -> Int {
        var v: Int?
        if let n = any as? Int { v = n }
        else if let n = any as? NSNumber { v = n.intValue }
        else if let d = any as? Double, d.isFinite { v = Int(d) }
        else if let s = any as? String, let n = Int(s) { v = n }
        guard let raw = v else { return fallback }
        return Swift.min(Swift.max(raw, min), max)
    }

    /// 解析规则：只接受合法 scope 且 value 非空（与 shared/privacy.mjs parseRules 对齐；
    /// 用 [Any] 逐项过滤，避免数组里混入非对象时整份规则被丢弃）。
    static func parseRules(_ any: Any?) -> [RulePair] {
        guard let arr = any as? [Any] else { return [] }
        return arr.compactMap { item in
            guard let r = item as? [String: Any],
                  let scope = r["scope"] as? String,
                  scope == "app" || scope == "url",
                  let value = r["value"] as? String, !value.isEmpty else { return nil }
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
                "includeFocusedElement": includeFocusedElement,
                "includeContent": includeContent,
                "contentMaxChars": contentMaxChars,
                "diffMaxChars": diffMaxChars,
                "inputTextMaxChars": inputTextMaxChars,
                "selectionMaxChars": selectionMaxChars,
                "privacy": ["safariPrivateDetection": privacy.safariPrivateDetection,
                            "excludeSafariURLs": privacy.excludeSafariURLs,
                            "redactURLQuery": privacy.redactURLQuery]]
    }

    // MARK: 决策

    func isSafari(_ bundleId: String) -> Bool {
        bundleId.caseInsensitiveCompare(SAFARI_ID) == .orderedSame
    }

    func appBlocked(_ bundleId: String) -> Bool {
        blocklist.contains { $0.scope == "app" && globMatch($0.value, bundleId) }
    }

    func urlBlocked(_ url: String) -> Bool {
        blocklist.contains { $0.scope == "url" && urlRuleMatch($0.value, url) }
    }

    func appAllowed(_ bundleId: String) -> Bool {
        allowlist.contains { $0.scope == "app" && globMatch($0.value, bundleId) }
    }

    func urlAllowed(_ url: String) -> Bool {
        allowlist.contains { $0.scope == "url" && urlRuleMatch($0.value, url) }
    }

    /// 落盘用的 URL（按 privacy.redactURLQuery 脱敏）；空 URL → nil。
    func storedURL(_ raw: String?) -> String? {
        guard let raw = raw, !raw.isEmpty else { return nil }
        return privacy.redactURLQuery ? redactURLString(raw) : (raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : raw.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// 统一隐私闸门（权威实现；collection 端每次采样先决策、只在 observe 时写内容事件）。
    /// 顺序：secure input > app block > safari-exclude > url block > incognito > allowlist > 默认观察。
    func evaluate(_ sample: SampleInput) -> PrivacyDecision {
        if sample.secureInput {
            return PrivacyDecision(observe: false, blockedScope: "system", reason: "secure-input", redactedURL: nil)
        }
        if appBlocked(sample.bundleId) {
            return PrivacyDecision(observe: false, blockedScope: "app", reason: "app-blocklist", redactedURL: nil)
        }
        if isSafari(sample.bundleId), privacy.excludeSafariURLs {
            return PrivacyDecision(observe: false, blockedScope: "url", reason: "safari-url-excluded", redactedURL: nil)
        }
        if let u = sample.url, !u.isEmpty, urlBlocked(u) {
            return PrivacyDecision(observe: false, blockedScope: "url", reason: "url-blocklist", redactedURL: nil)
        }
        if sample.incognito {
            return PrivacyDecision(observe: false, blockedScope: "url", reason: "incognito", redactedURL: nil)
        }
        if !allowlist.isEmpty {
            if appAllowed(sample.bundleId) {
                return PrivacyDecision(observe: true, blockedScope: nil, reason: "allowlist-app", redactedURL: storedURL(sample.url))
            }
            if let u = sample.url, !u.isEmpty, urlAllowed(u) {
                return PrivacyDecision(observe: true, blockedScope: nil, reason: "allowlist-url", redactedURL: storedURL(sample.url))
            }
            return PrivacyDecision(observe: false, blockedScope: "app", reason: "not-in-allowlist", redactedURL: nil)
        }
        return PrivacyDecision(observe: true, blockedScope: nil, reason: "default-observe", redactedURL: storedURL(sample.url))
    }

    /// 旧版 app/url 双层闸门的单次调用形态（保留供内部/旧约定使用，等价 evaluate 的子集判断）。
    func decision(bundleId: String, url: String?) -> (observe: Bool, blockedScope: String?) {
        let d = evaluate(SampleInput(bundleId: bundleId, url: url))
        return (d.observe, d.blockedScope)
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

/// AXSelectedTextRange → (location, length)；非 AXValue/cfRange 返回 nil。
func axSelectedRange(_ el: AXUIElement?) -> (location: Int, length: Int)? {
    guard let el = el else { return nil }
    var ref: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, "AXSelectedTextRange" as CFString, &ref) == .success,
          let val = ref, CFGetTypeID(val) == AXValueGetTypeID() else { return nil }
    var range = CFRange()
    guard AXValueGetValue(unsafeBitCast(val, to: AXValue.self), .cfRange, &range) else { return nil }
    return (range.location, range.length)
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

/// 一个 10 分钟段。**目录懒创建**：对象创建只记 startTs，首个事件/抑制记录落盘时才建目录；
/// close 时 eventCount==0 且 suppressedEventCount==0 则删目录——完全空闲不产生空段目录。
/// metadata.json = {segmentStart, segmentEnd?, eventCount, suppressedEventCount, closedBy?}。
final class Segment {
    let root: URL
    let startTs: String
    let dir: URL
    let startedAt: Date
    private var eventsHandle: FileHandle?
    private var suppressedHandle: FileHandle?
    private(set) var eventCount: Int = 0
    private(set) var suppressedEventCount: Int = 0
    private(set) var materialized = false

    init(root: URL) {
        self.root = root
        let now = Date()
        self.startedAt = now
        self.startTs = isoFrac.string(from: now)
        self.dir = root.appendingPathComponent(segmentDirName(now))
    }

    var ageMs: Double { Date().timeIntervalSince(startedAt) * 1000 }

    private var eventsURL: URL { dir.appendingPathComponent("events.jsonl") }
    private var suppressedURL: URL { dir.appendingPathComponent("suppressed.jsonl") }
    private var metadataURL: URL { dir.appendingPathComponent("metadata.json") }

    private func metadata(end: String?, closedBy: String?) -> [String: Any] {
        var m: [String: Any] = ["segmentStart": startTs,
                                "eventCount": eventCount,
                                "suppressedEventCount": suppressedEventCount,
                                "ownerPid": Int(ProcessInfo.processInfo.processIdentifier)]
        if let e = end { m["segmentEnd"] = e }
        if let c = closedBy { m["closedBy"] = c }
        return m
    }

    func writeMetadata(end: String?, closedBy: String? = nil) {
        guard materialized else { return }
        if let data = try? JSONSerialization.data(withJSONObject: metadata(end: end, closedBy: closedBy), options: [.sortedKeys]) {
            try? data.write(to: metadataURL, options: .atomic)
        }
    }

    /// 懒物化：首次落盘才建目录与文件句柄。
    @discardableResult
    private func ensureMaterialized() -> Bool {
        if materialized { return true }
        do {
            let fm = FileManager.default
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            fm.createFile(atPath: eventsURL.path, contents: nil)
            fm.createFile(atPath: suppressedURL.path, contents: nil)
            eventsHandle = try FileHandle(forWritingTo: eventsURL)
            suppressedHandle = try FileHandle(forWritingTo: suppressedURL)
            eventsHandle?.seekToEndOfFile()
            suppressedHandle?.seekToEndOfFile()
            materialized = true
            writeMetadata(end: nil)
            return true
        } catch {
            FileHandle.standardError.write(Data("chronicle-daemon: 段目录创建失败 \(dir.path): \(error.localizedDescription)\n".utf8))
            return false
        }
    }

    private func append(_ handle: FileHandle?, obj: [String: Any]) {
        guard let handle = handle else { return }
        var line = obj
        if line["ts"] == nil { line["ts"] = isoNow() }
        guard let data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]) else { return }
        var d = data
        d.append(0x0A)
        handle.write(d)
    }

    /// 追加事件；段内事件达到 MAX_EVENTS_PER_SEGMENT(5000) 后丢弃并返回 false。
    /// at 用于延迟分类的事件（如 Return 的 submit/shortcut）：ts/tsMs 记录按键发生时刻，
    /// 避免 250ms 复查把事件排到后续按键之后。
    @discardableResult
    func appendEvent(_ type: String, data: [String: Any], at date: Date = Date()) -> Bool {
        guard eventCount < MAX_EVENTS_PER_SEGMENT else { return false }
        guard ensureMaterialized() else { return false }
        var obj: [String: Any] = ["type": type, "data": data]
        obj["ts"] = isoFrac.string(from: date)
        obj["tsMs"] = Int(date.timeIntervalSince1970 * 1000)
        append(eventsHandle, obj: obj)
        eventCount += 1
        writeMetadata(end: nil)
        return true
    }

    /// 抑制记录：只记 {ts, type, scope, reason}，不带任何内容。
    func appendSuppressed(_ type: String, scope: String, reason: String) {
        guard ensureMaterialized() else { return }
        append(suppressedHandle, obj: ["type": type, "scope": scope, "reason": reason])
        suppressedEventCount += 1
        writeMetadata(end: nil)
    }

    /// 关闭段：与文件行数核对（写半行/丢行不会让计数漂移），空段删目录。
    func close() {
        guard materialized else { return }
        eventCount = lineCount(eventsURL)
        suppressedEventCount = lineCount(suppressedURL)
        try? eventsHandle?.close()
        try? suppressedHandle?.close()
        eventsHandle = nil
        suppressedHandle = nil
        if eventCount == 0 && suppressedEventCount == 0 {
            try? FileManager.default.removeItem(at: dir)
            materialized = false
            return
        }
        writeMetadata(end: isoNow())
    }
}

// MARK: - 孤儿段修复

/// 解析段目录名（yyyy-MM-dd'T'HH-mm-ss.SSS'Z'）→ Date；失败返回 nil。
func parseSegmentDirDate(_ name: String) -> Date? {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone(identifier: "UTC")
    f.dateFormat = "yyyy-MM-dd'T'HH-mm-ss.SSS'Z'"
    return f.date(from: name)
}

/// 文件最后一条 JSON 记录里的 "ts"（倒序扫描，坏行跳过）；没有则 nil。
func lastRecordTimestamp(_ url: URL) -> String? {
    guard let data = try? Data(contentsOf: url),
          let text = String(data: data, encoding: .utf8) else { return nil }
    let lines = text.split(separator: "\n", omittingEmptySubsequences: true)
    for line in lines.reversed() {
        guard let d = line.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { continue }
        if let ts = obj["ts"] as? String, !ts.isEmpty { return ts }
    }
    return nil
}

/// 文件 mtime（ISO8601 毫秒）；不存在返回 nil。
func fileModificationISO(_ url: URL) -> String? {
    guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
          let date = attrs[.modificationDate] as? Date else { return nil }
    return isoFrac.string(from: date)
}

/// 修复孤儿段：扫描 segments 根下所有无 segmentEnd 的段目录。
/// - 空段（无任何事件/抑制行）→ 删除目录；
/// - 非空段 → 用「最后事件 ts → 文件 mtime → 目录名时间」补 segmentEnd，写 closedBy="repair"。
/// 返回 (repair 数, 删除数)；单段失败只影响该段并记录 stderr。
@discardableResult
func repairOrphanSegments(at root: URL) -> (repaired: Int, removed: Int) {
    var repaired = 0
    var removed = 0
    let fm = FileManager.default
    guard let entries = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isDirectoryKey], options: []) else {
        return (0, 0)
    }
    for dir in entries {
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: dir.path, isDirectory: &isDir), isDir.boolValue else { continue }
        let metaURL = dir.appendingPathComponent("metadata.json")
        var meta: [String: Any] = [:]
        if let data = try? Data(contentsOf: metaURL),
           let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            meta = obj
        }
        if let end = meta["segmentEnd"] as? String, !end.isEmpty { continue } // 已关闭
        // 多实例安全：若该段记录了仍存活的 ownerPid（另一个 daemon 正在写），不要"修复"破坏它。
        if let owner = meta["ownerPid"] as? Int, owner > 0,
           owner != Int(ProcessInfo.processInfo.processIdentifier),
           kill(pid_t(owner), 0) == 0 {
            continue
        }
        let eventsURL = dir.appendingPathComponent("events.jsonl")
        let suppressedURL = dir.appendingPathComponent("suppressed.jsonl")
        let evCount = lineCount(eventsURL)
        let supCount = lineCount(suppressedURL)
        if evCount == 0 && supCount == 0 {
            if (try? fm.removeItem(at: dir)) != nil { removed += 1 }
            continue
        }
        let dirDate = parseSegmentDirDate(dir.lastPathComponent)
        let startTs = (meta["segmentStart"] as? String)
            ?? dirDate.map { isoFrac.string(from: $0) }
            ?? fileModificationISO(metaURL)
            ?? isoNow()
        let endTs = lastRecordTimestamp(eventsURL)
            ?? lastRecordTimestamp(suppressedURL)
            ?? fileModificationISO(eventsURL)
            ?? fileModificationISO(suppressedURL)
            ?? fileModificationISO(metaURL)
            ?? startTs
        let repairedMeta: [String: Any] = ["segmentStart": startTs,
                                           "segmentEnd": endTs,
                                           "eventCount": evCount,
                                           "suppressedEventCount": supCount,
                                           "closedBy": "repair"]
        if let data = try? JSONSerialization.data(withJSONObject: repairedMeta, options: [.sortedKeys]),
           (try? data.write(to: metaURL, options: .atomic)) != nil {
            repaired += 1
        } else {
            FileHandle.standardError.write(Data("chronicle-daemon: 孤儿段修复失败 \(dir.path)\n".utf8))
        }
    }
    return (repaired, removed)
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
            drag.layer?.cornerRadius = 10
            // 优先显示真实 App 图标（安装时写入 bundle 的 AppIcon.icns）；
            // 没有图标时退回琥珀底 + C 字形，保证拖拽目标永远可见。
            let bundleIconPath = Bundle.main.path(forResource: "AppIcon", ofType: "icns")
            let appIcon = (bundleIconPath.flatMap { NSImage(contentsOfFile: $0) }) ?? NSWorkspace.shared.icon(forFile: appPath)
            if appIcon.size.width >= 8, appIcon.size.height >= 8 {
                let iconView = NSImageView(frame: NSRect(x: 0, y: 0, width: 64, height: 64))
                iconView.image = appIcon
                iconView.imageScaling = .scaleProportionallyUpOrDown
                drag.addSubview(iconView)
            } else {
                drag.layer?.backgroundColor = AMBER.withAlphaComponent(0.9).cgColor
                let glyph = NSTextField(labelWithString: "C")
                glyph.font = .systemFont(ofSize: 30, weight: .bold)
                glyph.textColor = NSColor(white: 0.12, alpha: 1)
                glyph.alignment = .center
                glyph.frame = NSRect(x: 0, y: 18, width: 64, height: 32)
                drag.addSubview(glyph)
            }
            let dragHint = NSTextField(labelWithString: "拖我")
            dragHint.font = .systemFont(ofSize: 10, weight: .semibold)
            dragHint.textColor = AMBER
            dragHint.alignment = .center
            dragHint.frame = NSRect(x: 16, y: 6, width: 64, height: 14)
            content.addSubview(dragHint)
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


// MARK: - 内容采集（R1）：目标控件 / AX 快照 / 文本输入（纯逻辑，selftest 直接断言）

/// 命中控件信息（click/shortcut/text-input/submit/selection 共用）。
struct TargetInfo {
    var role: String
    var title: String
    var description: String
    var value: String?
    var secure: Bool

    /// 落盘形态：role 用中文可读名 + role_raw 保留原始 AX role；value 仅非密码控件且开启时携带。
    func json(includeValue: Bool = true) -> [String: Any] {
        var d: [String: Any] = [
            "role": localizedAXRole(role),
            "role_raw": role,
            "title": title,
            "description": description,
        ]
        if includeValue, !secure, let v = value, !v.isEmpty { d["value"] = v }
        return d
    }
}

/// 目标 value 的安全读取结果：密码控件恒 nil（不读）；其余按 AX_TARGET_VALUE_MAX_CHARS 截断。
func safeTargetValue(role: String, title: String, description: String, rawValue: String?) -> String? {
    guard !isSecureControl(role: role, title: title, description: description) else { return nil }
    guard let raw = rawValue, !raw.isEmpty else { return nil }
    return axOneLine(raw, maxLen: AX_TARGET_VALUE_MAX_CHARS)
}

/// 密码类控件判定（角色 AXSecureTextField / secure text field / password，或标题/描述含 password/密码）。
/// 命中后**绝不读取 AXValue/输入文本**（隐私红线；与 shared/privacy.mjs 的 UI 侧边界一致）。
func isSecureControl(role: String, title: String, description: String) -> Bool {
    let r = role.lowercased()
    let t = "\(title) \(description)".lowercased()
    if r.contains("securetextfield") || r.contains("secure text field") || r.contains("password") { return true }
    if t.contains("password") || t.contains("密码") { return true }
    return false
}


// AX role → 中文可读名（S2：摘要里不再出现 `AXOutline「?」`/「控件」这类机器味文本）。
// 未收录的 role 用去掉 AX 前缀的英文兜底（再不行用「元素」），绝不输出 "?"。
let AX_ROLE_LABELS: [String: String] = [
    "AXWindow": "窗口", "AXSheet": "面板", "AXDialog": "对话框", "AXGroup": "分组",
    "AXButton": "按钮", "AXMenuButton": "菜单按钮", "AXPopUpButton": "下拉按钮", "AXComboBox": "组合框",
    "AXStaticText": "文本", "AXTextField": "文本栏", "AXTextArea": "文本域", "AXHeading": "标题",
    "AXLink": "链接", "AXWebArea": "HTML 内容", "AXHTMLContent": "HTML 内容",
    "AXScrollArea": "滚动区", "AXOutline": "大纲", "AXRow": "行", "AXCell": "单元格",
    "AXTable": "表格", "AXList": "列表", "AXColumn": "列",
    "AXMenuItem": "菜单项", "AXMenu": "菜单", "AXMenuBar": "菜单栏", "AXMenuBarItem": "菜单栏项",
    "AXCheckBox": "复选框", "AXRadioButton": "单选", "AXRadioGroup": "单选组", "AXSwitch": "开关",
    "AXTabGroup": "标签组", "AXTab": "标签页", "AXToolbar": "工具栏",
    "AXImage": "图像", "AXIcon": "图标", "AXProgressIndicator": "进度条", "AXLevelIndicator": "等级指示器",
    "AXSlider": "滑块", "AXValueIndicator": "值指示器", "AXBusyIndicator": "忙碌指示器",
    "AXSplitGroup": "分栏", "AXSplitter": "分隔条", "AXDisclosureTriangle": "展开三角",
    "AXSecureTextField": "安全文本栏", "AXSearchField": "搜索栏", "AXText": "文本",
    "AXUnknown": "元素", "AXHelpTag": "帮助标签", "AXTooltip": "提示",
]

/// role 中文本地化（case-insensitive 查表；未知 role 去掉 AX 前缀兜底，空 role → 元素）。
func localizedAXRole(_ role: String) -> String {
    let raw = role.trimmingCharacters(in: .whitespacesAndNewlines)
    if raw.isEmpty { return "元素" }
    if let hit = AX_ROLE_LABELS[raw] { return hit }
    if let hit = AX_ROLE_LABELS.first(where: { $0.key.caseInsensitiveCompare(raw) == .orderedSame })?.value { return hit }
    if raw.hasPrefix("AX"), raw.count > 2 { return String(raw.dropFirst(2)) }
    return raw
}

/// 取第一个非空字符串（title → description → value 之类；已 trim）。
func firstNonEmpty(_ values: String?...) -> String {
    for value in values {
        if let s = value?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty { return s }
    }
    return ""
}

/// 纯 Swift AX 节点快照：真实采集与 selftest 共用同一序列化器（格式可测）。
struct AXSnapshotNode {
    var role: String
    var title: String
    var description: String
    var value: String?
    var children: [AXSnapshotNode]

    init(role: String, title: String = "", description: String = "", value: String? = nil, children: [AXSnapshotNode] = []) {
        self.role = role
        self.title = title
        self.description = description
        self.value = value
        self.children = children
    }
}

struct AXSnapshotSerialized {
    var lines: [String]
    var nodeCount: Int
    var truncated: Bool
}

/// 单行化 + 截断（AX 文本可能含换行；行协议 diff 必须每节点一行）。
func axOneLine(_ s: String, maxLen: Int) -> String {
    let cleaned = s.replacingOccurrences(of: "\r", with: " ").replacingOccurrences(of: "\n", with: " ")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    if cleaned.count <= maxLen { return cleaned }
    return String(cleaned.prefix(maxLen)) + "…"
}

/// 序列化格式（S2）：每行 `缩进 中文role 「title/description」 = value`；
/// 空 title/description 不输出「?」也不输出空括号；title 与 value 相同则不重复输出 value。
/// depth≤maxDepth、节点≤maxNodes、单值≤valueMax，超限置 truncated。
func serializeAXSnapshot(_ root: AXSnapshotNode,
                         maxDepth: Int = AX_MAX_DEPTH,
                         maxNodes: Int = AX_MAX_NODES,
                         valueMax: Int = AX_VALUE_MAX_CHARS) -> AXSnapshotSerialized {
    var lines: [String] = []
    var count = 0
    var truncated = false
    func walk(_ node: AXSnapshotNode, _ depth: Int) {
        guard count < maxNodes else { truncated = true; return }
        if depth > maxDepth { truncated = true; return }
        count += 1
        let roleLabel = localizedAXRole(node.role)
        let label = firstNonEmpty(node.title, node.description)
        let rawValue = firstNonEmpty(node.value)
        var line = String(repeating: "  ", count: depth) + roleLabel
        if !label.isEmpty { line += " 「\(axOneLine(label, maxLen: valueMax))」" }
        if !rawValue.isEmpty, rawValue != label {
            line += " = \(axOneLine(rawValue, maxLen: valueMax))"
        }
        lines.append(line)
        for child in node.children { walk(child, depth + 1) }
    }
    walk(root, 0)
    return AXSnapshotSerialized(lines: lines, nodeCount: count, truncated: truncated)
}

/// 文本截断（按 Character 计，不拆字素；附加省略号，落盘侧统一）。
func truncateText(_ text: String, maxChars: Int) -> String {
    let limit = Swift.max(0, maxChars)
    guard text.count > limit else { return text }
    return String(text.prefix(limit))
}

/// AX 行级 diff：简单集合对比（-删除 / +新增；顺序按原序列，稳定可读）。
func diffAXLines(prev: [String], next: [String], maxChars: Int) -> String {
    let prevSet = Set(prev)
    let nextSet = Set(next)
    var out: [String] = []
    for line in prev where !nextSet.contains(line) { out.append("-" + line) }
    for line in next where !prevSet.contains(line) { out.append("+" + line) }
    guard !out.isEmpty else { return "" }
    return truncateText(out.joined(separator: "\n"), maxChars: maxChars)
}

/// 任意 CF 值 → AXUIElement（全局版；Daemon 内的同名方法见下，共用这一实现）。
func asAXElementAny(_ any: Any) -> AXUIElement? {
    let obj = any as AnyObject
    let ref = obj as CFTypeRef
    guard CFGetTypeID(ref) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(ref, to: AXUIElement.self)
}

/// 浏览器内容 role：AX 树里网页正文所在子树，采集时优先分配节点预算。
let AX_WEB_CONTENT_ROLES: Set<String> = ["AXWebArea", "AXHTMLContent"]

func axIsWebContentRole(_ role: String) -> Bool {
    if AX_WEB_CONTENT_ROLES.contains(role) { return true }
    return AX_WEB_CONTENT_ROLES.contains { $0.caseInsensitiveCompare(role) == .orderedSame }
}

/// 单值属性方式读 children（常规路径）。
func axChildElements(_ el: AXUIElement, max: Int = AX_BULK_CHILD_LIMIT) -> [AXUIElement] {
    var childRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &childRef) == .success,
          let arr = childRef as? [Any] else { return [] }
    return arr.prefix(Swift.max(0, max)).compactMap { asAXElementAny($0) }
}

/// AXUIElementCopyAttributeValues 批量读 children（S2：微信等懒加载/浅树 App 的补充路径）。
func axBulkChildElements(_ el: AXUIElement, max: Int = AX_BULK_CHILD_LIMIT) -> [AXUIElement] {
    var count: CFIndex = 0
    guard AXUIElementGetAttributeValueCount(el, kAXChildrenAttribute as CFString, &count) == .success,
          count > 0 else { return [] }
    let take = Swift.min(Int(count), Swift.max(0, max))
    guard take > 0 else { return [] }
    var values: CFArray?
    guard AXUIElementCopyAttributeValues(el, kAXChildrenAttribute as CFString, 0, take, &values) == .success,
          let arr = values as? [Any] else { return [] }
    return arr.compactMap { asAXElementAny($0) }
}

/// children 排序：浏览器正文（AXWebArea/AXHTMLContent）优先，避免窗口 chrome 先吃掉节点预算。
func axOrderedChildren(_ el: AXUIElement, forceBulk: Bool) -> [AXUIElement] {
    var raw = forceBulk ? axBulkChildElements(el) : axChildElements(el)
    if raw.isEmpty { raw = forceBulk ? axChildElements(el) : axBulkChildElements(el) }
    guard raw.count > 1 else { return raw }
    var web: [AXUIElement] = []
    var rest: [AXUIElement] = []
    for child in raw {
        let role = axAttrString(child, kAXRoleAttribute as CFString) ?? ""
        if axIsWebContentRole(role) { web.append(child) } else { rest.append(child) }
    }
    return web + rest
}

/// 真实 AX 子树 → AXSnapshotNode（有界；密码控件 value 不读，直接 nil）。
/// forceBulk=true 时优先用 AXUIElementCopyAttributeValues（树太浅时的补充采集）。
func captureAXNode(_ el: AXUIElement?, depth: Int, maxDepth: Int, budget: inout Int,
                   valueMax: Int, forceBulk: Bool = false) -> AXSnapshotNode? {
    guard let el = el, budget > 0, depth <= maxDepth else { return nil }
    budget -= 1
    let role = axAttrString(el, kAXRoleAttribute as CFString) ?? ""
    let title = axAttrString(el, kAXTitleAttribute as CFString) ?? ""
    let desc = axAttrString(el, kAXDescriptionAttribute as CFString) ?? ""
    var value: String? = nil
    if !isSecureControl(role: role, title: title, description: desc) {
        if let raw = axAttrString(el, kAXValueAttribute as CFString), !raw.isEmpty {
            // 终端/网页/编辑器的可见文本比普通控件长：单独放大 value 预算，避免只留前 500 字。
            let effectiveValueMax = (role == "AXTextArea" || role == "AXWebArea") ? max(valueMax, 4000) : valueMax
            value = axOneLine(raw, maxLen: effectiveValueMax)
        }
    }
    var children: [AXSnapshotNode] = []
    if depth < maxDepth, budget > 0 {
        for childEl in axOrderedChildren(el, forceBulk: forceBulk) {
            if budget <= 0 { break }
            if let child = captureAXNode(childEl, depth: depth + 1, maxDepth: maxDepth,
                                         budget: &budget, valueMax: valueMax, forceBulk: forceBulk) {
                children.append(child)
            }
        }
    }
    return AXSnapshotNode(role: role, title: title, description: desc, value: value, children: children)
}


/// 目标控件落盘形态。
func makeTargetPayload(_ target: TargetInfo) -> [String: Any] { target.json() }

/// text-input 事件负载：密码控件返回 nil（不记录），文本按 inputTextMaxChars 截断。
/// text_composed：输入法合成后的结果（如 keyDown 原文 "ni hao" → "你好"），只在 flush 时存在。
func makeTextInputPayload(text: String, charCount: Int, target: TargetInfo, maxChars: Int,
                          composed: String? = nil) -> [String: Any]? {
    guard !target.secure else { return nil }
    var payload: [String: Any] = [
        "text": truncateText(text, maxChars: maxChars),
        "charCount": max(0, charCount),
        "target": makeTargetPayload(target),
    ]
    if let composed = composed?.trimmingCharacters(in: .whitespacesAndNewlines), !composed.isEmpty {
        payload["text_composed"] = truncateText(composed, maxChars: maxChars)
    }
    return payload
}

/// click 事件负载：命中密码控件返回 nil（不记录点击内容）。
func makeClickPayload(x: Double, y: Double, button: String, target: TargetInfo) -> [String: Any]? {
    guard !target.secure else { return nil }
    return ["x": Int(x.rounded()), "y": Int(y.rounded()), "button": button, "target": makeTargetPayload(target)]
}

/// shortcut 事件负载：密码控件目标不记录；无焦点控件（如 Dock）时省略 target。
func makeShortcutPayload(keyEquivalent: String, modifiers: [String], target: TargetInfo) -> [String: Any]? {
    guard !target.secure else { return nil }
    var payload: [String: Any] = ["keyEquivalent": keyEquivalent, "modifiers": modifiers]
    if !target.role.isEmpty { payload["target"] = makeTargetPayload(target) }
    return payload
}

/// selection 事件负载：目标密码控件 / 无内容时返回 nil；allowBare 保留空选区（只有 target），
/// 与参考实现的 bare selection 事件同口径。
func makeSelectionPayload(selectedText: String?, range: (location: Int, length: Int)?,
                          items: [[String: Any]], maxChars: Int, target: TargetInfo,
                          allowBare: Bool = false) -> [String: Any]? {
    guard !target.secure else { return nil }
    var payload: [String: Any] = ["target": makeTargetPayload(target)]
    if let text = selectedText, !text.isEmpty { payload["selectedText"] = truncateText(text, maxChars: maxChars) }
    if let r = range, r.length > 0 { payload["selectedRange"] = ["location": r.location, "length": r.length] }
    if !items.isEmpty { payload["selectedItems"] = items }
    let hasContent = payload["selectedText"] != nil || payload["selectedRange"] != nil || payload["selectedItems"] != nil
    return (hasContent || allowBare) ? payload : nil
}

/// AX 快照事件负载。
func makeAXSnapshotPayload(mode: String, text: String, nodeCount: Int, maxChars: Int) -> [String: Any] {
    ["mode": mode, "text": truncateText(text, maxChars: maxChars), "nodeCount": nodeCount]
}

/// CGEvent keyCode → 可读键名（S2：避免出现 `⌃keycode-0`；覆盖字母/数字/符号/控制键/F 键）。
/// 无字符输出的组合键（如 control+字母、方向键）走这张表。
let KEYCODE_NAMES: [Int: String] = [
    0: "A", 1: "S", 2: "D", 3: "F", 4: "H", 5: "G", 6: "Z", 7: "X", 8: "C", 9: "V",
    11: "B", 12: "Q", 13: "W", 14: "E", 15: "R", 16: "Y", 17: "T",
    18: "1", 19: "2", 20: "3", 21: "4", 22: "6", 23: "5", 24: "=", 25: "9",
    26: "7", 27: "-", 28: "8", 29: "0", 30: "]", 31: "O", 32: "U", 33: "[",
    34: "I", 35: "P", 36: "return", 37: "L", 38: "J", 39: "'", 40: "K",
    41: ";", 42: "\\", 43: ",", 44: "/", 45: "N", 46: "M", 47: ".",
    48: "tab", 49: "Space", 50: "`", 51: "delete", 53: "escape",
    55: "Command", 56: "Shift", 57: "CapsLock", 58: "Option", 59: "Control",
    60: "RightShift", 61: "RightOption", 62: "RightControl", 63: "Fn",
    64: "F17", 65: "KeypadDecimal", 67: "KeypadMultiply", 69: "KeypadPlus",
    71: "KeypadClear", 75: "KeypadDivide", 76: "KeypadEnter", 78: "KeypadMinus",
    79: "F18", 80: "F19", 81: "KeypadEquals", 82: "Keypad0", 83: "Keypad1",
    84: "Keypad2", 85: "Keypad3", 86: "Keypad4", 87: "Keypad5", 88: "Keypad6",
    89: "Keypad7", 91: "Keypad8", 92: "Keypad9", 96: "F5", 97: "F6",
    98: "F7", 99: "F3", 100: "F8", 101: "F9", 103: "F11", 105: "F13",
    106: "F16", 107: "F14", 109: "F10", 111: "F12", 113: "F15", 114: "Help",
    115: "home", 116: "page_up", 117: "forward_delete", 118: "F4", 119: "end",
    120: "F2", 121: "page_down", 122: "F1", 123: "left_arrow", 124: "right_arrow",
    125: "down_arrow", 126: "up_arrow",
]

/// 非文本按键 → shortcut 事件（与参考实现的 keyboard.shortcut 同口径）：
/// 方向键、删除、Tab、Esc、Home/End/PageUp/PageDown、前向删除。
let NAV_KEY_NAMES: [Int: String] = [
    48: "tab", 51: "delete", 53: "escape",
    115: "home", 116: "page_up", 117: "forward_delete", 119: "end", 121: "page_down",
    123: "left_arrow", 124: "right_arrow", 125: "down_arrow", 126: "up_arrow",
]

/// 修饰键本身不产生快捷键事件（按住 ⌘/⇧/⌥/⌃/Fn 不是一次快捷键）。
let MODIFIER_KEYCODES: Set<Int> = [54, 55, 56, 57, 58, 59, 60, 61, 62, 63]

/// Return 分类（参考实现同口径）：无修饰键且存在文本内容时，需要看 Return 后
/// 目标文本是否被清空来区分 submit/shortcut；否则直接记 shortcut。
func returnNeedsSubmitCheck(modifiers: [String], hasContent: Bool) -> Bool {
    modifiers.isEmpty && hasContent
}

/// 文本输入类 AX role：Return 后同 role 且文本仍在 → shortcut（换行/终端继续）。
let TEXT_INPUT_ROLES: Set<String> = ["AXTextArea", "AXTextField", "AXSearchField", "AXComboBox", "AXWebArea"]

/// 对话框/默认按钮类 role：无修饰键 Return 直接视为 submit（如访达警告框的「好」）。
let RETURN_ACTION_ROLES: Set<String> = ["AXWindow", "AXSheet", "AXDialog", "AXButton"]

/// Return 250ms 复查判定：只有「同一文本类控件且文本仍在」才不是 submit。
func returnSettleIsSubmit(afterRole: String, afterHasText: Bool, beforeRole: String) -> Bool {
    let sameTextTarget = !afterRole.isEmpty && afterRole == beforeRole && TEXT_INPUT_ROLES.contains(afterRole)
    return !(sameTextTarget && afterHasText)
}

/// 是否需要做 Return 后的 250ms 复查：
/// - 无修饰键 + 当前仍有文本（pending 或 AXValue）→ 是；
/// - 焦点控件读不到（role 为空）但最近 5 秒输入过文本（微信常见）→ 是；
/// - 其余 → 直接按 shortcut。
func returnNeedsSettleCheck(modifiers: [String], hasContent: Bool, roleIsEmpty: Bool, recentText: Bool) -> Bool {
    guard modifiers.isEmpty else { return false }
    return hasContent || (roleIsEmpty && recentText)
}

/// Return 后等待目标 AXValue 稳定/清空的时间（submit 判定窗口）。
let RETURN_SETTLE_SEC: TimeInterval = 0.25

// MARK: - CGEventTap（点击 / 快捷键 / 输入 / 提交；listen-only，不拦截不修改事件）

/// 输入事件监听：AX 权限缺失时 start() 返回 false，调用方静默降级。
final class InputMonitor {
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private(set) var running = false
    weak var daemon: Daemon?

    static func createMask() -> CGEventMask {
        (1 << CGEventType.keyDown.rawValue)
            | (1 << CGEventType.leftMouseDown.rawValue)
            | (1 << CGEventType.rightMouseDown.rawValue)
            | (1 << CGEventType.leftMouseUp.rawValue)
            | (1 << CGEventType.rightMouseUp.rawValue)
            | (1 << CGEventType.scrollWheel.rawValue)
    }

    func start() -> Bool {
        if running { return true }
        guard axTrusted() else { return false }
        guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap,
                                          place: .headInsertEventTap,
                                          options: .listenOnly,
                                          eventsOfInterest: InputMonitor.createMask(),
                                          callback: inputTapCallback,
                                          userInfo: Unmanaged.passUnretained(self).toOpaque()) else {
            return false
        }
        guard let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            CFMachPortInvalidate(tap)
            return false
        }
        CFRunLoopAddSource(CFRunLoopGetMain(), src, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        self.tap = tap
        self.source = src
        running = true
        return true
    }

    func stop() {
        if let src = source { CFRunLoopRemoveSource(CFRunLoopGetMain(), src, .commonModes) }
        if let tap = tap {
            CGEvent.tapEnable(tap: tap, enable: false)
            CFMachPortInvalidate(tap)
        }
        source = nil
        tap = nil
        running = false
    }

    fileprivate func handle(type: CGEventType, event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap = tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return
        }
        guard let daemon = daemon else { return }
        switch type {
        case .keyDown:
            var buf = [UniChar](repeating: 0, count: 16)
            var len: Int = 0
            event.keyboardGetUnicodeString(maxStringLength: 16, actualStringLength: &len, unicodeString: &buf)
            let chars = len > 0 ? String(decoding: buf.prefix(len), as: UTF16.self) : ""
            let keycode = Int(event.getIntegerValueField(.keyboardEventKeycode))
            let flags = event.flags.rawValue
            daemon.stateQueue.async {
                daemon.handleKeyInput(keycode: keycode, flagsRaw: flags, characters: chars)
            }
        case .leftMouseDown, .rightMouseDown:
            let loc = event.location
            let button = type == .rightMouseDown ? "right" : "left"
            daemon.stateQueue.async {
                daemon.handleMouseInput(x: Double(loc.x), y: Double(loc.y), button: button)
            }
        case .leftMouseUp, .rightMouseUp:
            let loc = event.location
            let button = type == .rightMouseUp ? "right" : "left"
            daemon.stateQueue.async {
                daemon.handleMouseUp(x: Double(loc.x), y: Double(loc.y), button: button)
            }
        case .scrollWheel:
            // 触控板用 point delta（像素），传统滚轮 point 为 0 时退回行 delta。
            var dx = Double(event.getIntegerValueField(.scrollWheelEventPointDeltaAxis2))
            var dy = Double(event.getIntegerValueField(.scrollWheelEventPointDeltaAxis1))
            if dx == 0 && dy == 0 {
                dx = Double(event.getIntegerValueField(.scrollWheelEventDeltaAxis2)) * 10
                dy = Double(event.getIntegerValueField(.scrollWheelEventDeltaAxis1)) * 10
            }
            daemon.stateQueue.async { daemon.handleScroll(dx: dx, dy: dy) }
        default:
            break
        }
    }
}

private func inputTapCallback(proxy: CGEventTapProxy,
                              type: CGEventType,
                              event: CGEvent,
                              userInfo: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    if let info = userInfo {
        let monitor = Unmanaged<InputMonitor>.fromOpaque(info).takeUnretainedValue()
        monitor.handle(type: type, event: event)
    }
    return Unmanaged.passUnretained(event)
}

// MARK: - AX 选区通知监听

/// REA 证据：参考实现的焦点元素观察者注册这 6 类 AX 通知，
/// 选区事件不是 2s 轮询出来的。顺序与二进制里的通知数组一致。
let SELECTION_AX_NOTIFICATIONS: [String] = [
    "AXSelectedTextChanged",
    "AXSelectedChildrenChanged",
    "AXSelectedChildrenMoved",
    "AXSelectedRowsChanged",
    "AXSelectedColumnsChanged",
    "AXSelectedCellsChanged",
]

/// 通知防抖：连续拖选只落一条（参考实现对应的防抖任务）。
let SELECTION_DEBOUNCE_SEC: TimeInterval = 0.12

/// 会承载“选中项”的 AX 容器角色：焦点在行/单元格/菜单项上时，需要向上找到容器再订阅。
let SELECTION_CONTAINER_ROLES: Set<String> = [
    "AXOutline", "AXTable", "AXList", "AXTabGroup", "AXMenu", "AXBrowser",
]

private func selectionAXCallback(observer: AXObserver, element: AXUIElement,
                                 notification: CFString, refcon: UnsafeMutableRawPointer?) {
    guard let refcon = refcon else { return }
    let monitor = Unmanaged<SelectionMonitor>.fromOpaque(refcon).takeUnretainedValue()
    monitor.receive(element: element, notification: notification as String)
}

/// 每个前台 app 一个 AXObserver。application 元素负责接收文本域/网页区域的选区通知；
/// 焦点窗口 + 焦点控件（每次焦点变化重新订阅）负责 Outline/Table/List/TabGroup/Menu 的选中变化。
final class SelectionMonitor {
    private(set) var pid: pid_t = 0
    private(set) var isActive = false
    weak var daemon: Daemon?
    private var observer: AXObserver?
    private var source: CFRunLoopSource?
    private var appElement: AXUIElement?
    private var focusTargets: [AXUIElement] = []
    private var containerTargets: [AXUIElement] = []
    private var windowTarget: AXUIElement?
    private var valueTarget: AXUIElement?

    deinit { stop() }

    func start(pid: pid_t) -> Bool {
        stop()
        guard pid > 0 else { return false }
        var obs: AXObserver?
        guard AXObserverCreate(pid, selectionAXCallback, &obs) == .success, let o = obs else { return false }
        self.pid = pid
        observer = o
        let src = AXObserverGetRunLoopSource(o)
        CFRunLoopAddSource(CFRunLoopGetMain(), src, .commonModes)
        source = src
        let app = AXUIElementCreateApplication(pid)
        appElement = app
        register(SELECTION_AX_NOTIFICATIONS, on: app)
        register(["AXFocusedUIElementChanged", "AXFocusedWindowChanged", "AXMenuOpened"], on: app)
        isActive = true
        refreshFocusTargets(pid: pid)
        refreshWindowContainers(pid: pid)
        return true
    }

    /// 窗口变化时扫描一遍窗口 AX 树，把所有 Outline/Table/List/TabGroup/Menu 容器都订阅上。
    /// Arc 的侧栏选中发生在 WebArea 焦点下，焦点祖先链找不到这些兄弟容器，必须按窗口扫描。
    func refreshWindowContainers(pid: pid_t) {
        guard isActive, pid == self.pid, let o = observer else { return }
        guard let win = monitorWindowElement(pid: pid) else { return }
        for el in containerTargets {
            for n in SELECTION_AX_NOTIFICATIONS {
                _ = AXObserverRemoveNotification(o, el, n as CFString)
            }
        }
        containerTargets.removeAll()
        AXUIElementSetMessagingTimeout(win, 0.5)
        var budget = 500
        let deadline = Date().addingTimeInterval(0.3)
        var found: [AXUIElement] = []
        // 广度优先：侧栏 Outline/Table 通常比网页正文浅，先扫浅层避免预算被深树耗尽。
        var queue: [(AXUIElement, Int)] = [(win, 0)]
        var head = 0
        while head < queue.count, budget > 0, Date() < deadline {
            let (el, depth) = queue[head]
            head += 1
            budget -= 1
            let role = axAttrString(el, kAXRoleAttribute as CFString) ?? ""
            if SELECTION_CONTAINER_ROLES.contains(role) { found.append(el) }
            if depth < 8 {
                for child in axChildElements(el, max: 40) { queue.append((child, depth + 1)) }
            }
        }
        // 菜单/弹层常是 app 的独立窗口或 AXMenu 子元素，不在焦点窗口树里：补扫 app 的直接子元素。
        if let app = appElement {
            for child in axChildElements(app, max: 40) {
                let role = axAttrString(child, kAXRoleAttribute as CFString) ?? ""
                if SELECTION_CONTAINER_ROLES.contains(role) { found.append(child) }
            }
        }
        for el in found where !containerTargets.contains(where: { CFEqual($0, el) }) {
            register(SELECTION_AX_NOTIFICATIONS, on: el)
            containerTargets.append(el)
        }
    }

    /// 焦点一变就把选区通知订阅到新的焦点窗口/焦点控件；同时移除旧目标的订阅。
    func refreshFocusTargets(pid: pid_t) {
        guard isActive, pid == self.pid, let o = observer else { return }
        if let old = windowTarget {
            _ = AXObserverRemoveNotification(o, old, "AXTitleChanged" as CFString)
            windowTarget = nil
        }
        if let old = valueTarget {
            _ = AXObserverRemoveNotification(o, old, "AXValueChanged" as CFString)
            valueTarget = nil
        }
        for el in focusTargets {
            for n in SELECTION_AX_NOTIFICATIONS {
                _ = AXObserverRemoveNotification(o, el, n as CFString)
            }
        }
        focusTargets.removeAll()
        var next: [AXUIElement] = []
        if let win = monitorWindowElement(pid: pid) { next.append(win) }
        if let focused = monitorFocusedElement(pid: pid) {
            for el in [focused] + selectionContainerAncestors(of: focused) {
                if !next.contains(where: { CFEqual($0, el) }) { next.append(el) }
            }
            // 文本区值变化（终端输出/编辑器输入）单独订阅，触发强制 AX diff。
            let role = axAttrString(focused, kAXRoleAttribute as CFString) ?? ""
            if TEXT_INPUT_ROLES.contains(role) {
                _ = AXObserverAddNotification(o, focused, "AXValueChanged" as CFString, nil)
                valueTarget = focused
            }
        }
        for el in next {
            register(SELECTION_AX_NOTIFICATIONS, on: el)
            focusTargets.append(el)
        }
        // 焦点窗口单独订阅标题变化，用于即时落 window-change（非浏览器 app）。
        if let win = next.first {
            _ = AXObserverAddNotification(o, win, "AXTitleChanged" as CFString, nil)
            windowTarget = win
        }
    }

    /// 焦点在表格行/大纲行/菜单项上时，向上找 AXOutline/AXTable/AXList/AXTabGroup/AXMenu 容器；
    /// 这些容器才是 AXSelectedChildren/Rows 通知的发送者。
    private func selectionContainerAncestors(of element: AXUIElement, maxDepth: Int = 6) -> [AXUIElement] {
        var out: [AXUIElement] = []
        var current: AXUIElement? = element
        var depth = 0
        while let cur = current, depth < maxDepth {
            let role = axAttrString(cur, kAXRoleAttribute as CFString) ?? ""
            if SELECTION_CONTAINER_ROLES.contains(role), !out.contains(where: { CFEqual($0, cur) }) {
                out.append(cur)
            }
            current = axAttrElement(cur, kAXParentAttribute as CFString)
            depth += 1
        }
        return out
    }

    func receive(element: AXUIElement, notification: String) {
        guard isActive, let d = daemon else { return }
        if notification == "AXFocusedUIElementChanged" {
            let pid = self.pid
            d.stateQueue.async { [weak self] in self?.refreshFocusTargets(pid: pid) }
            return
        }
        if notification == "AXMenuOpened" {
            // 菜单是独立弹层，可能不在焦点窗口树里：打开时直接订阅这个菜单元素。
            let menuElement = element
            d.stateQueue.async { [weak self] in self?.registerContainer(menuElement) }
            return
        }
        if notification == "AXValueChanged" {
            d.stateQueue.async { d.handleValueChanged() }
            return
        }
        if notification == "AXFocusedWindowChanged" || notification == "AXTitleChanged" {
            let pid = self.pid
            let isFocusChange = notification == "AXFocusedWindowChanged"
            d.stateQueue.async { [weak self] in
                if isFocusChange { self?.refreshFocusTargets(pid: pid) }
                d.handleWindowNotification()
            }
            return
        }
        let pid = self.pid
        d.stateQueue.async {
            d.handleSelectionNotification(element: element, notification: notification, pid: Int(pid))
        }
    }

    /// 追加订阅一个选区容器（菜单等），重复元素跳过。
    func registerContainer(_ element: AXUIElement) {
        guard isActive, observer != nil, containerTargets.count < 64 else { return }
        if let app = appElement, CFEqual(app, element) { return }
        guard !containerTargets.contains(where: { CFEqual($0, element) }) else { return }
        register(SELECTION_AX_NOTIFICATIONS, on: element)
        containerTargets.append(element)
    }

    /// 从被点击元素向上找 Outline/Table/List/TabGroup/Menu 祖先并订阅。
    /// Arc 的侧栏（AXOutline id=sidebarAllTabList）在第 7 层、窗口扫描预算够不到；
    /// 点击命中点向上走 10 层即可稳定找到，配合延迟补读兜住“通知早于订阅”的情况。
    func registerAncestors(of element: AXUIElement) -> [AXUIElement] {
        guard isActive else { return [] }
        var found: [AXUIElement] = []
        var current: AXUIElement? = element
        var depth = 0
        while let cur = current, depth < 10 {
            let role = axAttrString(cur, kAXRoleAttribute as CFString) ?? ""
            if SELECTION_CONTAINER_ROLES.contains(role) {
                registerContainer(cur)
                found.append(cur)
                break // 只订阅最内层容器，外层 AXList 不再重复补读
            }
            current = axAttrElement(cur, kAXParentAttribute as CFString)
            depth += 1
        }
        return found
    }

    func stop() {
        if let o = observer {
            if let app = appElement {
                for n in SELECTION_AX_NOTIFICATIONS {
                    _ = AXObserverRemoveNotification(o, app, n as CFString)
                }
                _ = AXObserverRemoveNotification(o, app, "AXFocusedUIElementChanged" as CFString)
                _ = AXObserverRemoveNotification(o, app, "AXFocusedWindowChanged" as CFString)
                _ = AXObserverRemoveNotification(o, app, "AXMenuOpened" as CFString)
            }
            if let old = windowTarget {
                _ = AXObserverRemoveNotification(o, old, "AXTitleChanged" as CFString)
            }
            if let old = valueTarget {
                _ = AXObserverRemoveNotification(o, old, "AXValueChanged" as CFString)
            }
            for el in focusTargets + containerTargets {
                for n in SELECTION_AX_NOTIFICATIONS {
                    _ = AXObserverRemoveNotification(o, el, n as CFString)
                }
            }
        }
        if let src = source { CFRunLoopRemoveSource(CFRunLoopGetMain(), src, .commonModes) }
        source = nil
        observer = nil
        appElement = nil
        focusTargets.removeAll()
        containerTargets.removeAll()
        windowTarget = nil
        valueTarget = nil
        pid = 0
        isActive = false
    }

    private func register(_ notifications: [String], on el: AXUIElement) {
        guard let o = observer else { return }
        for n in notifications { _ = AXObserverAddNotification(o, el, n as CFString, nil) }
    }
}

private func monitorWindowElement(pid: pid_t) -> AXUIElement? {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.5)
    return axAttrElement(app, kAXFocusedWindowAttribute as CFString)
        ?? axAttrElement(app, kAXMainWindowAttribute as CFString)
}

private func monitorFocusedElement(pid: pid_t) -> AXUIElement? {
    let sys = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(sys, 0.5)
    guard let focused = axAttrElement(sys, kAXFocusedUIElementAttribute as CFString) else { return nil }
    if let p = axAttrPID(focused), p != Int(pid) { return nil }
    return focused
}

// MARK: - 守护主体


/// 线程模型：可变状态只在 stateQueue 上读写；stdout 由 outputLock 串行化。
/// 因此可安全地跨并发域持有引用（@unchecked）。
final class Daemon: @unchecked Sendable {
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
    private var segment: Segment? // 懒物化：对象存在不代表目录存在
    private var pauseAutoResumeWork: DispatchWorkItem?

    // 去重状态（连续采样相同 → 不产生事件；段轮转/上下文恢复后重新快照一次）
    private var lastBundleId = ""
    private var lastWindowTitle = ""
    private var lastWindowId = ""
    private var lastURL = ""
    private var lastFocusKey = ""
    private var lastSuppressedKey = ""

    // R1 内容采集状态
    private struct Context {
        var bundleId: String
        var appName: String
        var pid: Int
        var windowTitle: String
        var storedURL: String?
        var incognito: Bool
        var windowId: Int?
        var documentPath: String?
        var at: Date
    }
    private var context: Context?
    private var windowElement: AXUIElement?
    private var inputMonitor: InputMonitor?
    private var inputMonitorFailedLogged = false
    private var pendingText = ""
    private var pendingTarget: TargetInfo?
    private var pendingContext: Context?
    private var lastTextInputAt: Date?
    private var textFlushWork: DispatchWorkItem?
    private var lastClick: (at: Date, x: Double, y: Double, button: String)?
    private var mouseDownState: (at: Date, x: Double, y: Double, button: String, target: TargetInfo)?
    private var lastSelectionPollAt: Date?
    private var selectionMonitor: SelectionMonitor?
    private var selectionDebounce: [String: DispatchWorkItem] = [:]
    private var lastSelectionKey = ""
    private var activationObserver: NSObjectProtocol?
    private var presenceObservers: [(NotificationCenter, NSObjectProtocol)] = []
    /// 换段前的前台应用：新段里同应用的首条 app-switch 只是补记上下文，标 reason=segment-start。
    private var rotatedBundleId = ""
    /// 在场状态：每段开头补报一次，之后只在 idle/active 翻转时记。
    private var presenceIdle = false
    private var presenceAnnounced = false
    private var lastSnapshotLines: [String]?
    private var lastSnapshotWindowKey = ""
    private var lastSnapshotAt: Date?
    private var scrollDx = 0.0
    private var scrollDy = 0.0
    private var scrollTicks = 0
    private var scrollStartedAt: Date?
    private var scrollFlushWork: DispatchWorkItem?
    private var lastVisibleWindowsAt: Date?
    private var lastVisibleWindowsDigest = ""
    private var lastVisibleWindowsEmitAt: Date?

    // Safari 无痕启发式缓存（AppleScript 窗口名/AX 子树探测较贵，按 url|窗口名 缓存 10s）
    private var safariPrivateCache: (key: String, value: Bool, at: Date)?

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
            respond(id: id, ok: true, extra: ["axGranted": axTrusted(),
                                              "screenGranted": CGPreflightScreenCaptureAccess(),
                                              "secureInput": secureInputActive(),
                                              "protocol": PROTOCOL_VERSION])
        case "decide":
            cmdDecide(id: id, params: params)
        case "selftest":
            cmdSelftest(id: id, params: params)
        case "request-permissions":
            let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            let granted = AXIsProcessTrustedWithOptions(opts)
            respond(id: id, ok: true, extra: ["axGranted": granted])
        case "request-screen-permissions":
            let granted = CGRequestScreenCaptureAccess()
            respond(id: id, ok: true, extra: ["screenGranted": granted])
        case "ocr-window":
            cmdOCRWindow(id: id)
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

    /// 按需 OCR：仅用户显式触发；单窗口、像素只在内存、文字写成本机事件。
    private func cmdOCRWindow(id: Int) {
        guard running, !paused, !exited else {
            respond(id: id, ok: false, error: "采集未运行或已暂停，先恢复记录再读取屏幕", code: "NOT_RUNNING")
            return
        }
        guard config.includeContent else {
            respond(id: id, ok: false, error: "内容采集已关闭（includeContent=false）", code: "CONTENT_DISABLED")
            return
        }
        guard secureInputActive() == false else {
            respond(id: id, ok: false, error: "系统正处于安全输入状态，跳过屏幕读取", code: "SECURE_INPUT")
            return
        }
        guard let front = NSWorkspace.shared.frontmostApplication,
              let bundleId = front.bundleIdentifier, !bundleId.isEmpty,
              let ctx = context, frontmostMatches(ctx) else {
            respond(id: id, ok: false, error: "没有可读取的前台窗口", code: "NO_WINDOW")
            return
        }
        if config.appBlocked(bundleId) {
            respond(id: id, ok: false, error: "前台应用在阻断名单中", code: "APP_BLOCKED")
            return
        }
        // 浏览器用原始 URL 再过一次规则（与采样路径一致），无痕直接拒绝。
        var rawURL = ctx.storedURL
        var ocrIncognito = ctx.incognito
        if isBrowser(bundleId), let got = browserSample(bundleId: bundleId, pid: ctx.pid) {
            rawURL = got.url
            ocrIncognito = got.incognito
        }
        if ocrIncognito {
            respond(id: id, ok: false, error: "无痕浏览不读取屏幕", code: "INCOGNITO")
            return
        }
        let decision = config.evaluate(SampleInput(bundleId: bundleId, url: rawURL, incognito: ocrIncognito))
        guard decision.observe else {
            respond(id: id, ok: false, error: "当前上下文被隐私规则拦截（\(decision.reason)）", code: "PRIVACY_BLOCKED")
            return
        }
        if #available(macOS 14.0, *) {
            let pid = ctx.pid
            let windowId = ctx.windowId
            let capturedCtx = ctx
            Task { [weak self] in
                do {
                    let result = try await ScreenOCR.capture(pid: pid, windowId: windowId)
                    self?.stateQueue.async {
                        guard let self = self else { return }
                        var data = self.contextData(capturedCtx)
                        data["text"] = result.text
                        data["lineCount"] = result.lineCount
                        data["width"] = result.width
                        data["height"] = result.height
                        data["source"] = "on-demand"
                        let stored = self.running && !self.paused && !self.exited
                        if stored { self.emit("visual-text", data: data) }
                        self.respond(id: id, ok: true, extra: ["ocr": data, "stored": stored])
                    }
                } catch {
                    let info = ScreenOCR.describe(error)
                    self?.stateQueue.async {
                        self?.respond(id: id, ok: false, error: info.message, code: info.code)
                    }
                }
            }
        } else {
            respond(id: id, ok: false, error: "按需 OCR 需要 macOS 14 或更新版本", code: "UNSUPPORTED_OS")
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
        // 启动前修复上次异常退出留下的孤儿段（无 segmentEnd）并清理空段。
        let repair = repairOrphanSegments(at: segmentsRoot)
        if repair.repaired > 0 || repair.removed > 0 {
            FileHandle.standardError.write(Data("chronicle-daemon: 孤儿段修复 repaired=\(repair.repaired) removed=\(repair.removed)\n".utf8))
        }
        // 段对象懒物化：目录在首个事件/抑制记录落盘时才创建（空闲不产生空段目录）。
        segment = Segment(root: segmentsRoot)
        running = true
        paused = false
        pausedAt = nil
        sessionTotalEvents = 0
        observationStartMs = Date().timeIntervalSince1970 * 1000
        lastBundleId = ""; lastWindowTitle = ""; lastWindowId = ""; lastURL = ""; lastFocusKey = ""; lastSuppressedKey = ""
        safariPrivateCache = nil
        stopInputMonitor()
        resetRichState()
        inputMonitorFailedLogged = false
        startSampler()
        startActivationObserver()
        maybeStartInputMonitor()
        respond(id: id, ok: true, extra: ["segmentsDir": segmentsRoot.path,
                                          "repairedSegments": repair.repaired,
                                          "removedEmptySegments": repair.removed])
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
        flushTextInput(reason: "pause")
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
                    self.rotateIfDue()
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
        // 恢复前先补关暂停期间到期的段（不新建空段；新段等到首个事件再懒建）。
        rotateIfDue()
        paused = false
        pausedAt = nil
        pauseAutoResumeWork?.cancel()
        maybeStartInputMonitor()
        respond(id: id, ok: true, extra: ["resumedAt": isoNow()])
    }

    private func cmdStatus(id: Int) {
        let home = chronicleHome()
        var cfgJSON = config.toJSON()
        cfgJSON["paused"] = paused
        var cur: Any = NSNull()
        if let seg = segment, running {
            cur = ["startTs": seg.startTs,
                   "eventCount": seg.eventCount,
                   "suppressedEventCount": seg.suppressedEventCount]
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

    /// 纯决策命令（无副作用）：只读 config + 指针参数，不落盘、不创建目录、不改运行状态。
    /// 与 shared/privacy.mjs evaluateSample 同一语义，test/privacy.test.mjs 逐条对拍。
    private func cmdDecide(id: Int, params: [String: Any]) {
        var configPath: URL?
        if let p = params["configPath"] as? String, !p.isEmpty {
            configPath = URL(fileURLWithPath: (p as NSString).expandingTildeInPath)
        }
        let cfg = ChronicleConfig.load(path: configPath)
        let obj = params["sample"] as? [String: Any] ?? [:]
        let sample = SampleInput(
            bundleId: obj["bundleId"] as? String ?? "",
            url: obj["url"] as? String,
            title: obj["title"] as? String,
            focusRole: obj["focusRole"] as? String,
            focusTitle: obj["focusTitle"] as? String,
            secureInput: obj["secureInput"] as? Bool ?? false,
            incognito: obj["incognito"] as? Bool ?? false
        )
        let d = cfg.evaluate(sample)
        respond(id: id, ok: true, extra: [
            "observe": d.observe,
            "blockedScope": d.blockedScope ?? NSNull(),
            "reason": d.reason,
            "redactedURL": d.redactedURL ?? NSNull(),
        ])
    }

    /// 无副作用自检命令（测试用）：验证内容采集的配置归一化 / AX 快照序列化与上限 /
    /// diff / 输入文本截断 / 密码控件抑制。不读屏幕、不落盘、不改变运行状态。
    private func cmdSelftest(id: Int, params: [String: Any]) {
        var cfg: ChronicleConfig
        if let p = params["configPath"] as? String, !p.isEmpty {
            cfg = ChronicleConfig.load(path: URL(fileURLWithPath: (p as NSString).expandingTildeInPath))
        } else if let inline = params["config"] as? [String: Any] {
            cfg = ChronicleConfig.fromJSON(inline)
        } else {
            cfg = config
        }
        let longValue = String(repeating: "x", count: 600)
        func tree(button: String, extra: [AXSnapshotNode] = []) -> AXSnapshotNode {
            AXSnapshotNode(role: "AXWindow", title: "Editor — draft.md", children: [
                AXSnapshotNode(role: "AXButton", title: button, description: "保存文件"),
                AXSnapshotNode(role: "AXStaticText", value: longValue),
                AXSnapshotNode(role: "AXTextField", title: "标题", value: "draft"),
                AXSnapshotNode(role: "AXSecureTextField", title: "Password", description: "password"),
            ] + extra)
        }
        let full = serializeAXSnapshot(tree(button: "Save"))
        let next = serializeAXSnapshot(tree(button: "Save All", extra: [AXSnapshotNode(role: "AXStaticText", value: "新增提示")]))
        let diff = diffAXLines(prev: full.lines, next: next.lines, maxChars: cfg.diffMaxChars)

        var deep = AXSnapshotNode(role: "AXLeaf")
        for i in (0..<20).reversed() { deep = AXSnapshotNode(role: "AXGroup\(i)", children: [deep]) }
        let deepS = serializeAXSnapshot(deep)
        let wideS = serializeAXSnapshot(AXSnapshotNode(role: "AXWindow",
                                                      children: (0..<1300).map { AXSnapshotNode(role: "AXButton", title: "btn\($0)") }))

        let normalTarget = TargetInfo(role: "AXTextArea", title: "正文", description: "markdown", value: "已输入内容", secure: false)
        let secureTarget = TargetInfo(role: "AXSecureTextField", title: "Password", description: "password", value: "secret", secure: true)
        let text = makeTextInputPayload(text: String(repeating: "a", count: 5000), charCount: 5000, target: normalTarget, maxChars: cfg.inputTextMaxChars)
        let click = makeClickPayload(x: 120.4, y: 88.7, button: "left", target: normalTarget)
        let shortcut = makeShortcutPayload(keyEquivalent: "s", modifiers: ["command"], target: normalTarget)
        let selection = makeSelectionPayload(selectedText: String(repeating: "选", count: 500),
                                             range: (location: 2, length: 5),
                                             items: [["role": "AXRow", "title": "第 1 行", "description": ""]],
                                             maxChars: cfg.selectionMaxChars, target: normalTarget)
        let secureValue = safeTargetValue(role: "AXSecureTextField", title: "Password", description: "password", rawValue: "secret")
        let fullText = full.lines.joined(separator: "\n")
        let emptyTitleLine = serializeAXSnapshot(AXSnapshotNode(role: "AXOutline")).lines.first ?? ""
        let normalTargetPayload = makeTargetPayload(normalTarget)
        let composedPayload = makeTextInputPayload(text: "ni hao", charCount: 6, target: normalTarget,
                                                   maxChars: cfg.inputTextMaxChars, composed: "你好")
        let keyNames: [String: Any] = Dictionary(uniqueKeysWithValues: [0, 1, 36, 48, 49, 51, 116, 117, 121, 123, 124, 125, 126, 250].map {
            (String($0), keyEquivalentString(keycode: $0, characters: ""))
        })
        let fullDict: [String: Any] = [
            "text": fullText,
            "nodeCount": full.nodeCount,
            "secureLine": full.lines.first { $0.contains("安全文本栏") } ?? "",
            "valueTruncated": full.lines.contains { $0.contains("…") },
            "deepNodeCount": deepS.nodeCount,
            "wideNodeCount": wideS.nodeCount,
            "diff": diff,
            "diffTight": diffAXLines(prev: full.lines, next: next.lines, maxChars: 60),
            "maxDepth": AX_MAX_DEPTH,
            "maxNodes": AX_MAX_NODES,
            "valueMax": AX_VALUE_MAX_CHARS,
        ]
        let textDict: [String: Any] = [
            "truncatedChars": (text?["text"] as? String)?.count ?? -1,
            "charCount": text?["charCount"] ?? -1,
            "targetRole": (text?["target"] as? [String: Any])?["role"] ?? "",
            "targetRoleRaw": (text?["target"] as? [String: Any])?["role_raw"] ?? "",
            "targetHasValue": (text?["target"] as? [String: Any])?["value"] != nil,
            "composed": composedPayload?["text_composed"] ?? NSNull(),
            "composedCharCount": composedPayload?["charCount"] ?? -1,
            "secureDropped": makeTextInputPayload(text: "secret", charCount: 6, target: secureTarget, maxChars: cfg.inputTextMaxChars) == nil,
        ]
        let clickDict: [String: Any] = [
            "normal": click ?? [:],
            "secureDropped": makeClickPayload(x: 1, y: 2, button: "left", target: secureTarget) == nil,
        ]
        let shortcutDict: [String: Any] = [
            "normal": shortcut ?? [:],
            "secureDropped": makeShortcutPayload(keyEquivalent: "p", modifiers: ["command"], target: secureTarget) == nil,
        ]
        let selectionDict: [String: Any] = [
            "truncatedChars": (selection?["selectedText"] as? String)?.count ?? -1,
            "range": selection?["selectedRange"] ?? [:],
            "items": selection?["selectedItems"] ?? [],
            "bareAllowed": makeSelectionPayload(selectedText: nil, range: nil, items: [], maxChars: 10,
                                                target: normalTarget, allowBare: true) != nil,
            "bareDropped": makeSelectionPayload(selectedText: nil, range: nil, items: [], maxChars: 10,
                                                target: normalTarget, allowBare: false) == nil,
            "secureDropped": makeSelectionPayload(selectedText: "x", range: nil, items: [], maxChars: 10, target: secureTarget) == nil,
        ]
        let extras: [String: Any] = [
            "axTrusted": axTrusted(),
            "config": cfg.toJSON(),
            "snapshot": fullDict,
            "textInput": textDict,
            "click": clickDict,
            "shortcut": shortcutDict,
            "selection": selectionDict,
            "quality": [
                "roleLocalized": ["button": localizedAXRole("AXButton"), "outline": localizedAXRole("AXOutline"), "empty": localizedAXRole("")],
                "emptyTitleLine": emptyTitleLine,
                "keyMap": keyNames,
                "functionKeyChar": keyEquivalentString(keycode: 123, characters: "\u{F702}"),
                "returnSubmitCheck": returnNeedsSubmitCheck(modifiers: [], hasContent: true),
                "returnShiftShortcut": !returnNeedsSubmitCheck(modifiers: ["shift"], hasContent: true),
                "returnEmptyShortcut": !returnNeedsSubmitCheck(modifiers: [], hasContent: false),
                "returnSettle": [
                    "wechat": returnSettleIsSubmit(afterRole: "", afterHasText: false, beforeRole: ""),
                    "feishu": !returnSettleIsSubmit(afterRole: "AXTextArea", afterHasText: true, beforeRole: "AXTextArea"),
                    "dialog": returnSettleIsSubmit(afterRole: "AXWindow", afterHasText: false, beforeRole: "AXWindow"),
                    "arc": returnSettleIsSubmit(afterRole: "AXTextField", afterHasText: false, beforeRole: "AXTextField"),
                ],
                "returnSettleCheck": [
                    "wechat": returnNeedsSettleCheck(modifiers: [], hasContent: false, roleIsEmpty: true, recentText: true),
                    "feishu": returnNeedsSettleCheck(modifiers: [], hasContent: true, roleIsEmpty: false, recentText: true),
                    "idle": !returnNeedsSettleCheck(modifiers: [], hasContent: false, roleIsEmpty: true, recentText: false),
                    "shift": !returnNeedsSettleCheck(modifiers: ["shift"], hasContent: true, roleIsEmpty: false, recentText: true),
                ],
                "functionModifier": shortcutModifiers(CGEventFlags(rawValue: CGEventFlags.maskSecondaryFn.rawValue)).contains("function"),
                "windowTitles": [
                    "spinnerSame": significantWindowTitle("◐ Claude Code") == significantWindowTitle("✳ Claude Code"),
                    "realChange": significantWindowTitle("微信") != significantWindowTitle("图片和视频"),
                ],
                "windowTransitions": [
                    "untitledNew": windowChangeNeeded(title: "", previousTitle: "", windowId: "1", previousWindowId: "", elementChanged: true, hasWindow: true),
                    "untitledSame": !windowChangeNeeded(title: "", previousTitle: "", windowId: "1", previousWindowId: "1", elementChanged: false, hasWindow: true),
                    "titledChange": windowChangeNeeded(title: "图片和视频", previousTitle: "微信", windowId: "2", previousWindowId: "1", elementChanged: true, hasWindow: true),
                    "spinnerSame": !windowChangeNeeded(title: "✳ Claude Code", previousTitle: "◐ Claude Code", windowId: "1", previousWindowId: "1", elementChanged: false, hasWindow: true),
                    "sameTitleNewWindow": windowChangeNeeded(title: "微信", previousTitle: "微信", windowId: "2", previousWindowId: "1", elementChanged: true, hasWindow: true),
                    "noWindow": !windowChangeNeeded(title: "", previousTitle: "", windowId: "", previousWindowId: "", elementChanged: true, hasWindow: false),
                ],
                "selectionNotifications": SELECTION_AX_NOTIFICATIONS,
                "targetRoleLocalized": normalTargetPayload["role"] ?? "",
                "targetRoleRaw": normalTargetPayload["role_raw"] ?? "",
            ],
            "privacy": [
                "secureRoleDetected": isSecureControl(role: "AXSecureTextField", title: "", description: ""),
                "passwordTitleDetected": isSecureControl(role: "AXTextField", title: "Password", description: ""),
                "secureValueRead": (secureValue as Any?) ?? NSNull(),
                "secureSerializedHasSecret": fullText.contains("secret"),
            ],
            "limits": ["maxEventsPerSegment": MAX_EVENTS_PER_SEGMENT,
                       "axMaxDepth": AX_MAX_DEPTH,
                       "axMaxNodes": AX_MAX_NODES,
                       "axValueMax": AX_VALUE_MAX_CHARS,
                       "clickDedupeMs": Int(CLICK_DEDUPE_SEC * 1000),
                       "textIdleFlushMs": Int(TEXT_IDLE_FLUSH_SEC * 1000)],
        ]
        respond(id: id, ok: true, extra: extras)
    }

    @discardableResult
    private func stopObservation() -> [String: Any] {
        sampleTimer?.cancel()
        sampleTimer = nil
        pauseAutoResumeWork?.cancel()
        pauseAutoResumeWork = nil
        flushTextInput(reason: "stop")
        stopInputMonitor()
        stopActivationObserver()
        resetRichState()
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

    // MARK: 采样（先读样本 → 统一决策 → 只在观察时写内容事件）

    /// 采样主流程（核心隐私闭环）：
    ///   ① secure input（整机）→ 抑制，不读任何内容
    ///   ② app 层 block → 抑制，不读内容
    ///   ③ Safari 手动强制排除 → 抑制，不读内容
    ///   ④ 读浏览器 URL（URL 闸门/无痕检测需要；不落盘）
    ///   ⑤ 统一决策（evaluate）
    ///   ⑥ 只有 observe=true 才读窗口标题/焦点并写内容事件；URL 落盘前脱敏
    private func sampleOnce() {
        guard running, !exited else { return }
        rotateIfDue() // 到期先关段（paused 时也执行；关闭后不新建，等首个事件懒建）
        guard !paused else { return }
        guard let front = NSWorkspace.shared.frontmostApplication,
              let bundleId = front.bundleIdentifier, !bundleId.isEmpty else { return }
        let appName = front.localizedName ?? ""
        let pid = Int(front.processIdentifier)

        // ① secure input（整机安全输入）：整采样抑制——标题/URL/焦点一概不读、不写。
        if secureInputActive() {
            recordSuppressed("sample", scope: "system", reason: "secure-input")
            resetContentDedupe(); resetRichState()
            return
        }

        // ② app 层 block：block 永远赢；不读任何内容，只记审计。
        if config.appBlocked(bundleId) {
            recordSuppressed("sample", scope: "app", reason: "app-blocklist")
            resetContentDedupe(); resetRichState()
            return
        }

        // ③ Safari 手动强制排除（privacy.excludeSafariURLs=true）：不读内容。
        if config.isSafari(bundleId), config.privacy.excludeSafariURLs {
            recordSuppressed("url-change", scope: "url", reason: "safari-url-excluded")
            resetContentDedupe(); resetRichState()
            return
        }

        // ④ 读浏览器原始 URL（统一决策与无痕检测需要；此时尚未读取标题/焦点内容）。
        var rawURL: String? = nil
        var incognito = false
        if config.includeURLs, isBrowser(bundleId) {
            if let got = browserSample(bundleId: bundleId, pid: pid), !got.url.isEmpty {
                rawURL = got.url
                incognito = got.incognito
            }
        }

        // ⑤ 统一决策：URL 被 block / 无痕 / allowlist 不命中 → 该采样不写任何内容事件。
        let decision = config.evaluate(SampleInput(bundleId: bundleId, url: rawURL, incognito: incognito))
        if !decision.observe {
            recordSuppressed("url-change", scope: decision.blockedScope ?? "url", reason: decision.reason)
            resetContentDedupe(); resetRichState()
            return
        }

        // ⑥ 观察成立后才读取并写入内容事件（R1：先建窗口上下文，再写基础/富内容事件）。
        let prevWindowEl = windowElement
        let title = readWindowTitle(pid: pid)
        let winEl = focusedWindowElement(pid: pid)
        let elChanged = !sameWindowElement(prevWindowEl, winEl)
        windowElement = winEl
        var documentPath: String?
        if let win = winEl, let doc = axAttrString(win, "AXDocument" as CFString), !doc.isEmpty { documentPath = doc }
        let winId = config.includeContent ? windowNumberFor(pid: pid, title: title) : nil
        let focus = config.includeFocusedElement ? readFocusedElement(pid: pid) : nil
        let storedURL = (config.includeURLs && isBrowser(bundleId)) ? rawURL.flatMap { config.storedURL($0) } : nil
        let newCtx = Context(bundleId: bundleId, appName: appName, pid: pid, windowTitle: title,
                             storedURL: storedURL, incognito: incognito, windowId: winId,
                             documentPath: documentPath, at: Date())
        let windowChanged = context == nil || context!.bundleId != bundleId
            || context!.windowTitle != title || context!.windowId != winId
            || (title.isEmpty && elChanged)
        if windowChanged { flushTextInput(reason: "window-change") }
        context = newCtx
        updatePresence()

        var emitted = false
        if bundleId != lastBundleId {
            var data: [String: Any] = ["bundleId": bundleId, "appName": appName, "pid": pid]
            if config.includeContent {
                if !title.isEmpty { data["windowTitle"] = title }
                if let u = storedURL { data["url"] = u }
            }
            if bundleId == rotatedBundleId { data["reason"] = "segment-start" } // 换段补记，不是人在切换
            rotatedBundleId = ""
            emit("app-switch", data: data)
            lastBundleId = bundleId
            lastWindowTitle = "" // 换 app 后窗口标题重新观察
            lastWindowId = ""
            emitted = true
        }
        let winIdKey = winId.map(String.init) ?? ""
        let emitWindowChange = windowChangeNeeded(
            title: title, previousTitle: lastWindowTitle,
            windowId: winIdKey, previousWindowId: lastWindowId,
            elementChanged: elChanged, hasWindow: winEl != nil)
        if emitWindowChange {
            var data: [String: Any] = ["bundleId": bundleId, "appName": appName, "pid": pid]
            if !title.isEmpty { data["windowTitle"] = title }
            if config.includeContent {
                if let w = winId { data["windowId"] = w }
                if let d = documentPath { data["documentPath"] = d }
                if let u = storedURL { data["url"] = u }
            }
            emit("window-change", data: data)
            lastWindowTitle = title
            lastWindowId = winIdKey
            emitted = true
            if config.includeContent { emitSnapshotFull() }
        }
        if config.includeContent {
            if config.includeURLs, isBrowser(bundleId) {
                if let u = rawURL {
                    if u != lastURL {
                        let stored = config.storedURL(u) ?? u // 默认去掉 query/fragment；规则匹配用原始 URL
                        emit("url-change", data: ["bundleId": bundleId, "url": stored])
                        lastURL = u
                        emitted = true
                    }
                } else {
                    lastURL = "" // 读不到 URL（Firefox/无窗口）：清掉旧值，读到新值时能发事件
                }
            }
            if let focus = focus {
                if isSecureControl(role: focus.role, title: focus.title, description: "") {
                    lastFocusKey = "" // 密码框期间不产生焦点事件
                } else {
                    let key = "\(focus.role)|\(focus.title)"
                    if key != lastFocusKey {
                        var data: [String: Any] = ["bundleId": bundleId, "role": focus.role]
                        if !focus.title.isEmpty { data["title"] = focus.title }
                        emit("focus-change", data: data)
                        lastFocusKey = key
                        emitted = true
                        selectionMonitor?.refreshFocusTargets(pid: pid_t(pid))
                    }
                }
            }
            maybeStartInputMonitor()
            maybeStartSelectionMonitor(pid: pid)
            if windowChanged { selectionMonitor?.refreshWindowContainers(pid: pid_t(pid)) }
            if lastSnapshotLines == nil { emitSnapshotFull() } // 首个观察 / 段轮转后补 full
            maybeEmitSnapshotDiff()
            pollSelection()
            maybeEmitVisibleWindows(force: emitted)
        }

        if emitted { lastSuppressedKey = "" } // 恢复观察后，下次再进被抑制上下文会重新记一条
    }

    // MARK: 采样辅助

    /// 懒物化段：段对象在 start/轮转时创建，目录在首个记录落盘时才建。
    private func ensureSegment() -> Segment? {
        if segment == nil {
            segment = Segment(root: chronicleHome().appendingPathComponent("segments"))
        }
        return segment
    }

    /// 抑制审计：只记 {ts,type,scope,reason}，不带内容；仅在抑制上下文切换时写一条。
    private func recordSuppressed(_ type: String, scope: String, reason: String) {
        let key = "\(type)|\(scope)|\(reason)"
        guard key != lastSuppressedKey else { return }
        lastSuppressedKey = key
        ensureSegment()?.appendSuppressed(type, scope: scope, reason: reason)
    }

    /// 内容去重状态复位（进入/离开抑制上下文、段轮转后需要重新快照）。
    private func resetContentDedupe() {
        lastWindowTitle = ""
        lastURL = ""
        lastFocusKey = ""
    }

    private func emit(_ type: String, data: [String: Any], at date: Date? = nil) {
        guard let seg = ensureSegment() else { return }
        guard seg.appendEvent(type, data: data, at: date ?? Date()) else { return } // 段满 5000 条后丢弃，不虚增计数
        sessionTotalEvents += 1
        lifetimeTotalEvents += 1
    }


    // MARK: 内容采集（R1）：上下文 / 文本输入 / 点击 / 快捷键 / 选区 / AX 快照

    /// 内容采集是否生效：运行中 + 未暂停 + includeContent + AX 已授权（未授权静默降级）。
    private func richEnabled() -> Bool {
        running && !paused && !exited && config.includeContent && axTrusted()
    }

    /// 当前前台 app 是否仍是事件上下文里的 app（防切 app 后 0-2s 内事件挂错应用）。
    private func frontmostMatches(_ ctx: Context) -> Bool {
        guard let front = NSWorkspace.shared.frontmostApplication,
              let bundleId = front.bundleIdentifier else { return false }
        return bundleId == ctx.bundleId
    }

    private func contextData(_ ctx: Context) -> [String: Any] {
        var d: [String: Any] = ["bundleId": ctx.bundleId,
                                "appName": ctx.appName,
                                "pid": ctx.pid,
                                "windowTitle": ctx.windowTitle]
        if config.includeURLs, let u = ctx.storedURL, !u.isEmpty { d["url"] = u }
        return d
    }

    private func emitRich(_ type: String, extra: [String: Any], ctx: Context? = nil, at date: Date? = nil) {
        guard let c = ctx ?? context else { return }
        var data = contextData(c)
        for (k, v) in extra { data[k] = v }
        emit(type, data: data, at: date)
    }

    private func maybeStartInputMonitor() {
        guard config.includeContent, axTrusted() else { return }
        guard inputMonitor == nil else { return }
        let monitor = InputMonitor()
        monitor.daemon = self
        if monitor.start() {
            inputMonitor = monitor
        } else if !inputMonitorFailedLogged {
            inputMonitorFailedLogged = true
            FileHandle.standardError.write(Data("chronicle-daemon: CGEventTap 不可用（辅助功能权限缺失），点击/键盘事件降级为不采集\n".utf8))
        }
    }

    private func stopInputMonitor() {
        inputMonitor?.stop()
        inputMonitor = nil
    }

    private func maybeStartSelectionMonitor(pid: Int) {
        guard config.includeContent, axTrusted(), pid > 0 else { return }
        if let m = selectionMonitor, m.pid == pid_t(pid), m.isActive { return }
        selectionMonitor?.stop()
        let m = SelectionMonitor()
        m.daemon = self
        selectionMonitor = m.start(pid: pid_t(pid)) ? m : nil
    }

    private func stopSelectionMonitor() {
        for work in selectionDebounce.values { work.cancel() }
        selectionDebounce.removeAll()
        selectionMonitor?.stop()
        selectionMonitor = nil
        lastSelectionKey = ""
    }

    /// 前台 app 切换后立即重采样：选区观察者要跟着新 pid 走（否则最多等 2s）。
    /// 同时听锁屏/解锁/睡眠/唤醒，记成 presence（只记状态，不读内容）。
    private func startActivationObserver() {
        guard activationObserver == nil else { return }
        activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: nil
        ) { [weak self] _ in
            guard let self = self else { return }
            self.stateQueue.async { self.sampleOnce() }
        }
        let ws = NSWorkspace.shared.notificationCenter
        let dist: NotificationCenter = DistributedNotificationCenter.default()
        let watch: [(NotificationCenter, Notification.Name, String)] = [
            (ws, NSWorkspace.willSleepNotification, "sleep"),
            (ws, NSWorkspace.didWakeNotification, "wake"),
            (dist, Notification.Name("com.apple.screenIsLocked"), "locked"),
            (dist, Notification.Name("com.apple.screenIsUnlocked"), "unlocked"),
        ]
        for (center, name, state) in watch {
            let token = center.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in
                guard let self = self else { return }
                self.stateQueue.async { self.recordPresence(state) }
            }
            presenceObservers.append((center, token))
        }
    }

    private func stopActivationObserver() {
        if let o = activationObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(o)
        }
        activationObserver = nil
        for (center, token) in presenceObservers { center.removeObserver(token) }
        presenceObservers = []
    }

    /// 在场状态：键鼠空闲 ≥ PRESENCE_IDLE_SEC 记 idle，回来记 active；每段开头补报一次，
    /// 让每段自带「有没有人」。只在已过隐私门的采样里调用（context 刚更新），只带应用名。
    private func updatePresence() {
        guard richEnabled(), let c = context else { return }
        let idleSec = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
        let idle = idleSec >= PRESENCE_IDLE_SEC
        if presenceAnnounced && idle == presenceIdle { return }
        emit("presence", data: ["state": idle ? "idle" : "active", "idleSec": Int(idleSec),
                                "reason": presenceAnnounced ? "change" : "segment-start",
                                "bundleId": c.bundleId, "appName": c.appName])
        presenceIdle = idle
        presenceAnnounced = true
    }

    /// 锁屏/解锁/睡眠/唤醒：前台仍是最近一次过了隐私门的应用时才记（blocklist 应用在前台时不写）。
    private func recordPresence(_ state: String) {
        guard richEnabled(), let c = context, frontmostMatches(c) else { return }
        if state == "locked" || state == "sleep" { flushTextInput(reason: state) }
        emit("presence", data: ["state": state, "reason": "system", "bundleId": c.bundleId, "appName": c.appName])
    }

    /// 文本区值变化（AXValueChanged）：强制一次 AX diff，捕捉终端/编辑器的快速输出。
    func handleValueChanged() {
        guard richEnabled(), let ctx = context else { return }
        if secureInputActive() { return }
        guard frontmostMatches(ctx) else { return }
        maybeEmitSnapshotDiff(force: true)
    }

    /// 滚轮输入：按 2s 窗口聚合；停止 0.9s 或窗口到点即 flush，避免高频事件刷爆段。
    func handleScroll(dx: Double, dy: Double) {
        guard richEnabled(), let ctx = context, frontmostMatches(ctx) else { return }
        if secureInputActive() { return }
        let now = Date()
        if scrollStartedAt == nil { scrollStartedAt = now }
        scrollDx += dx
        scrollDy += dy
        scrollTicks += 1
        if let started = scrollStartedAt, now.timeIntervalSince(started) >= 2.0 {
            flushScroll()
            return
        }
        scrollFlushWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.flushScroll() }
        scrollFlushWork = work
        stateQueue.asyncAfter(deadline: .now() + 0.9, execute: work)
    }

    private func flushScroll() {
        scrollFlushWork?.cancel()
        scrollFlushWork = nil
        guard scrollTicks > 0 else { return }
        let dx = scrollDx, dy = scrollDy, ticks = scrollTicks, started = scrollStartedAt
        scrollDx = 0; scrollDy = 0; scrollTicks = 0; scrollStartedAt = nil
        guard richEnabled(), let ctx = context, frontmostMatches(ctx), !secureInputActive() else { return }
        let horizontal = abs(dx) > abs(dy) * 1.5
        let direction = horizontal ? (dx > 0 ? "left" : "right") : (dy > 0 ? "up" : "down")
        var payload: [String: Any] = [
            "direction": direction,
            "deltaX": Int(dx.rounded()),
            "deltaY": Int(dy.rounded()),
            "ticks": ticks,
        ]
        if let started = started {
            payload["durationMs"] = Int(Date().timeIntervalSince(started) * 1000)
        }
        emitRich("scroll", extra: payload, ctx: ctx)
    }

    /// AX 标题/焦点窗口通知：非浏览器 app 的即时 window-change，不再等 2s 采样。
    /// 浏览器仍走常规采样，保证 URL/无痕判定完整。
    func handleWindowNotification() {
        guard richEnabled(), let ctx = context else { return }
        if secureInputActive() { return }
        guard frontmostMatches(ctx) else { return }
        if isBrowser(ctx.bundleId) { return }
        let decision = config.evaluate(SampleInput(bundleId: ctx.bundleId, url: ctx.storedURL, incognito: ctx.incognito))
        guard decision.observe else { return }
        let title = readWindowTitle(pid: ctx.pid)
        let win = focusedWindowElement(pid: ctx.pid)
        let elChanged = !sameWindowElement(windowElement, win)
        let winId = config.includeContent ? windowNumberFor(pid: ctx.pid, title: title) : nil
        guard windowChangeNeeded(title: title, previousTitle: ctx.windowTitle,
                                 windowId: winId.map(String.init) ?? "",
                                 previousWindowId: lastWindowId,
                                 elementChanged: elChanged, hasWindow: win != nil) else { return }

        flushTextInput(reason: "window-notify")
        var newCtx = ctx
        newCtx.windowTitle = title
        newCtx.windowId = winId
        newCtx.at = Date()
        if let win = win {
            newCtx.documentPath = axAttrString(win, "AXDocument" as CFString).flatMap { $0.isEmpty ? nil : $0 }
        }
        context = newCtx
        windowElement = win

        var data: [String: Any] = ["bundleId": ctx.bundleId, "appName": ctx.appName, "pid": ctx.pid]
        if !title.isEmpty { data["windowTitle"] = title }
        if let w = newCtx.windowId { data["windowId"] = w }
        if let d = newCtx.documentPath { data["documentPath"] = d }
        if let u = newCtx.storedURL { data["url"] = u }
        emit("window-change", data: data)
        lastWindowTitle = title
        lastWindowId = newCtx.windowId.map(String.init) ?? ""
        lastFocusKey = ""
        lastSnapshotLines = nil
        lastSnapshotWindowKey = ""
        lastSnapshotAt = nil
        lastSelectionKey = ""
        emitSnapshotFull()
    }

    /// AX 通知 → 防抖 → 读取选区（全部在 stateQueue 上，避免主线程做 AX 读）。
    func handleSelectionNotification(element: AXUIElement, notification: String, pid: Int) {
        guard pid > 0, let m = selectionMonitor, m.isActive, m.pid == pid_t(pid) else { return }
        let key = "\(pid)|\(notification)|\(Unmanaged.passUnretained(element).toOpaque())"
        let notifiedAt = Date()
        selectionDebounce[key]?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.selectionDebounce.removeValue(forKey: key)
            self?.captureSelection(element: element, at: notifiedAt)
        }
        selectionDebounce[key] = work
        stateQueue.asyncAfter(deadline: .now() + SELECTION_DEBOUNCE_SEC, execute: work)
    }

    /// 读取通知元素的选区内容：selectedText / selectedRange / selectedItems，
    /// 三者都没有时保留 target（参考实现的 bare selection 事件同口径）。
    private func captureSelection(element: AXUIElement, at notifiedAt: Date) {
        guard richEnabled(), let ctx = context else { return }
        if secureInputActive() { return }
        guard frontmostMatches(ctx) else { return }
        let elPid = axAttrPID(element) ?? ctx.pid
        guard elPid == ctx.pid else { return }
        AXUIElementSetMessagingTimeout(element, 0.5)
        let role = axAttrString(element, kAXRoleAttribute as CFString) ?? ""
        guard !role.isEmpty else { return }
        let title = axAttrString(element, kAXTitleAttribute as CFString) ?? ""
        let desc = axAttrString(element, kAXDescriptionAttribute as CFString) ?? ""
        if isSecureControl(role: role, title: title, description: desc) { return }
        // 后台窗口的选区不记到前台窗口上（窗口标题不一致就跳过）。
        if let win = axAttrElement(element, kAXWindowAttribute as CFString),
           let winTitle = axAttrString(win, kAXTitleAttribute as CFString),
           !winTitle.isEmpty, !ctx.windowTitle.isEmpty, winTitle != ctx.windowTitle {
            return
        }
        var selectedText: String?
        if let raw = axAttrString(element, "AXSelectedText" as CFString), !raw.isEmpty { selectedText = raw }
        let selected = selectedItemPayloads(element)
        let target = TargetInfo(role: role, title: title, description: desc, value: nil, secure: false)
        emitSelection(target: target, selectedText: selectedText, range: axSelectedRange(element),
                      items: selected.items, itemsIdentity: selected.identity, allowBare: true, at: notifiedAt)
    }

    /// 选区事件统一出口：同一上下文/目标/内容只落一条（观察者与轮询兜底不重复）。
    private func emitSelection(target: TargetInfo, selectedText: String?,
                               range: (location: Int, length: Int)?, items: [[String: Any]],
                               itemsIdentity: String = "", allowBare: Bool, at date: Date? = nil) {
        guard richEnabled() else { return }
        guard let payload = makeSelectionPayload(selectedText: selectedText, range: range, items: items,
                                                 maxChars: config.selectionMaxChars, target: target,
                                                 allowBare: allowBare) else {
            lastSelectionKey = ""
            return
        }
        let itemsKey = items.map { "\($0["role"] ?? "")|\($0["title"] ?? "")" }.joined(separator: ",")
        let rangeKey = range.map { "\($0.location),\($0.length)" } ?? ""
        let ctxKey = "\(context?.bundleId ?? "")|\(context?.windowTitle ?? "")"
        let key = "\(ctxKey)|\(target.role)|\(target.title)|\(selectedText ?? "")|\(rangeKey)|\(itemsKey)|\(itemsIdentity)"
        guard key != lastSelectionKey else { return }
        lastSelectionKey = key
        emitRich("selection", extra: payload, at: date)
    }

    /// Return 后 250ms 复查目标 AXValue：被清空 → submit；仍有内容（换行/终端继续）→ shortcut。
    /// 这就是参考实现里 “Feishu/终端 Return 记 shortcut、聊天框发送记 submit” 的区分方式。
    private func scheduleReturnClassification(target: TargetInfo, ctx: Context, pressedAt: Date) {
        let work = DispatchWorkItem { [weak self] in
            guard let self = self, self.richEnabled(), self.frontmostMatches(ctx) else { return }
            let after = self.focusedElementSnapshot(pid: ctx.pid, valueMax: self.config.inputTextMaxChars)
            // 只有「同一个文本类控件且文本仍在」才是 shortcut（飞书换行/终端/编辑器）；
            // after 消失、role 为空/变化、非文本控件（对话框/按钮）、文本被清空 → submit。
            let afterRole = after?.target.role ?? ""
            let stillHasText = after?.rawValue?.isEmpty == false
            let cleared = returnSettleIsSubmit(afterRole: afterRole, afterHasText: stillHasText,
                                               beforeRole: target.role)
            if cleared {
                let t = after?.target ?? target
                guard !t.secure else { return }
                var extra: [String: Any] = ["keyEquivalent": "return"]
                if !t.role.isEmpty { extra["target"] = makeTargetPayload(t) }
                self.emitRich("submit", extra: extra, ctx: ctx, at: pressedAt)
            } else {
                let t = after?.target ?? target
                guard let payload = makeShortcutPayload(keyEquivalent: "return", modifiers: [], target: t) else { return }
                self.emitRich("shortcut", extra: payload, ctx: ctx, at: pressedAt)
            }
            self.maybeEmitSnapshotDiff(force: true)
        }
        stateQueue.asyncAfter(deadline: .now() + RETURN_SETTLE_SEC, execute: work)
    }

    private func discardPendingText() {
        textFlushWork?.cancel()
        textFlushWork = nil
        pendingText = ""
        pendingTarget = nil
        pendingContext = nil
    }

    private func scheduleTextFlush() {
        textFlushWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.flushTextInput(reason: "idle") }
        textFlushWork = work
        stateQueue.asyncAfter(deadline: .now() + TEXT_IDLE_FLUSH_SEC, execute: work)
    }

    /// 空闲/提交/失焦/暂停/段轮转时 flush 文本输入（密码控件与 secure input 一律丢弃）。
    private func flushTextInput(reason: String) {
        textFlushWork?.cancel()
        textFlushWork = nil
        let raw = pendingText
        var charCount = pendingText.count
        var target = pendingTarget
        let ctx = pendingContext
        pendingText = ""
        pendingTarget = nil
        pendingContext = nil
        guard !raw.isEmpty, let initialTarget = target, let c = ctx else { return }
        guard richEnabled(), !initialTarget.secure, !secureInputActive() else { return }
        guard frontmostMatches(c) else { return }

        // S2：flush 时读焦点元素当前 AXValue —— 更新 target.value、charCount，并提取 IME 合成结果。
        var composed: String? = nil
        if let snap = focusedElementSnapshot(pid: c.pid, valueMax: config.inputTextMaxChars) {
            if snap.target.secure { return } // 期间焦点进了密码框：整条丢弃
            target = snap.target
            if let axValue = snap.rawValue, !axValue.isEmpty {
                charCount = axValue.count
                let rawIsASCII = raw.unicodeScalars.allSatisfy { $0.value < 0x80 }
                let composedHasWide = axValue.unicodeScalars.contains { $0.value > 0x7F }
                if rawIsASCII, composedHasWide, axValue != raw {
                    composed = axValue // 拼音 keyDown → 合成后的中文（只放 text_composed，不改 text 原文）
                }
            }
        }
        guard let payload = makeTextInputPayload(text: raw, charCount: charCount, target: target ?? initialTarget,
                                                 maxChars: config.inputTextMaxChars, composed: composed) else { return }
        emitRich("text-input", extra: payload, ctx: c)
        maybeEmitSnapshotDiff(force: true)
    }

    /// 焦点控件 + 完整 AXValue（text-input flush 用；密码类 value 不读，返回 nil rawValue）。
    private func focusedElementSnapshot(pid expectedPid: Int, valueMax: Int) -> (target: TargetInfo, rawValue: String?)? {
        let sys = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(sys, 0.6)
        guard let focused = axAttrElement(sys, kAXFocusedUIElementAttribute as CFString) else { return nil }
        if let actualPid = axAttrPID(focused), actualPid != expectedPid { return nil }
        let role = axAttrString(focused, kAXRoleAttribute as CFString) ?? ""
        guard !role.isEmpty else { return nil }
        let title = axAttrString(focused, kAXTitleAttribute as CFString) ?? ""
        let desc = axAttrString(focused, kAXDescriptionAttribute as CFString) ?? ""
        let secure = isSecureControl(role: role, title: title, description: desc)
        let rawValue = secure ? nil : axAttrString(focused, kAXValueAttribute as CFString)
        let shownValue = rawValue.flatMap { raw -> String? in
            let line = axOneLine(raw, maxLen: valueMax)
            return line.isEmpty ? nil : line
        }
        return (TargetInfo(role: role, title: title, description: desc, value: shownValue, secure: secure), rawValue)
    }

    /// 当前系统焦点控件（仅当前前台 app；密码类 value 不读）。
    private func currentFocusedTarget() -> TargetInfo? {
        let sys = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(sys, 0.6)
        guard let focused = axAttrElement(sys, kAXFocusedUIElementAttribute as CFString) else { return nil }
        if let pid = axAttrPID(focused), let ctx = context, pid != ctx.pid { return nil }
        let role = axAttrString(focused, kAXRoleAttribute as CFString) ?? ""
        guard !role.isEmpty else { return nil }
        let title = axAttrString(focused, kAXTitleAttribute as CFString) ?? ""
        let desc = axAttrString(focused, kAXDescriptionAttribute as CFString) ?? ""
        let secure = isSecureControl(role: role, title: title, description: desc)
        let rawValue = secure ? nil : axAttrString(focused, kAXValueAttribute as CFString)
        return TargetInfo(role: role, title: title, description: desc,
                          value: safeTargetValue(role: role, title: title, description: desc, rawValue: rawValue),
                          secure: secure)
    }

    private func targetFromElement(_ el: AXUIElement) -> TargetInfo {
        let role = axAttrString(el, kAXRoleAttribute as CFString) ?? ""
        let title = axAttrString(el, kAXTitleAttribute as CFString) ?? ""
        let desc = axAttrString(el, kAXDescriptionAttribute as CFString) ?? ""
        let secure = isSecureControl(role: role, title: title, description: desc)
        let rawValue = secure ? nil : axAttrString(el, kAXValueAttribute as CFString)
        return TargetInfo(role: role, title: title, description: desc,
                          value: safeTargetValue(role: role, title: title, description: desc, rawValue: rawValue),
                          secure: secure)
    }

    private func keyEquivalentString(keycode: Int, characters: String) -> String {
        let trimmed = characters.trimmingCharacters(in: .whitespacesAndNewlines)
        // CGEvent 有字符时优先（字母统一小写，与既有的 macOS 快捷键文案一致）。
        // Fn/方向键会带 U+F700–F8FF 私有区字符，必须落回键名表，不能当文本。
        if let scalar = trimmed.unicodeScalars.first, scalar.value >= 0x20,
           scalar.value != 0x7F, !(0xF700...0xF8FF).contains(scalar.value) {
            return trimmed.lowercased()
        }
        if let name = KEYCODE_NAMES[keycode] {
            // 控制键组合（Ctrl+Z 等）没有可打印字符：字母键统一小写，与其他快捷键文案一致。
            if name.count == 1, let c = name.first, c.isLetter { return name.lowercased() }
            return name
        }
        return "keycode-\(keycode)"
    }

    private func shortcutModifiers(_ flags: CGEventFlags) -> [String] {
        var out: [String] = []
        if flags.contains(.maskCommand) { out.append("command") }
        if flags.contains(.maskAlternate) { out.append("option") }
        if flags.contains(.maskControl) { out.append("control") }
        if flags.contains(.maskShift) { out.append("shift") }
        if flags.contains(.maskSecondaryFn) { out.append("function") }
        return out
    }

    private func emptyTarget() -> TargetInfo {
        TargetInfo(role: "", title: "", description: "", value: nil, secure: false)
    }

    /// 键盘：回车提交/快捷键 / 方向键等非文本键快捷键 / command|control 快捷键 /
    /// 其余累积为文本（500ms 空闲或提交/失焦/点击/上限 flush）。
    /// 口径对齐参考实现：delete/return/方向键/tab/esc 等全部记 shortcut，
    /// Return 仅在「无修饰键 + 有待提交文本」时记 submit。
    func handleKeyInput(keycode: Int, flagsRaw: UInt64, characters: String) {
        guard richEnabled(), let ctx = context, frontmostMatches(ctx) else { return }
        let inputAt = Date()
        if secureInputActive() { discardPendingText(); return }
        if MODIFIER_KEYCODES.contains(keycode) { return }
        let flags = CGEventFlags(rawValue: flagsRaw)
        let hasCommand = flags.contains(.maskCommand)
        let hasControl = flags.contains(.maskControl)
        let modifiers = shortcutModifiers(flags)

        if keycode == 36 || keycode == 76 { // return / keypad enter
            let hadPending = !pendingText.isEmpty
            flushTextInput(reason: hadPending ? "submit" : "shortcut")
            let snap = focusedElementSnapshot(pid: ctx.pid, valueMax: config.inputTextMaxChars)
            let target = snap?.target ?? currentFocusedTarget() ?? emptyTarget()
            guard !target.secure else { return }
            let hasContent = hadPending || !(snap?.rawValue ?? "").isEmpty
            let recentText = lastTextInputAt.map { inputAt.timeIntervalSince($0) < 5 } ?? false
            let isActionRole = !hasContent && !target.role.isEmpty && RETURN_ACTION_ROLES.contains(target.role)
            if isActionRole {
                emitRich("submit", extra: ["keyEquivalent": "return", "target": makeTargetPayload(target)],
                         ctx: ctx, at: inputAt)
                maybeEmitSnapshotDiff(force: true)
            } else if returnNeedsSettleCheck(modifiers: modifiers, hasContent: hasContent,
                                             roleIsEmpty: target.role.isEmpty, recentText: recentText) {
                scheduleReturnClassification(target: target, ctx: ctx, pressedAt: inputAt)
            } else {
                guard let payload = makeShortcutPayload(keyEquivalent: "return", modifiers: modifiers, target: target) else { return }
                emitRich("shortcut", extra: payload, ctx: ctx)
                maybeEmitSnapshotDiff(force: true)
            }
            return
        }
        if let nav = NAV_KEY_NAMES[keycode] {
            flushTextInput(reason: "shortcut")
            let target = currentFocusedTarget() ?? emptyTarget()
            guard let payload = makeShortcutPayload(keyEquivalent: nav, modifiers: modifiers, target: target) else { return }
            emitRich("shortcut", extra: payload, ctx: ctx)
            maybeEmitSnapshotDiff(force: true)
            return
        }
        if hasCommand || hasControl {
            flushTextInput(reason: "shortcut")
            let target = currentFocusedTarget() ?? emptyTarget()
            let key = keyEquivalentString(keycode: keycode, characters: characters)
            guard !key.isEmpty else { return }
            // 粘贴也会往输入框填入文本：更新“最近文本”时间，后续 Return 才能按 submit 复查。
            if key.lowercased() == "v" { lastTextInputAt = inputAt }
            guard let payload = makeShortcutPayload(keyEquivalent: key, modifiers: modifiers, target: target) else { return }
            emitRich("shortcut", extra: payload, ctx: ctx)
            maybeEmitSnapshotDiff(force: true)
            return
        }
        // 文本输入：仅收可打印字符（导航/删除键已在上方记 shortcut）。
        guard !characters.isEmpty else { return }
        let printable = characters.unicodeScalars.filter {
            $0.value >= 0x20 && $0.value != 0x7F && !(0xF700...0xF8FF).contains($0.value)
        }
        guard !printable.isEmpty else { return }
        if pendingText.isEmpty {
            // 有些 app（如微信）读不到焦点控件，但用户仍在本 app 前台输入：
            // 与参考实现一致，允许 target 为空继续累积文本；密码风险由 secure input 全局闸门兜底。
            let target = currentFocusedTarget()
            if let t = target, t.secure { return }
            pendingTarget = target ?? emptyTarget()
            pendingContext = ctx
        }
        pendingText += String(String.UnicodeScalarView(printable))
        lastTextInputAt = inputAt
        if pendingText.count >= config.inputTextMaxChars { flushTextInput(reason: "limit"); return }
        scheduleTextFlush()
    }

    /// 鼠标按下：AX 命中控件 → click；命中密码控件/其他 app/无 AX → 静默跳过；80ms 同点去重。
    func handleMouseInput(x: Double, y: Double, button: String) {
        guard richEnabled(), let ctx = context, frontmostMatches(ctx) else { return }
        if secureInputActive() { return }
        let now = Date()
        if let last = lastClick, now.timeIntervalSince(last.at) < CLICK_DEDUPE_SEC,
           last.button == button,
           abs(last.x - x) < CLICK_DEDUPE_DISTANCE, abs(last.y - y) < CLICK_DEDUPE_DISTANCE { return }
        lastClick = (now, x, y, button)
        let sys = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(sys, 0.5)
        var ref: AXUIElement?
        guard AXUIElementCopyElementAtPosition(sys, Float(x), Float(y), &ref) == .success, let el = ref else { return }
        if let elPid = axAttrPID(el), elPid != ctx.pid { return }
        let target = targetFromElement(el)
        // 点击命中点的容器祖先（Arc 侧栏 Outline、网页表格等）先订阅；
        // 150ms 后补读一次选中项，兜住“AX 通知早于订阅”的首次点击。
        let containers = selectionMonitor?.registerAncestors(of: el) ?? []
        for container in containers {
            // Arc 的 tab 切换会先发窗口变化、约 0.8s 后才更新 AX 选中项；
            // 1.0s 后补读一次，避免读到点击前的旧选中。
            stateQueue.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                self?.captureSelection(element: container, at: now)
            }
        }
        flushTextInput(reason: button == "right" ? "context-menu" : "click")
        guard let payload = makeClickPayload(x: x, y: y, button: button, target: target) else { return }
        mouseDownState = (now, x, y, button, target)
        if button == "right" {
            emitRich("context-menu", extra: payload, ctx: ctx)
        } else {
            emitRich("click", extra: payload, ctx: ctx)
        }
        maybeEmitSnapshotDiff(force: true)
        pollSelection(force: true)
    }

    /// 鼠标抬起：同按钮按下后位移 ≥5pt → drag（origin/destination + 坐标）。
    func handleMouseUp(x: Double, y: Double, button: String) {
        guard richEnabled(), let ctx = context, frontmostMatches(ctx) else { return }
        guard let start = mouseDownState, start.button == button,
              start.at.timeIntervalSinceNow > -30 else {
            mouseDownState = nil
            return
        }
        mouseDownState = nil
        if secureInputActive() { return }
        let dx = x - start.x, dy = y - start.y
        guard dx * dx + dy * dy >= DRAG_MIN_DISTANCE * DRAG_MIN_DISTANCE else { return }
        let sys = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(sys, 0.5)
        var ref: AXUIElement?
        guard AXUIElementCopyElementAtPosition(sys, Float(x), Float(y), &ref) == .success,
              let el = ref else { return }
        if let elPid = axAttrPID(el), elPid != ctx.pid { return }
        let dest = targetFromElement(el)
        guard !start.target.secure, !dest.secure else { return }
        let payload: [String: Any] = [
            "from": ["x": Int(start.x.rounded()), "y": Int(start.y.rounded())],
            "to": ["x": Int(x.rounded()), "y": Int(y.rounded())],
            "button": button,
            "origin": makeTargetPayload(start.target),
            "destination": makeTargetPayload(dest),
        ]
        emitRich("drag", extra: payload, ctx: ctx)
        maybeEmitSnapshotDiff(force: true)
    }

    private func axSelectedElements(_ el: AXUIElement?, attribute: String, max: Int = 20) -> [AXUIElement] {
        guard let el = el else { return [] }
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attribute as CFString, &ref) == .success,
              let arr = ref as? [Any] else { return [] }
        return arr.prefix(Swift.max(0, max)).compactMap { asAXElementAny($0) }
    }

    /// 选中项：Outline/Menu 用 AXSelectedChildren，Table 用 AXSelectedRows/Columns，
    /// 按元素身份去重（空标题的不同行不能合并）；密码类子项跳过。
    /// identity 用于事件去重，避免两个空标题选中项被当成同一状态。
    private func selectedItemPayloads(_ el: AXUIElement?) -> (items: [[String: Any]], identity: String) {
        var out: [[String: Any]] = []
        var seen = Set<CFHashCode>()
        var ids: [String] = []
        for attr in ["AXSelectedChildren", "AXSelectedRows", "AXSelectedColumns", "AXSelectedCells"] {
            for child in axSelectedElements(el, attribute: attr) {
                let hash = CFHash(child)
                guard seen.insert(hash).inserted else { continue }
                let t = targetFromElement(child)
                if t.secure { continue }
                // Arc/浏览器侧栏行本身没有 title，文字在子按钮里；向下找一层补标签。
                let label = selectedElementLabel(child, t)
                out.append(["role": t.role, "title": label, "description": t.description])
                // 有标签时用稳定的 role|label 做身份；空标题行才退回 CFHash。
                ids.append(label.isEmpty ? String(hash) : "\(t.role)|\(label)")
                if out.count >= 20 { return (out, ids.joined(separator: ",")) }
            }
        }
        return (out, ids.joined(separator: ","))
    }

    private func selectedElementLabel(_ el: AXUIElement, _ t: TargetInfo, depth: Int = 0) -> String {
        if !t.title.isEmpty { return t.title }
        if !t.description.isEmpty { return t.description }
        if !t.secure, let v = t.value, !v.isEmpty { return v }
        guard depth < 2 else { return "" }
        for child in axChildElements(el, max: 8) {
            let label = selectedElementLabel(child, targetFromElement(child), depth: depth + 1)
            if !label.isEmpty { return label }
        }
        return ""
    }

    /// 选区轮询兜底（AXObserver 不可用时）：每次采样/点击后读一次，内容变化才发；
    /// 与观察者事件共享 lastSelectionKey 去重，不会重复落盘。
    private func pollSelection(force: Bool = false) {
        guard richEnabled(), let ctx = context, frontmostMatches(ctx) else { return }
        // 轮询节流：常规 0.6s 一次；点击后 force 允许更快（最少 0.2s）
        let minInterval: TimeInterval = force ? 0.2 : 0.6
        if let last = lastSelectionPollAt, Date().timeIntervalSince(last) < minInterval { return }
        lastSelectionPollAt = Date()
        if secureInputActive() { return }
        let sys = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(sys, 0.5)
        guard let focused = axAttrElement(sys, kAXFocusedUIElementAttribute as CFString) else { return }
        if let pid = axAttrPID(focused), pid != ctx.pid { return }
        guard let target = currentFocusedTarget(), !target.secure else { return }
        var selectedText: String?
        if let raw = axAttrString(focused, "AXSelectedText" as CFString), !raw.isEmpty { selectedText = raw }
        let selected = selectedItemPayloads(focused)
        emitSelection(target: target, selectedText: selectedText, range: axSelectedRange(focused),
                      items: selected.items, itemsIdentity: selected.identity, allowBare: false)
    }

    // MARK: AX 快照

    private func focusedWindowElement(pid: Int) -> AXUIElement? {
        guard pid > 0 else { return nil }
        let appElem = AXUIElementCreateApplication(pid_t(pid))
        AXUIElementSetMessagingTimeout(appElem, 1.0)
        return axAttrElement(appElem, kAXFocusedWindowAttribute as CFString)
            ?? axAttrElement(appElem, kAXMainWindowAttribute as CFString)
    }

    private func sameWindowElement(_ a: AXUIElement?, _ b: AXUIElement?) -> Bool {
        switch (a, b) {
        case (nil, nil): return true
        case let (x?, y?): return CFEqual(x, y)
        default: return false
        }
    }

    /// 公开 API 拿窗口号：CGWindowList 里按 pid + 标题匹配（AX 无公开 windowNumber 属性）。
    private func windowNumberFor(pid: Int, title: String) -> Int? {
        guard pid > 0 else { return nil }
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        var fallback: Int?
        for w in windows {
            guard let owner = w[kCGWindowOwnerPID as String] as? Int, owner == pid else { continue }
            if let layer = w[kCGWindowLayer as String] as? Int, layer != 0 { continue }
            let num = (w[kCGWindowNumber as String] as? NSNumber)?.intValue ?? -1
            guard num > 0 else { continue }
            let name = (w[kCGWindowName as String] as? String) ?? ""
            if !title.isEmpty, name == title { return num }
            if fallback == nil { fallback = num }
        }
        return fallback
    }

    /// 屏幕可见窗口：只听屏幕表面（不读像素），用于发现“开了什么但没聚焦”的工作面。
    /// 隐私：浏览器窗口交给前台 URL/无痕闸门；blocklist 应用、空标题、浮层/小窗一律跳过。
    private func visibleWindowEntries() -> [[String: Any]] {
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
        let ownPid = Int(ProcessInfo.processInfo.processIdentifier)
        var seen = Set<String>()
        var entries: [[String: Any]] = []
        for w in windows {
            guard let ownerPid = w[kCGWindowOwnerPID as String] as? Int, ownerPid != ownPid else { continue }
            guard let layer = w[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
            let bounds = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
            let width = (bounds["Width"] as? NSNumber)?.doubleValue ?? 0
            let height = (bounds["Height"] as? NSNumber)?.doubleValue ?? 0
            guard width >= 240, height >= 160 else { continue }
            // 没有屏幕录制权限时 kCGWindowName 会被系统抹掉；窗口清单仍按 app/窗口号工作。
            let name = (w[kCGWindowName as String] as? String) ?? ""
            let app = NSRunningApplication(processIdentifier: pid_t(ownerPid))
            let bundleId = app?.bundleIdentifier ?? ""
            guard !bundleId.isEmpty else { continue }
            if bundleId == Bundle.main.bundleIdentifier || isBrowser(bundleId) || config.appBlocked(bundleId) { continue }
            let num = (w[kCGWindowNumber as String] as? NSNumber)?.intValue ?? -1
            let key = "\(bundleId)|\(num)"
            guard num > 0, !seen.contains(key) else { continue }
            seen.insert(key)
            var entry: [String: Any] = [
                "bundleId": bundleId,
                "appName": app?.localizedName ?? ((w[kCGWindowOwnerName as String] as? String) ?? ""),
                "width": Int(width.rounded()),
                "height": Int(height.rounded()),
            ]
            if !name.isEmpty { entry["title"] = name }
            entries.append(entry)
            if entries.count >= 16 { break }
        }
        return entries
    }

    private func maybeEmitVisibleWindows(force: Bool = false) {
        guard richEnabled() else { return }
        let now = Date()
        if !force, let last = lastVisibleWindowsAt, now.timeIntervalSince(last) < 30 { return }
        lastVisibleWindowsAt = now
        let windows = visibleWindowEntries()
        guard !windows.isEmpty else { return }
        let digest = windows.map { "\($0["bundleId"] as? String ?? "")|\($0["appName"] as? String ?? "")|\($0["title"] as? String ?? "")" }
            .sorted().joined(separator: "\n")
        if digest == lastVisibleWindowsDigest, let emittedAt = lastVisibleWindowsEmitAt,
           now.timeIntervalSince(emittedAt) < 600 { return }
        lastVisibleWindowsDigest = digest
        lastVisibleWindowsEmitAt = now
        emitRich("visible-windows", extra: ["count": windows.count, "windows": windows])
    }

    private func captureWindowSnapshot() -> (lines: [String], count: Int)? {
        guard let win = windowElement else { return nil }
        func attempt(forceBulk: Bool) -> AXSnapshotSerialized? {
            var budget = AX_MAX_NODES
            guard let root = captureAXNode(win, depth: 0, maxDepth: AX_MAX_DEPTH,
                                           budget: &budget, valueMax: AX_VALUE_MAX_CHARS,
                                           forceBulk: forceBulk) else { return nil }
            let serialized = serializeAXSnapshot(root)
            return serialized.lines.isEmpty ? nil : serialized
        }
        var best = attempt(forceBulk: false)
        // 树太浅（微信等）→ 用 AXUIElementCopyAttributeValues 补一遍，取节点更多者
        if (best?.nodeCount ?? 0) < AX_SHALLOW_TREE_NODES {
            if let bulk = attempt(forceBulk: true), bulk.nodeCount > (best?.nodeCount ?? 0) { best = bulk }
        }
        guard let result = best else { return nil }
        return (result.lines, result.nodeCount)
    }

    private func emitSnapshotFull() {
        guard richEnabled(), let ctx = context, let cap = captureWindowSnapshot() else { return }
        lastSnapshotLines = cap.lines
        lastSnapshotWindowKey = "\(ctx.bundleId)|\(ctx.windowTitle)|\(ctx.windowId ?? 0)"
        lastSnapshotAt = Date()
        let text = cap.lines.joined(separator: "\n")
        emitRich("ax-snapshot", extra: makeAXSnapshotPayload(mode: "full", text: text, nodeCount: cap.count, maxChars: config.contentMaxChars), ctx: ctx)
    }

    private func maybeEmitSnapshotDiff(force: Bool = false) {
        guard richEnabled(), let ctx = context, let prev = lastSnapshotLines else { return }
        let key = "\(ctx.bundleId)|\(ctx.windowTitle)|\(ctx.windowId ?? 0)"
        guard key == lastSnapshotWindowKey else { return }
        let minInterval = force ? AX_FORCE_SNAPSHOT_MIN_INTERVAL_SEC : AX_SNAPSHOT_MIN_INTERVAL_SEC
        if let lastAt = lastSnapshotAt, Date().timeIntervalSince(lastAt) < minInterval { return }
        guard let cap = captureWindowSnapshot() else { return }
        lastSnapshotAt = Date()
        guard cap.lines != prev else { return }
        let diff = diffAXLines(prev: prev, next: cap.lines, maxChars: config.diffMaxChars)
        lastSnapshotLines = cap.lines
        guard !diff.isEmpty else { return }
        emitRich("ax-snapshot", extra: makeAXSnapshotPayload(mode: "diff", text: diff, nodeCount: cap.count, maxChars: config.diffMaxChars), ctx: ctx)
    }

    /// 清空内容采集的瞬时状态（抑制上下文/段轮转/停止时调用；不触碰事件计数）。
    private func resetRichState() {
        discardPendingText()
        lastTextInputAt = nil
        stopSelectionMonitor()
        lastClick = nil
        mouseDownState = nil
        lastSelectionPollAt = nil
        lastSnapshotLines = nil
        lastSnapshotWindowKey = ""
        lastSnapshotAt = nil
        lastWindowId = ""
        scrollFlushWork?.cancel()
        scrollFlushWork = nil
        scrollDx = 0; scrollDy = 0; scrollTicks = 0; scrollStartedAt = nil
        context = nil
        windowElement = nil
    }

    private func readWindowTitle(pid: Int) -> String {
        guard pid > 0 else { return "" }
        let appElem = AXUIElementCreateApplication(pid_t(pid))
        AXUIElementSetMessagingTimeout(appElem, 1.0)
        var win = axAttrElement(appElem, kAXFocusedWindowAttribute as CFString)
        if win == nil { win = axAttrElement(appElem, kAXMainWindowAttribute as CFString) }
        return axAttrString(win, kAXTitleAttribute as CFString) ?? ""
    }

    /// 只读前台 app 自己的焦点元素（防系统弹窗串台）；密码框由调用方跳过事件。
    private func readFocusedElement(pid: Int) -> (role: String, title: String)? {
        let sys = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(sys, 1.0)
        guard let focused = axAttrElement(sys, kAXFocusedUIElementAttribute as CFString) else { return nil }
        let fpid = axAttrPID(focused) ?? pid
        let role = axAttrString(focused, kAXRoleAttribute as CFString) ?? ""
        guard fpid == pid, !role.isEmpty else { return nil }
        let title = axAttrString(focused, kAXTitleAttribute as CFString) ?? ""
        return (role, title)
    }

    /// 段到期关闭：paused 也会被 sampleOnce/resume 调用来关段；关闭后**不新建**空段，
    /// 新段在下一个事件/抑制记录落盘时懒建。段边界清空去重状态，让新段重新快照当前上下文。
    private func rotateIfDue() {
        guard let seg = segment, seg.ageMs >= SEGMENT_LENGTH_MS else { return }
        flushTextInput(reason: "rotate")
        seg.close()
        segment = nil
        // 段边界不是抑制状态转换：lastSuppressedKey 保持不变，避免在持续被 block 时
        // 每 10 分钟都造一个只含 suppression 记录的小段（空闲=无记录=无空段）。
        rotatedBundleId = lastBundleId
        lastBundleId = ""
        presenceAnnounced = false
        resetContentDedupe()
        // 新段需要重新 full 快照（窗口没变也会在下次采样补上）
        lastSnapshotLines = nil
        lastSnapshotWindowKey = ""
        lastSnapshotAt = nil
        lastWindowId = ""
        lastSelectionKey = ""
        lastClick = nil
        mouseDownState = nil
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

    /// 一次浏览器采样结果（原始 URL + 无痕判定）。
    private struct BrowserSample {
        let url: String
        let incognito: Bool
    }

    /// 读当前标签 URL。
    /// - Chrome 系：AppleScript 读 active tab URL + front window mode（无痕判定）。
    /// - Safari：AppleScript 读 front document URL + front window name；无痕用
    ///   「窗口名关键词 → AX 窗口 chrome 子树关键词」两段启发式（见 safariLooksPrivate）。
    /// - Firefox：无 AppleScript 标签接口 → nil（诚实降级，不猜）。
    private func browserSample(bundleId: String, pid: Int) -> BrowserSample? {
        var out: String?
        var incognito = false
        var windowName = ""
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
                    incognito = parts.count > 1 && containsPrivateBrowsingKeyword(parts[1])
                }
            }
        } else if config.isSafari(bundleId) {
            let script = """
            tell application id "\(SAFARI_ID)"
                if (count of documents) = 0 then return ""
                set u to URL of front document
                try
                    set w to name of front window
                on error
                    set w to ""
                end try
                return u & linefeed & w
            end tell
            """
            if let res = runOSA(script) {
                let parts = res.split(separator: "\n", maxSplits: 1).map(String.init)
                if let u = parts.first, !u.isEmpty, u != "missing value" {
                    out = u
                    windowName = parts.count > 1 ? parts[1] : ""
                }
            }
        }
        guard let u = out else { return nil }
        if config.isSafari(bundleId) {
            incognito = safariLooksPrivate(pid: pid, windowName: windowName, rawURL: u)
        }
        return BrowserSample(url: u, incognito: incognito)
    }

    /// Safari 无痕启发式（仅 privacy.safariPrivateDetection == "heuristic" 时启用）。
    ///
    /// 局限（必须如实告知用户/README）：
    ///   1) Safari 没有 AppleScript/公开 API 暴露「窗口是否私密」；这里靠窗口名与窗口 chrome 里的
    ///      "Private Browsing"/"无痕浏览" 等文案推断，Safari 版本/语言/布局变化都可能让信号消失。
    ///   2) 漏检（false negative）时私密窗口的 URL/标题仍会被记录——这是当前已知风险；需要强保证时
    ///      配置 privacy.excludeSafariURLs=true（彻底不记录 Safari 内容）。
    ///   3) 误检（false positive，例如普通页面标题里出现 "Private Browsing" 字样）只会多抑制（安全方向）。
    ///   结果按 url|窗口名 缓存 10s，避免每 2s 都做一次 AX 子树遍历。
    private func safariLooksPrivate(pid: Int, windowName: String, rawURL: String) -> Bool {
        guard config.privacy.safariPrivateDetection == "heuristic" else { return false }
        let key = "\(rawURL)|\(windowName)"
        if let c = safariPrivateCache, c.key == key, Date().timeIntervalSince(c.at) < 10 {
            return c.value
        }
        var value = containsPrivateBrowsingKeyword(windowName)
        if !value { value = axWindowLooksPrivate(pid: pid) }
        safariPrivateCache = (key, value, Date())
        return value
    }

    /// 有界遍历前台窗口 AX 子树（**不进入 AXWebArea 页面内容**），只看窗口 chrome 上的
    /// AXDescription/AXTitle 与 AXStaticText 的 AXValue 是否含隐私浏览关键词。
    private func axWindowLooksPrivate(pid: Int) -> Bool {
        guard pid > 0 else { return false }
        let appElem = AXUIElementCreateApplication(pid_t(pid))
        AXUIElementSetMessagingTimeout(appElem, 0.6)
        guard let win = axAttrElement(appElem, kAXFocusedWindowAttribute as CFString)
            ?? axAttrElement(appElem, kAXMainWindowAttribute as CFString) else { return false }
        var budget = 400
        return axSubtreeLooksPrivate(win, depth: 0, budget: &budget)
    }

    private func asAXElement(_ any: Any) -> AXUIElement? {
        asAXElementAny(any)
    }

    private func axSubtreeLooksPrivate(_ element: AXUIElement, depth: Int, budget: inout Int) -> Bool {
        guard depth <= 8, budget > 0 else { return false }
        budget -= 1
        let role = axAttrString(element, kAXRoleAttribute as CFString) ?? ""
        if role == "AXWebArea" { return false } // 不读页面内容
        if let desc = axAttrString(element, kAXDescriptionAttribute as CFString), containsPrivateBrowsingKeyword(desc) {
            return true
        }
        if let t = axAttrString(element, kAXTitleAttribute as CFString), containsPrivateBrowsingKeyword(t) {
            return true
        }
        if role == "AXStaticText", let v = axAttrString(element, kAXValueAttribute as CFString), containsPrivateBrowsingKeyword(v) {
            return true
        }
        var childRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childRef) == .success,
              let children = childRef as? [Any] else { return false }
        for child in children {
            guard budget > 0 else { return false }
            if let childEl = asAXElement(child),
               axSubtreeLooksPrivate(childEl, depth: depth + 1, budget: &budget) { return true }
        }
        return false
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

// MARK: - 按需屏幕 OCR（单窗口，像素只在内存，不落盘）

@available(macOS 14.0, *)
enum ScreenOCR {
    struct Result {
        let text: String
        let lineCount: Int
        let width: Int
        let height: Int
    }

    enum Failure: Error {
        case permissionDenied
        case noWindow
        case empty
        case capture(String)
    }

    static let maxChars = 8000
    static let maxDimension: CGFloat = 3000

    /// 只截当前前台窗口；ScreenCaptureKit 内容过滤 + Vision 本地识别。
    static func capture(pid: Int, windowId: Int?) async throws -> Result {
        guard CGPreflightScreenCaptureAccess() else {
            _ = CGRequestScreenCaptureAccess()
            throw Failure.permissionDenied
        }
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        } catch {
            throw Failure.capture(error.localizedDescription)
        }
        let candidates = content.windows.filter { win in
            guard let app = win.owningApplication else { return false }
            return Int(app.processID) == pid && win.windowLayer == 0
                && win.frame.width >= 200 && win.frame.height >= 120
        }
        let chosen = candidates.first(where: { windowId != nil && Int($0.windowID) == windowId })
            ?? candidates.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })
        guard let window = chosen else { throw Failure.noWindow }

        let filter = SCContentFilter(desktopIndependentWindow: window)
        let cfg = SCStreamConfiguration()
        var width = window.frame.width * 2
        var height = window.frame.height * 2
        if width > maxDimension {
            height = height * maxDimension / width
            width = maxDimension
        }
        cfg.width = max(1, Int(width.rounded()))
        cfg.height = max(1, Int(height.rounded()))
        cfg.showsCursor = false
        cfg.capturesAudio = false

        let image: CGImage
        do {
            image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
        } catch {
            throw Failure.capture(error.localizedDescription)
        }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        do {
            try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        } catch {
            throw Failure.capture(error.localizedDescription)
        }

        // Vision 坐标原点在左下：先按行（midY 降序），同一行再按 x 升序。
        let observations = (request.results ?? []).sorted { a, b in
            if abs(a.boundingBox.midY - b.boundingBox.midY) > 0.008 {
                return a.boundingBox.midY > b.boundingBox.midY
            }
            return a.boundingBox.minX < b.boundingBox.minX
        }
        var lines: [String] = []
        for observation in observations {
            guard let candidate = observation.topCandidates(1).first else { continue }
            let line = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
            if !line.isEmpty { lines.append(line) }
        }
        guard !lines.isEmpty else { throw Failure.empty }
        var text = lines.joined(separator: "\n")
        if text.count > maxChars { text = String(text.prefix(maxChars)) }
        return Result(text: text, lineCount: lines.count,
                      width: cfg.width, height: cfg.height)
    }

    static func describe(_ error: Error) -> (message: String, code: String) {
        switch error {
        case Failure.permissionDenied:
            return ("需要屏幕录制权限：系统设置 → 隐私与安全性 → 屏幕录制，允许 Chronicle Helper 后重试（若已打开，重启 Chronicle Helper）", "SCREEN_PERMISSION_DENIED")
        case Failure.noWindow:
            return ("没有找到可截取的前台窗口", "NO_WINDOW")
        case Failure.empty:
            return ("窗口里没有识别到文字", "NO_TEXT")
        case Failure.capture(let message):
            let lower = message.lowercased()
            if lower.contains("permission") || lower.contains("declined") || lower.contains("not authorized") {
                return ("屏幕录制权限不可用：请在系统设置中允许 Chronicle Helper 后重试（若已打开，重启 Chronicle Helper）", "SCREEN_PERMISSION_DENIED")
            }
            return ("屏幕读取失败：\(message)", "SCREEN_CAPTURE_FAILED")
        default:
            return ("屏幕读取失败：\(error.localizedDescription)", "SCREEN_CAPTURE_FAILED")
        }
    }
}
