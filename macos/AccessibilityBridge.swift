import Cocoa
import CoreVideo

// Screen readers and Computer see cached native elements, never a synchronous
// network call in an AX getter. The helper remains the authority for mutations.
struct MirrorAXTarget: Equatable {
    let port: Int
    let instance: String
    let device: String
    let generation: Int
    let epoch: Int
    // An Android tree is the active window in display pixels, and that window
    // can be smaller than the display (a dialog, split screen). Placing its
    // nodes needs the display size, which only /api/state reports.
    var android = false
}

enum MirrorAXError: Error { case invalidSnapshot, unavailable }

struct MirrorAXNode {
    // The device's own name for the element: an XCTest element type on iPhone
    // ("Button"), a Java class name on Android ("android.widget.Button").
    let type: String
    // The iPhone element type this node behaves as. Roles and actions are
    // decided from it, so both platforms share the tables below.
    let kind: String
    // Android only: the node handles a tap, whatever its class.
    let clickable: Bool
    let label: String
    let value: Any?
    let rect: CGRect
    let enabled: Bool
    let visible: Bool
    let focused: Bool
    let accessible: Bool
    let path: String
    let children: [MirrorAXNode]

    func matches(_ other: Self) -> Bool {
        let sameValue = value == nil && other.value == nil
            || ((value as? NSObject)?.isEqual(other.value) == true)
        return type == other.type && kind == other.kind && clickable == other.clickable
            && label == other.label && sameValue && rect == other.rect
            && enabled == other.enabled && visible == other.visible && focused == other.focused
            && accessible == other.accessible && path == other.path && children.count == other.children.count
            && zip(children, other.children).allSatisfy { $0.matches($1) }
    }

    var android: Bool { type.contains(".") }
    var secure: Bool { kind == "SecureTextField" }
    var editable: Bool { ["TextField", "SecureTextField", "SearchField", "TextView"].contains(kind) }
    var normalizedValue: Double? {
        // Android reports a slider's raw position without its range, so it has
        // no normalized value; Increase and Decrease still apply.
        guard kind == "Slider", let value = value as? String else { return nil }
        // Phone and Mac locales can differ. Accept an unambiguous percentage,
        // including iOS's non-breaking space, but not grouped/arbitrary units.
        let compact = value.filter { !$0.isWhitespace }
        guard compact.range(of: "^[0-9]{1,3}([.,][0-9]{1,2})?%$", options: .regularExpression) != nil,
              let number = Double(compact.dropLast().replacingOccurrences(of: ",", with: ".")),
              (0...100).contains(number) else { return nil }
        return number / 100
    }
    var settable: Bool { (editable && !secure) || normalizedValue != nil }
    var scrollable: Bool { ["ScrollView", "Table", "CollectionView", "WebView"].contains(kind) }
    var pressable: Bool {
        ["Button", "Cell", "Link", "Switch", "CheckBox", "RadioButton", "TextField",
         "SecureTextField", "SearchField", "TextView", "PopUpButton"].contains(kind)
            // Nearly every Android view is "accessible"; there the clickable
            // trait says whether a tap does anything.
            || (android ? clickable : accessible && ["Other", "Image"].contains(kind))
    }
    var role: NSAccessibility.Role {
        switch kind {
        case "Button", "Cell", "PopUpButton": return .button
        case "Link": return .link
        case "TextField", "SecureTextField", "SearchField": return .textField
        case "TextView": return .textArea
        case "StaticText": return .staticText
        case "Image": return .image
        case "Switch", "CheckBox": return .checkBox
        case "RadioButton": return .radioButton
        case "Slider": return .slider
        case "ProgressIndicator", "ActivityIndicator": return .progressIndicator
        case "ScrollView", "Table", "CollectionView", "WebView": return .scrollArea
        default: return .group
        }
    }

    // Android element types are Java class names. Each one listed here behaves
    // as the iPhone type beside it; layouts and anything unknown are "Other" (a
    // group). Apps and Compose report these framework names for their own
    // subclasses, so the list stays short.
    static let androidKinds: [String: String] = [
        "android.widget.Button": "Button", "android.widget.ImageButton": "Button",
        "android.widget.Spinner": "PopUpButton",
        "android.widget.EditText": "TextField", "android.widget.AutoCompleteTextView": "TextField",
        "android.widget.MultiAutoCompleteTextView": "TextField",
        "android.widget.TextView": "StaticText", "android.widget.ImageView": "Image",
        "android.widget.Switch": "Switch", "androidx.appcompat.widget.SwitchCompat": "Switch",
        "android.widget.ToggleButton": "Switch",
        "android.widget.CheckBox": "CheckBox", "android.widget.CheckedTextView": "CheckBox",
        "android.widget.RadioButton": "RadioButton",
        "android.widget.SeekBar": "Slider", "android.widget.RatingBar": "Slider",
        "android.widget.ProgressBar": "ProgressIndicator",
        "android.widget.ScrollView": "ScrollView", "android.widget.HorizontalScrollView": "ScrollView",
        "androidx.core.widget.NestedScrollView": "ScrollView", "androidx.viewpager.widget.ViewPager": "ScrollView",
        "android.widget.ListView": "Table", "android.widget.GridView": "CollectionView",
        "androidx.recyclerview.widget.RecyclerView": "CollectionView",
        "android.webkit.WebView": "WebView",
    ]

    // The class alone is not enough on Android: Compose and custom views report
    // android.view.View, and say what they do only through their traits.
    static func androidKind(_ type: String, traits: Set<String>, leaf: Bool) -> String {
        let kind = androidKinds[type] ?? "Other"
        if traits.contains("password") { return "SecureTextField" }
        if traits.contains("editable") { return "TextField" }
        if traits.contains("checkable"), ["Other", "Button", "StaticText", "Image"].contains(kind) { return "CheckBox" }
        guard kind == "Other" else { return kind }
        if traits.contains("scrollable") { return "ScrollView" }
        // A clickable container stays a group, so its contents remain readable.
        return traits.contains("clickable") && leaf ? "Button" : kind
    }

    static func parse(_ value: Any) throws -> Self {
        var remaining = 10_000
        var textRemaining = 8 * 1024 * 1024
        func visit(_ value: Any, _ path: String, _ depth: Int) throws -> Self {
            remaining -= 1
            // Android view hierarchies run deeper than iPhone ones; its helper
            // stops at 100 levels.
            guard remaining >= 0, depth <= 100,
                  let data = value as? [String: Any], let type = data["type"] as? String,
                  type.range(of: "^[A-Za-z][A-Za-z0-9]*$", options: .regularExpression) != nil
                    || (type.count <= 256 && type.range(of: "^[A-Za-z_][A-Za-z0-9_$]*(\\.[A-Za-z_][A-Za-z0-9_$]*)+$", options: .regularExpression) != nil),
                  let box = data["rect"] as? [String: Any],
                  let x = box["x"] as? Double, let y = box["y"] as? Double,
                  let width = box["width"] as? Double, let height = box["height"] as? Double,
                  [x, y, width, height].allSatisfy(\.isFinite), width >= 0, height >= 0,
                  let rawChildren = data["children"] as? [Any] else { throw MirrorAXError.invalidSnapshot }
            func flag(_ key: String) throws -> Bool {
                guard let value = data[key] as? String, value == "0" || value == "1" else { throw MirrorAXError.invalidSnapshot }
                return value == "1"
            }
            let android = type.contains(".")
            let traits = android ? Set((data["traits"] as? String ?? "").components(separatedBy: ", ")) : []
            let kind = android ? androidKind(type, traits: traits, leaf: rawChildren.isEmpty) : type
            // An Android name is a resource ID ("com.example:id/send"); only its
            // last part says anything about an otherwise unlabeled control.
            let name = (data["name"] as? String).map { android ? ($0.components(separatedBy: ":id/").last ?? $0) : $0 }
            let label = (data["label"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? name ?? ""
            // Never export password values or containers holding arbitrary JSON.
            let rawValue = data["value"]
            let scalar: Any? = kind == "SecureTextField" ? nil
                : ((rawValue is String || rawValue is NSNumber) ? rawValue : nil)
            textRemaining -= label.utf8.count + ((scalar as? String)?.utf8.count ?? 0)
            guard textRemaining >= 0 else { throw MirrorAXError.invalidSnapshot }
            return try Self(type: type, kind: kind, clickable: traits.contains("clickable"), label: label, value: scalar,
                rect: CGRect(x: x, y: y, width: width, height: height),
                enabled: flag("isEnabled"), visible: flag("isVisible"), focused: flag("isFocused"),
                accessible: flag("isAccessible"), path: path,
                children: rawChildren.enumerated().map { try visit($0.element, path + "/*[\($0.offset + 1)]", depth + 1) })
        }
        // Path format, which the helpers resolve as an `xpath` selector: the
        // root of the snapshot is "/*[1]", and each level below appends
        // "/*[n]", n being the node's 1-based position in its parent's
        // `children` array as the helper reported it (on Android that array
        // omits children the system returned as null). Nothing else is ever
        // generated: no names, predicates or attributes. Keep it stable; the
        // iPhone and Android helpers both resolve exactly this.
        return try visit(value, "/*[1]", 0)
    }

    // Device rectangles are in the current oriented display's top-left space,
    // in points on iPhone and pixels on Android. Only their proportion of
    // `screen` is used, so the unit does not matter as long as both agree.
    // AppKit accessibility uses global screen coordinates with a bottom-left origin.
    static func frame(_ rect: CGRect, screen: CGRect, host: CGRect) -> CGRect {
        guard screen.width > 0, screen.height > 0 else { return .zero }
        return CGRect(x: host.minX + (rect.minX - screen.minX) / screen.width * host.width,
                      y: host.maxY - (rect.maxY - screen.minY) / screen.height * host.height,
                      width: rect.width / screen.width * host.width,
                      height: rect.height / screen.height * host.height)
    }
}

struct MirrorAXObservation {
    let id: String
    let app: String
    let orientation: String
    let stable: Bool
    let root: MirrorAXNode
    // The display the node rectangles are measured against. On iPhone the root
    // element is the display. On Android the root is only the active window,
    // so the bridge substitutes the display size once it knows it.
    var screen: CGRect
    static func parse(_ value: Any) throws -> Self {
        guard let json = value as? [String: Any], let id = json["id"] as? String, !id.isEmpty, id.count <= 128,
              let app = json["app"] as? [String: Any], let bundle = app["bundleId"] as? String, !bundle.isEmpty,
              let orientation = json["orientation"] as? String,
              ["PORTRAIT", "LANDSCAPE", "UIA_DEVICE_ORIENTATION_PORTRAIT_UPSIDEDOWN", "UIA_DEVICE_ORIENTATION_LANDSCAPERIGHT"].contains(orientation),
              let stable = json["stable"] as? Bool, let source = json["source"] else { throw MirrorAXError.invalidSnapshot }
        let root = try MirrorAXNode.parse(source)
        guard root.rect.width > 0, root.rect.height > 0 else { throw MirrorAXError.invalidSnapshot }
        return Self(id: id, app: bundle, orientation: orientation, stable: stable, root: root, screen: root.rect)
    }
}

// Apps whose snapshot stalled the device helper, per device, kept across
// launches so the same app does not take the session down again tomorrow.
// Only device and bundle identifiers and times are stored, never content.
struct MirrorAXStallMemory {
    static let key = "AccessibilityStalledApps"
    // How long automatic snapshots of an app are withheld after its first,
    // second, third and later stalls. The first is short because a single
    // stall can be a busy phone rather than the app.
    static let holds: [TimeInterval] = [600, 86_400, 7 * 86_400, 30 * 86_400]
    // An app that has not stalled for this long after its hold ran out starts over.
    static let forgetAfter: TimeInterval = 30 * 86_400
    var load: () -> [String: Any]
    var save: ([String: Any]) -> Void
    // Wall time: a hold has to outlast a restart of the Mac, which uptime does not.
    var now: () -> TimeInterval = { Date().timeIntervalSince1970 }

    static let standard = MirrorAXStallMemory(
        load: { UserDefaults.standard.dictionary(forKey: key) ?? [:] },
        save: { UserDefaults.standard.set($0, forKey: key) })

    private func entries(_ device: String) -> [String: [String: Any]] {
        ((load()[device] as? [String: Any]) ?? [:]).compactMapValues { $0 as? [String: Any] }
    }
    private func until(_ entry: [String: Any]?) -> TimeInterval { entry?["until"] as? Double ?? -.infinity }
    private func store(_ apps: [String: [String: Any]], device: String) {
        // Every window has its own bridge; write only this device's part of
        // what is stored now, not of what was read earlier.
        var all = load()
        all[device] = apps.isEmpty ? nil : apps
        save(all)
    }

    func holdsAny(device: String) -> Bool { entries(device).values.contains { now() < until($0) } }
    func heldUntil(device: String, app: String) -> TimeInterval? {
        let end = until(entries(device)[app])
        return now() < end ? end : nil
    }
    @discardableResult func record(device: String, app: String) -> TimeInterval {
        var apps = entries(device).filter { now() < until($0.value) + Self.forgetAfter }
        let count = min((apps[app]?["count"] as? Int ?? 0) + 1, Self.holds.count)
        let end = now() + Self.holds[count - 1]
        apps[app] = ["until": end, "count": count]
        while apps.count > 64, let oldest = apps.min(by: { until($0.value) < until($1.value) })?.key {
            apps.removeValue(forKey: oldest)
        }
        store(apps, device: device)
        return end
    }
    // The app was read after all. End the hold but keep the count, so that a
    // relapse is held for longer.
    func release(device: String, app: String) {
        var apps = entries(device)
        guard now() < until(apps[app]) else { return }
        apps[app]?["until"] = now()
        store(apps, device: device)
    }
}

@MainActor
final class MirrorAXHost: NSView {
    let bridge: MirrorAccessibilityBridge
    override convenience init(frame frameRect: NSRect) {
        self.init(frame: frameRect, bridge: MirrorAccessibilityBridge())
    }
    init(frame frameRect: NSRect, bridge: MirrorAccessibilityBridge) {
        self.bridge = bridge
        super.init(frame: frameRect)
        bridge.host = self
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Device content")
        setAccessibilityIdentifier("iportal.device-content")
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func isAccessibilityElement() -> Bool { bridge.target != nil }
    override func accessibilityChildren() -> [Any]? {
        bridge.diagnostic("read", ["roots": bridge.elements.count])
        bridge.refreshIfNeeded()
        return bridge.elements
    }
    override func accessibilityVisibleChildren() -> [Any]? {
        bridge.refreshIfNeeded()
        return bridge.elements.filter { $0.node.visible }
    }
    override func accessibilityHelp() -> String? { bridge.help }
    // Offered only while reading is withheld for the app in front.
    func offerReadAnyway(_ offered: Bool) {
        setAccessibilityCustomActions(offered ? [NSAccessibilityCustomAction(name: "Read anyway") { [weak self] in
            self?.bridge.readAnyway() ?? false
        }] : nil)
    }
}

@MainActor
final class MirrorAXElement: NSAccessibilityElement {
    let node: MirrorAXNode
    let revision: UUID
    weak var bridge: MirrorAccessibilityBridge?
    var descendants: [MirrorAXElement] = []
    init(node: MirrorAXNode, revision: UUID, bridge: MirrorAccessibilityBridge, parent: Any) {
        self.node = node; self.revision = revision; self.bridge = bridge
        super.init()
        setAccessibilityElement(true)
        setAccessibilityParent(parent)
        setAccessibilityRole(node.role)
        if node.secure { setAccessibilitySubrole(.secureTextField) }
        setAccessibilityLabel(node.label)
        super.setAccessibilityValue(node.normalizedValue.map { $0 as Any } ?? node.value
            ?? (node.editable && !node.secure ? "" : nil))
        if node.normalizedValue != nil { setAccessibilityMinValue(0); setAccessibilityMaxValue(1) }
        setAccessibilityIdentifier("iportal.remote.\(revision.uuidString).\(node.path)")
        let actions: [(String, MirrorAXAction)] = node.scrollable
            ? [("Scroll down", .scroll(.down)), ("Scroll up", .scroll(.up)), ("Scroll left", .scroll(.left)), ("Scroll right", .scroll(.right))]
            : node.kind == "Slider" ? [("Increase", .element(.increment)), ("Decrease", .element(.decrement))]
            : node.editable ? [("Focus", .element(.focus))]
            : node.pressable ? [("Long press", .element(.longPress)), ("Double tap", .element(.doubleTap))] : []
        setAccessibilityCustomActions(actions.map { name, action in
            NSAccessibilityCustomAction(name: name) { [weak self] in
                guard let self else { return false }
                return self.bridge?.perform(self, action: action) ?? false
            }
        })
        descendants = node.children.map { MirrorAXElement(node: $0, revision: revision, bridge: bridge, parent: self) }
    }
    override func isAccessibilityElement() -> Bool { bridge?.isCurrent(self) == true }
    override func accessibilityChildren() -> [Any]? {
        bridge?.refreshIfNeeded()
        return bridge?.isCurrent(self) == true ? descendants : []
    }
    override func accessibilityVisibleChildren() -> [Any]? {
        bridge?.isCurrent(self) == true ? descendants.filter { $0.node.visible } : []
    }
    override func accessibilityWindow() -> Any? { bridge?.host?.window }
    override func accessibilityTopLevelUIElement() -> Any? { bridge?.host?.window }
    override func accessibilityFrame() -> NSRect {
        guard let bridge, bridge.isCurrent(self), let host = bridge.host,
              let window = host.window, let observation = bridge.observation else { return .zero }
        let frame = window.convertToScreen(host.convert(host.bounds, to: nil))
        return MirrorAXNode.frame(node.rect, screen: observation.screen, host: frame)
    }
    override func isAccessibilityEnabled() -> Bool { node.enabled && bridge?.isCurrent(self) == true }
    override func isAccessibilityFocused() -> Bool { node.focused }
    override func accessibilityHelp() -> String? { node.visible ? nil : "Off screen" }
    override func accessibilityPerformPress() -> Bool { bridge?.perform(self) ?? false }
    override func accessibilityPerformIncrement() -> Bool {
        node.kind == "Slider" && bridge?.perform(self, action: .element(.increment)) == true
    }
    override func accessibilityPerformDecrement() -> Bool {
        node.kind == "Slider" && bridge?.perform(self, action: .element(.decrement)) == true
    }
    override func setAccessibilityValue(_ value: Any?) {
        // Initialization sets the cached value before an observation is bound.
        guard bridge?.isCurrent(self) == true else { return }
        if node.editable && !node.secure, let text = value as? String, text.count <= 10000 {
            _ = bridge?.perform(self, action: .replaceText(text))
        } else if node.kind == "Slider", node.normalizedValue != nil {
            let number: Double?
            if let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() {
                number = value.doubleValue
            } else if let value = value as? String { number = Double(value) }
            else { number = nil }
            if let number, number.isFinite, (0...1).contains(number) {
                _ = bridge?.perform(self, action: .adjust(number))
            }
        }
    }
    override func isAccessibilitySelectorAllowed(_ selector: Selector) -> Bool {
        if selector == #selector(accessibilityPerformPress) {
            return node.pressable && node.visible && bridge?.isCurrent(self) == true
        }
        if selector == #selector(setAccessibilityValue(_:)) { return node.settable && node.visible && node.enabled && bridge?.isCurrent(self) == true }
        if selector == #selector(accessibilityPerformIncrement) || selector == #selector(accessibilityPerformDecrement) {
            return node.kind == "Slider" && node.visible && node.enabled && bridge?.isCurrent(self) == true
        }
        if selector == #selector(setAccessibilityFocused(_:)) { return false }
        return super.isAccessibilitySelectorAllowed(selector)
    }
}

enum MirrorAXDirection { case up, down, left, right }
enum MirrorAXElementAction: String { case focus, doubleTap, longPress, increment, decrement }
enum MirrorAXAction {
    case press, scroll(MirrorAXDirection), element(MirrorAXElementAction), replaceText(String), adjust(Double)
}

@MainActor
final class MirrorAccessibilityBridge {
    weak var host: MirrorAXHost?
    var prepareInput: () -> Void = {}
    // Readable phone state survives a video-only refresh. Input keeps the
    // window's existing fresh-frame/readiness gate independently of the cache.
    var allowsActions: () -> Bool = { true }
    var diagnostic: (String, [String: Any]) -> Void = { _, _ in }
    // A few plain lines for the log: that the tree is being read, and when and
    // why reading an app is withheld. Which client reads cannot be known from
    // inside the app. Bundle identifiers only, never UI text.
    var notice: (String) -> Void = { _ in }
    private(set) var target: MirrorAXTarget?
    private(set) var observation: MirrorAXObservation?
    private(set) var elements: [MirrorAXElement] = []
    private(set) var help = "Read the device’s accessible content."
    private var revision = UUID()
    private var task: Task<Void, Never>?
    private var actionTask: Task<Void, Never>?
    private var actionID = UUID()
    private var sampledAt = -Double.infinity
    private var dirty = true
    private var demandUntil = -Double.infinity
    private var demandReportedAt = -Double.infinity
    private var retryAt = -Double.infinity
    // Frame-driven refreshes wait until this time; commands and reads do not.
    private var frameHoldUntil = -Double.infinity
    private var failures = 0
    private var urgent = false
    private var scheduledIsHold = false
    // A snapshot that stalls takes the device helper down with it, and cannot
    // be cancelled on the phone. Some apps (a video timeline, for one) stall
    // every time. So the app is remembered (MirrorAXStallMemory), and while any
    // app is remembered for this device the foreground app is asked for first,
    // with the cheap /api/state, and a remembered app is not snapshotted.
    private let memory: MirrorAXStallMemory
    // The device whose snapshot stalled before it was known which app was in
    // front. Asked as soon as the helper answers again, before any snapshot.
    private var unattributedStall: String?
    // When the pending snapshot was sent; infinite while none is.
    private var requestBegan = Double.infinity
    // The foreground app confirmed just before the pending snapshot.
    private var snapshotApp: String?
    private(set) var heldApp: String?
    private var overrideApp: String?
    // Android only: display size in pixels and whether it was landscape then.
    private var display: (size: CGSize, landscape: Bool)?
    private var readSessions = 0
    private var readNoticedAt = -Double.infinity
    private var readID = UUID()
    private var changeVersion = 0
    private var scheduled: Task<Void, Never>?
    private var visualHash: UInt64?
    private var contentRevision: Int?
    var demandChanged: (Bool) -> Void = { _ in }
    var wantsVisualEvents: Bool { target != nil && clock() < demandUntil }

    private let clock: () -> TimeInterval
    private let send: (URLRequest) async throws -> (Data, URLResponse)

    init(clock: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
         memory: MirrorAXStallMemory = .standard,
         send: @escaping (URLRequest) async throws -> (Data, URLResponse) = { try await URLSession.shared.data(for: $0) }) {
        self.clock = clock; self.memory = memory; self.send = send
    }

    private static func span(_ seconds: TimeInterval) -> String {
        seconds >= 86_400 ? "\(Int((seconds / 86_400).rounded())) d"
            : seconds >= 3600 ? "\(Int((seconds / 3600).rounded())) h"
            : "\(max(1, Int((seconds / 60).rounded()))) min"
    }

    private func registerStall(device: String, app: String?) {
        diagnostic("stalled", ["attributed": app != nil])
        guard let app else {
            unattributedStall = device
            notice("a snapshot stalled the device helper; the app in front is identified before anything is read again")
            return
        }
        let until = memory.record(device: device, app: app)
        notice("a snapshot of \(app) stalled the device helper; automatic reading of that app is paused for \(Self.span(until - memory.now()))")
    }

    // Reading the app in front is withheld. Nothing is snapshotted; only the
    // foreground app is asked for again while a reader stays interested.
    private func hold(_ app: String, until: TimeInterval) {
        if heldApp != app {
            heldApp = app
            host?.offerReadAnyway(true)
            diagnostic("held", [:])
            notice("reading of \(app) is paused for another \(Self.span(until - memory.now())): its snapshot stalled the device helper earlier")
            invalidate()
        }
        help = "Reading this app’s content is paused: it stalled the device connection earlier. The Read anyway action tries once and may interrupt mirroring."
        retryAt = clock() + 3; frameHoldUntil = retryAt; dirty = true
    }

    // The one way to snapshot a held app: a reader asking for it explicitly,
    // having been told what it may cost. A stall is recorded like any other.
    func readAnyway() -> Bool {
        guard let app = heldApp, target != nil, !Self.disabled else { return false }
        notice("reading of \(app) retried on request")
        overrideApp = app
        retryAt = -Double.infinity; frameHoldUntil = -Double.infinity; dirty = true
        scheduled?.cancel(); scheduled = nil; scheduledIsHold = false
        refreshIfNeeded()
        return true
    }

    func update(target next: MirrorAXTarget?) {
        guard target != next else { return }
        diagnostic("target", ["available": next != nil, "epoch": next?.epoch ?? -1])
        // A stalled snapshot blocks the device helper, which is then restarted;
        // that arrives here as a lost target while the request is still pending.
        // Remember it, or the snapshot would be repeated after every restart.
        if task != nil, let previous = target, clock() - requestBegan >= 5 { registerStall(device: previous.device, app: snapshotApp) }
        target = next
        task?.cancel(); task = nil
        actionID = UUID()
        actionTask?.cancel(); actionTask = nil
        invalidate()
        scheduled?.cancel(); scheduled = nil
        demandUntil = -Double.infinity; demandReportedAt = -Double.infinity
        retryAt = -Double.infinity; visualHash = nil; contentRevision = nil
        frameHoldUntil = -Double.infinity; failures = 0; urgent = false
        requestBegan = .infinity; snapshotApp = nil; overrideApp = nil; display = nil
        if heldApp != nil { heldApp = nil; host?.offerReadAnyway(false) }
        if let next, next.device != unattributedStall { unattributedStall = nil }
        demandChanged(false)
        help = next == nil ? "Device content unavailable." : "Read the device’s accessible content."
    }

    func invalidate() {
        diagnostic("invalidate", ["roots": elements.count, "pending": task != nil])
        readID = UUID()
        task?.cancel(); task = nil
        dirty = true
        revision = UUID(); observation = nil; elements = []; sampledAt = -Double.infinity
        if let host { NSAccessibility.post(element: host, notification: .layoutChanged) }
    }

    // AX getters are cache-only. Interest is leased by real reads, so a video
    // or animation never starts tree inspection during ordinary mirroring.
    // Diagnostic switch: `defaults write com.baremetalgpu.iportal
    // AccessibilityBridgeDisabled -bool YES` stops all tree inspection, to tell
    // whether a problem comes from snapshots or from the connection itself.
    static let disabled = UserDefaults.standard.bool(forKey: "AccessibilityBridgeDisabled")

    func refreshIfNeeded() {
        guard target != nil, !Self.disabled else { return }
        if clock() >= demandUntil {
            // A reader arrived after a pause. Said at most every ten minutes:
            // a client that polls must not fill the log.
            readSessions += 1
            if clock() - readNoticedAt >= 600 {
                notice("an accessibility client is reading device content (\(readSessions) reading session\(readSessions == 1 ? "" : "s") since the last report)")
                readNoticedAt = clock(); readSessions = 0
            }
        }
        demandUntil = clock() + 12
        if clock() - demandReportedAt >= 4 {
            demandReportedAt = clock(); demandChanged(true)
        }
        // On-read safety net for missed events and invisible/off-screen changes.
        // Healthy reads do not have a two-second polling/refresh gate.
        if observation == nil || clock() - sampledAt >= 10 { dirty = true }
        startRefresh()
    }

    func contentDidChange(_ reason: String = "content") {
        dirty = true; changeVersion &+= 1
        // A command or an explicit change wants the tree promptly. Moving
        // pictures do not: see frameHoldUntil.
        if reason != "frame" {
            urgent = true
            // Do not leave an urgent change waiting behind a frame hold.
            if scheduledIsHold { scheduled?.cancel(); scheduled = nil; scheduledIsHold = false }
        }
        guard wantsVisualEvents else { return }
        diagnostic("changed", ["reason": reason])
        scheduleRefresh()
    }

    func receiveContentRevision(_ value: Int, instance: String) {
        guard target?.instance == instance, value >= 0,
              contentRevision == nil || value > contentRevision! else { return }
        contentRevision = value
        contentDidChange("command")
    }

    private func scheduleRefresh() {
        guard scheduled == nil, task == nil, actionTask == nil, wantsVisualEvents else { return }
        let wait = max(0.12, retryAt - clock(), urgent ? 0 : frameHoldUntil - clock())
        scheduledIsHold = wait > 0.12 && !urgent
        scheduled = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(min(wait, 10) * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            self.scheduled = nil; self.scheduledIsHold = false
            if self.wantsVisualEvents { self.startRefresh() }
        }
    }

    private func startRefresh() {
        guard dirty, let target, task == nil, actionTask == nil, clock() >= retryAt else { return }
        // Within a frame hold the cached tree is at most a few seconds old; a
        // read is served from it. Commands and a missing tree are not held.
        if !urgent, observation != nil, clock() < frameHoldUntil {
            scheduleRefresh()
            return
        }
        scheduled?.cancel(); scheduled = nil; scheduledIsHold = false
        let token = UUID(), version = changeVersion
        readID = token; dirty = false; urgent = false; requestBegan = .infinity; snapshotApp = nil
        // The state query costs one short round trip and no snapshot. It is
        // skipped on a device with nothing remembered, so reading an iPhone
        // that never stalled is unchanged.
        let checkApp = unattributedStall == target.device || memory.holdsAny(device: target.device)
        let checkState = checkApp || (target.android && display == nil)
        task = Task { [weak self] in
            guard let self else { return }
            var began = self.clock(), observing = false, held = false, overrode = false
            do {
                if checkState {
                    diagnostic("state-check", ["app": checkApp])
                    let value = try await request("state", body: [:], target: target)
                    try Task.checkCancellation()
                    guard self.target == target, self.readID == token else { return }
                    guard let state = value as? [String: Any],
                          let app = (state["app"] as? [String: Any])?["bundleId"] as? String, !app.isEmpty else {
                        throw MirrorAXError.unavailable
                    }
                    if target.android, let screen = state["screen"] as? [String: Any],
                       let width = screen["width"] as? Double, let height = screen["height"] as? Double,
                       width > 0, height > 0, let orientation = state["orientation"] as? String {
                        self.display = (CGSize(width: width, height: height), orientation.contains("LANDSCAPE"))
                    }
                    if checkApp {
                        // The helper is back after a stall nobody could put a
                        // name to. The app in front now is the best account of
                        // it: the previous app had been read without trouble.
                        if self.unattributedStall != nil {
                            self.unattributedStall = nil
                            self.registerStall(device: target.device, app: app)
                        }
                        overrode = app == self.overrideApp
                        self.overrideApp = nil
                        if !overrode, let until = self.memory.heldUntil(device: target.device, app: app) {
                            self.hold(app, until: until)
                            held = true
                        } else {
                            if let previous = self.heldApp {
                                self.heldApp = nil
                                self.host?.offerReadAnyway(false)
                                diagnostic("hold-lifted", ["requested": overrode])
                                if !overrode { notice("reading resumed: \(previous) is no longer in front") }
                            }
                            self.snapshotApp = app
                        }
                    }
                }
                if !held {
                    began = self.clock(); observing = true; self.requestBegan = began
                    diagnostic("request", [:])
                    let value = try await request("observe", body: ["screenshot": false, "timeoutMs": 8000], target: target)
                    try Task.checkCancellation()
                    guard self.target == target, self.readID == token else { return }
                    var observed = try MirrorAXObservation.parse(value)
                    diagnostic("response", ["children": observed.root.children.count, "stable": observed.stable])
                    if target.android, let display = self.display {
                        // State and tree are sampled apart; the device may have
                        // turned in between, which swaps the display's sides.
                        let turned = display.landscape != observed.orientation.contains("LANDSCAPE")
                        let screen = CGRect(x: 0, y: 0, width: turned ? display.size.height : display.size.width,
                                            height: turned ? display.size.width : display.size.height)
                        if screen.insetBy(dx: -1, dy: -1).contains(observed.root.rect) { observed.screen = screen }
                        // A window that does not fit means the display changed
                        // (a foldable, a resolution change): ask again next time.
                        else { self.display = nil }
                    }
                    if overrode { self.memory.release(device: target.device, app: observed.app) }
                    let changed = observation?.root.matches(observed.root) != true || observation?.screen != observed.screen
                        || observation?.app != observed.app || observation?.orientation != observed.orientation
                    self.observation = observed; self.sampledAt = clock()
                    if changed { self.revision = UUID() }
                    if let host = self.host {
                        if changed { self.elements = [MirrorAXElement(node: observed.root, revision: self.revision, bridge: self, parent: host)] }
                        self.help = observed.stable ? "Device accessibility content." : "Device content is changing; read again before acting."
                        if changed { NSAccessibility.post(element: host, notification: .layoutChanged) }
                    }
                    self.retryAt = -Double.infinity
                    self.failures = 0
                    // A snapshot owns the device helper while it runs, and input
                    // waits behind it. Video and animation change every frame, so
                    // refreshing on each change would chain slow snapshots back to
                    // back. After a slow one, frame changes wait three times as long
                    // as it took, which keeps the helper mostly free for input.
                    let took = self.clock() - began
                    self.frameHoldUntil = took > 0.5 ? self.clock() + min(10, 3 * took) : -Double.infinity
                    self.dirty = self.changeVersion != version || !observed.stable
                }
            } catch {
                diagnostic("failure", ["kind": String(reflecting: type(of: error)), "cancelled": Task.isCancelled])
                guard !Task.isCancelled, self.target == target, self.readID == token else { return }
                self.invalidate()
                // Back off: a failing snapshot must not be retried every second
                // against a helper that is already struggling.
                self.failures += 1
                // Only a snapshot stalls. Whatever the app, the next attempt
                // begins with the state query and so cannot repeat it.
                if observing, self.clock() - began >= 5 { self.registerStall(device: target.device, app: self.snapshotApp) }
                self.retryAt = clock() + min(8, pow(2, Double(self.failures - 1)))
                self.frameHoldUntil = self.retryAt
                self.help = "Device content unavailable. Read again to retry."
            }
            guard self.target == target, self.readID == token || self.task == nil else { return }
            self.task = nil
            if self.dirty { self.scheduleRefresh() }
        }
    }

    // Presentation is an event source for changes made on the physical phone
    // and third-party app updates. Sample a small luminance grid only while AX
    // has a reader. Never retain pixels or hash them for identity/analytics.
    func presented(_ pixel: CVPixelBuffer) {
        guard wantsVisualEvents else { visualHash = nil; return }
        guard CVPixelBufferLockBaseAddress(pixel, .readOnly) == kCVReturnSuccess else { return }
        defer { CVPixelBufferUnlockBaseAddress(pixel, .readOnly) }
        // Only layouts whose bytes can be indexed directly. A hardware decoder
        // may hand back a compressed or 10-bit surface that reports the picture's
        // width and height but holds far fewer addressable bytes; sampling one
        // by row and column reads outside the buffer and crashes the app.
        let format = CVPixelBufferGetPixelFormatType(pixel)
        let planar = format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
            || format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
        guard planar || format == kCVPixelFormatType_32BGRA else { return }
        let width = planar ? CVPixelBufferGetWidthOfPlane(pixel, 0) : CVPixelBufferGetWidth(pixel)
        let height = planar ? CVPixelBufferGetHeightOfPlane(pixel, 0) : CVPixelBufferGetHeight(pixel)
        let stride = planar ? CVPixelBufferGetBytesPerRowOfPlane(pixel, 0) : CVPixelBufferGetBytesPerRow(pixel)
        guard width > 0, height > 0, stride >= width * (planar ? 1 : 4),
              let base = planar ? CVPixelBufferGetBaseAddressOfPlane(pixel, 0) : CVPixelBufferGetBaseAddress(pixel) else { return }
        let bytes = base.assumingMemoryBound(to: UInt8.self)
        var hash = UInt64(width) &* 1099511628211 ^ UInt64(height)
        for row in 0..<128 { for column in 0..<96 {
            let x = min(width - 1, (2 * column + 1) * width / 192)
            let y = min(height - 1, (2 * row + 1) * height / 256)
            let offset = y * stride + x * (planar ? 1 : 4)
            let luminance = planar ? Int(bytes[offset]) : (Int(bytes[offset]) + 2 * Int(bytes[offset + 1]) + Int(bytes[offset + 2])) / 4
            hash = (hash ^ UInt64(luminance / 16)) &* 1099511628211
        } }
        if visualHash != hash { visualHash = hash; contentDidChange("frame") }
    }

    func canAct(_ element: MirrorAXElement) -> Bool {
        isCurrent(element) && observation?.stable == true
            && actionTask == nil && element.node.enabled && allowsActions()
    }

    func isCurrent(_ element: MirrorAXElement) -> Bool {
        target != nil && element.revision == revision && clock() - sampledAt < 12
    }

    func perform(_ element: MirrorAXElement, scrollDown: Bool) -> Bool {
        perform(element, action: .scroll(scrollDown ? .down : .up))
    }

    func perform(_ element: MirrorAXElement, action requested: MirrorAXAction = .press) -> Bool {
        diagnostic("action", ["current": element.revision == revision, "stable": observation?.stable == true,
            "fresh": clock() - sampledAt < 12, "ready": allowsActions(), "visible": element.node.visible,
            "busy": actionTask != nil])
        guard canAct(element), element.node.visible, let observation, let target else { refreshIfNeeded(); return false }
        var body: [String: Any] = ["requestId": UUID().uuidString, "observationId": observation.id,
            "expectedApp": observation.app, "expectedOrientation": observation.orientation, "timeoutMs": 8000]
        let action: String
        switch requested {
        case .scroll(let direction):
            guard element.node.scrollable else { return false }
            let screen = observation.screen
            let visible = element.node.rect.intersection(screen)
            // Forty points on iPhone; about the same share of an Android display.
            let least = observation.root.android ? min(screen.width, screen.height) / 10 : 40
            guard !visible.isNull, visible.width > least, visible.height > least else { return false }
            let left = (visible.minX + visible.width * 0.25 - screen.minX) / screen.width
            let right = (visible.minX + visible.width * 0.75 - screen.minX) / screen.width
            let top = (visible.minY + visible.height * 0.25 - screen.minY) / screen.height
            let bottom = (visible.minY + visible.height * 0.75 - screen.minY) / screen.height
            let x = (left + right) / 2, y = (top + bottom) / 2
            switch direction {
            case .down: body["points"] = [[x, bottom, 0], [x, top, 250]]
            case .up: body["points"] = [[x, top, 0], [x, bottom, 250]]
            case .left: body["points"] = [[left, y, 0], [right, y, 250]]
            case .right: body["points"] = [[right, y, 0], [left, y, 250]]
            }
            body["end"] = 250; action = "gesture"
        case .press:
            guard element.node.pressable else { return false }
            body["selector"] = ["using": "xpath", "value": element.node.path]
            action = "tap"
        case .replaceText(let text):
            guard element.node.editable, !element.node.secure, text.count <= 10000 else { return false }
            body["action"] = "replaceText"; body["text"] = text; action = "element-action"
        case .adjust(let value):
            guard element.node.kind == "Slider", value.isFinite, (0...1).contains(value) else { return false }
            body["action"] = "adjust"; body["value"] = value; action = "element-action"
        case .element(let name):
            guard (name == .focus && element.node.editable)
                || ([MirrorAXElementAction.increment, .decrement].contains(name) && element.node.kind == "Slider")
                || ([MirrorAXElementAction.doubleTap, .longPress].contains(name) && element.node.pressable) else { return false }
            body["action"] = name.rawValue; action = "element-action"
        }
        if action == "element-action" { body["selector"] = ["using": "xpath", "value": element.node.path] }
        let token = UUID()
        actionID = token
        readID = UUID()
        task?.cancel(); task = nil
        scheduled?.cancel(); scheduled = nil
        actionTask = Task { [weak self] in
            guard let self else { return }
            do {
                _ = try await request(action, body: body, target: target)
                try Task.checkCancellation()
            } catch {
                // No replay: a transport timeout may have executed on the phone.
                if self.target == target, !Task.isCancelled, let host = self.host {
                    NSAccessibility.post(element: host, notification: .announcementRequested,
                        userInfo: [.announcement: "Device action could not be confirmed. Read the screen again.", .priority: NSAccessibilityPriorityLevel.medium.rawValue])
                }
            }
            guard self.target == target, self.actionID == token else { return }
            self.actionTask = nil
            self.invalidate()
            self.retryAt = -Double.infinity
            self.refreshIfNeeded()
        }
        prepareInput()
        return true // Admitted; completion is reflected by the subsequent tree.
    }

    private func request(_ route: String, body: [String: Any], target: MirrorAXTarget) async throws -> Any {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(target.port)/api/\(route)")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(target.instance, forHTTPHeaderField: "x-iportal-instance")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await send(request)
        guard data.count <= 16 * 1024 * 1024, let http = response as? HTTPURLResponse,
              http.statusCode == 200, http.value(forHTTPHeaderField: "x-iportal-instance") == target.instance,
              let json = try JSONSerialization.jsonObject(with: data) as? [String: Any], json["ok"] as? Bool == true else {
            throw MirrorAXError.unavailable
        }
        return json["value"] ?? NSNull()
    }
}
