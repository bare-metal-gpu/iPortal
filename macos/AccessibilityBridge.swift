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
}

enum MirrorAXError: Error { case invalidSnapshot, unavailable }

struct MirrorAXNode {
    let type: String
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
        return type == other.type && label == other.label && sameValue && rect == other.rect
            && enabled == other.enabled && visible == other.visible && focused == other.focused
            && accessible == other.accessible && path == other.path && children.count == other.children.count
            && zip(children, other.children).allSatisfy { $0.matches($1) }
    }

    var secure: Bool { type == "SecureTextField" }
    var editable: Bool { ["TextField", "SecureTextField", "SearchField", "TextView"].contains(type) }
    var normalizedValue: Double? {
        guard type == "Slider", let value = value as? String, value.contains("%") else { return nil }
        let formatter = NumberFormatter()
        formatter.numberStyle = .percent
        guard let number = formatter.number(from: value)?.doubleValue, number.isFinite, (0...1).contains(number) else { return nil }
        return number
    }
    var settable: Bool { (editable && !secure) || normalizedValue != nil }
    var scrollable: Bool { ["ScrollView", "Table", "CollectionView", "WebView"].contains(type) }
    var pressable: Bool {
        ["Button", "Cell", "Link", "Switch", "CheckBox", "RadioButton", "TextField",
         "SecureTextField", "SearchField", "TextView", "PopUpButton"].contains(type)
            || (accessible && ["Other", "Image"].contains(type))
    }
    var role: NSAccessibility.Role {
        switch type {
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

    static func parse(_ value: Any) throws -> Self {
        var remaining = 10_000
        var textRemaining = 8 * 1024 * 1024
        func visit(_ value: Any, _ path: String, _ depth: Int) throws -> Self {
            remaining -= 1
            guard remaining >= 0, depth <= 50,
                  let data = value as? [String: Any], let type = data["type"] as? String,
                  type.range(of: "^[A-Za-z][A-Za-z0-9]*$", options: .regularExpression) != nil,
                  let box = data["rect"] as? [String: Any],
                  let x = box["x"] as? Double, let y = box["y"] as? Double,
                  let width = box["width"] as? Double, let height = box["height"] as? Double,
                  [x, y, width, height].allSatisfy(\.isFinite), width >= 0, height >= 0,
                  let rawChildren = data["children"] as? [Any] else { throw MirrorAXError.invalidSnapshot }
            func flag(_ key: String) throws -> Bool {
                guard let value = data[key] as? String, value == "0" || value == "1" else { throw MirrorAXError.invalidSnapshot }
                return value == "1"
            }
            let label = (data["label"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                ?? (data["name"] as? String) ?? ""
            // Never export password values or containers holding arbitrary JSON.
            let rawValue = data["value"]
            let scalar: Any? = type == "SecureTextField" ? nil
                : ((rawValue is String || rawValue is NSNumber) ? rawValue : nil)
            textRemaining -= label.utf8.count + ((scalar as? String)?.utf8.count ?? 0)
            guard textRemaining >= 0 else { throw MirrorAXError.invalidSnapshot }
            return try Self(type: type, label: label, value: scalar,
                rect: CGRect(x: x, y: y, width: width, height: height),
                enabled: flag("isEnabled"), visible: flag("isVisible"), focused: flag("isFocused"),
                accessible: flag("isAccessible"), path: path,
                children: rawChildren.enumerated().map { try visit($0.element, path + "/*[\($0.offset + 1)]", depth + 1) })
        }
        return try visit(value, "/*[1]", 0)
    }

    // XCTest rectangles are in the current oriented display's top-left space;
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
    static func parse(_ value: Any) throws -> Self {
        guard let json = value as? [String: Any], let id = json["id"] as? String, !id.isEmpty, id.count <= 128,
              let app = json["app"] as? [String: Any], let bundle = app["bundleId"] as? String, !bundle.isEmpty,
              let orientation = json["orientation"] as? String,
              ["PORTRAIT", "LANDSCAPE", "UIA_DEVICE_ORIENTATION_PORTRAIT_UPSIDEDOWN", "UIA_DEVICE_ORIENTATION_LANDSCAPERIGHT"].contains(orientation),
              let stable = json["stable"] as? Bool, let source = json["source"] else { throw MirrorAXError.invalidSnapshot }
        let root = try MirrorAXNode.parse(source)
        guard root.rect.width > 0, root.rect.height > 0 else { throw MirrorAXError.invalidSnapshot }
        return Self(id: id, app: bundle, orientation: orientation, stable: stable, root: root)
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
        super.setAccessibilityValue(node.normalizedValue.map { $0 as Any } ?? node.value)
        if node.normalizedValue != nil { setAccessibilityMinValue(0); setAccessibilityMaxValue(1) }
        setAccessibilityIdentifier("iportal.remote.\(revision.uuidString).\(node.path)")
        let actions: [(String, MirrorAXAction)] = node.scrollable
            ? [("Scroll down", .scroll(.down)), ("Scroll up", .scroll(.up)), ("Scroll left", .scroll(.left)), ("Scroll right", .scroll(.right))]
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
        return MirrorAXNode.frame(node.rect, screen: observation.root.rect, host: frame)
    }
    override func isAccessibilityEnabled() -> Bool { node.enabled && bridge?.isCurrent(self) == true }
    override func isAccessibilityFocused() -> Bool { node.focused }
    override func accessibilityHelp() -> String? { node.visible ? nil : "Off screen" }
    override func accessibilityPerformPress() -> Bool { bridge?.perform(self) ?? false }
    override func accessibilityPerformIncrement() -> Bool {
        node.type == "Slider" && bridge?.perform(self, action: .element(.increment)) == true
    }
    override func accessibilityPerformDecrement() -> Bool {
        node.type == "Slider" && bridge?.perform(self, action: .element(.decrement)) == true
    }
    override func setAccessibilityValue(_ value: Any?) {
        // Initialization sets the cached value before an observation is bound.
        guard bridge?.isCurrent(self) == true else { return }
        if node.editable && !node.secure, let text = value as? String, text.count <= 10000 {
            _ = bridge?.perform(self, action: .replaceText(text))
        } else if node.type == "Slider", let value = value as? NSNumber,
                  CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite,
                  (0...1).contains(value.doubleValue) {
            _ = bridge?.perform(self, action: .adjust(value.doubleValue))
        }
    }
    override func isAccessibilitySelectorAllowed(_ selector: Selector) -> Bool {
        if selector == #selector(accessibilityPerformPress) {
            return node.pressable && node.visible && bridge?.isCurrent(self) == true
        }
        if selector == #selector(setAccessibilityValue(_:)) { return node.settable && node.visible && node.enabled && bridge?.isCurrent(self) == true }
        if selector == #selector(accessibilityPerformIncrement) || selector == #selector(accessibilityPerformDecrement) {
            return node.type == "Slider" && node.visible && node.enabled && bridge?.isCurrent(self) == true
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
         send: @escaping (URLRequest) async throws -> (Data, URLResponse) = { try await URLSession.shared.data(for: $0) }) {
        self.clock = clock; self.send = send
    }

    func update(target next: MirrorAXTarget?) {
        guard target != next else { return }
        diagnostic("target", ["available": next != nil, "epoch": next?.epoch ?? -1])
        target = next
        task?.cancel(); task = nil
        actionID = UUID()
        actionTask?.cancel(); actionTask = nil
        invalidate()
        scheduled?.cancel(); scheduled = nil
        demandUntil = -Double.infinity; demandReportedAt = -Double.infinity
        retryAt = -Double.infinity; visualHash = nil; contentRevision = nil
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
    func refreshIfNeeded() {
        guard target != nil else { return }
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
        let wait = max(0.12, retryAt - clock())
        scheduled = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(min(wait, 5) * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            self.scheduled = nil
            if self.wantsVisualEvents { self.startRefresh() }
        }
    }

    private func startRefresh() {
        guard dirty, let target, task == nil, actionTask == nil, clock() >= retryAt else { return }
        scheduled?.cancel(); scheduled = nil
        let token = UUID(), version = changeVersion
        readID = token; dirty = false
        diagnostic("request", [:])
        task = Task { [weak self] in
            guard let self else { return }
            do {
                let value = try await request("observe", body: ["screenshot": false, "timeoutMs": 8000], target: target)
                try Task.checkCancellation()
                guard self.target == target, self.readID == token else { return }
                let observed = try MirrorAXObservation.parse(value)
                diagnostic("response", ["children": observed.root.children.count, "stable": observed.stable])
                let changed = observation?.root.matches(observed.root) != true
                    || observation?.app != observed.app || observation?.orientation != observed.orientation
                self.observation = observed; self.sampledAt = clock()
                if changed { self.revision = UUID() }
                if let host = self.host {
                    if changed { self.elements = [MirrorAXElement(node: observed.root, revision: self.revision, bridge: self, parent: host)] }
                    self.help = observed.stable ? "Device accessibility content." : "Device content is changing; read again before acting."
                    if changed { NSAccessibility.post(element: host, notification: .layoutChanged) }
                }
                self.retryAt = -Double.infinity
                self.dirty = self.changeVersion != version || !observed.stable
            } catch {
                diagnostic("failure", ["kind": String(reflecting: type(of: error)), "cancelled": Task.isCancelled])
                guard !Task.isCancelled, self.target == target, self.readID == token else { return }
                self.invalidate()
                self.retryAt = clock() + 1
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
        let planar = CVPixelBufferIsPlanar(pixel)
        guard planar || CVPixelBufferGetPixelFormatType(pixel) == kCVPixelFormatType_32BGRA else { return }
        let width = planar ? CVPixelBufferGetWidthOfPlane(pixel, 0) : CVPixelBufferGetWidth(pixel)
        let height = planar ? CVPixelBufferGetHeightOfPlane(pixel, 0) : CVPixelBufferGetHeight(pixel)
        let stride = planar ? CVPixelBufferGetBytesPerRowOfPlane(pixel, 0) : CVPixelBufferGetBytesPerRow(pixel)
        guard width > 0, height > 0,
              let base = planar ? CVPixelBufferGetBaseAddressOfPlane(pixel, 0) : CVPixelBufferGetBaseAddress(pixel) else { return }
        let bytes = base.assumingMemoryBound(to: UInt8.self)
        var hash = UInt64(width) &* 1099511628211 ^ UInt64(height)
        for row in 0..<32 { for column in 0..<24 {
            let x = min(width - 1, (2 * column + 1) * width / 48)
            let y = min(height - 1, (2 * row + 1) * height / 64)
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
            let visible = element.node.rect.intersection(observation.root.rect)
            guard !visible.isNull, visible.width > 40, visible.height > 40 else { return false }
            let screen = observation.root.rect
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
            guard element.node.type == "Slider", value.isFinite, (0...1).contains(value) else { return false }
            body["action"] = "adjust"; body["value"] = value; action = "element-action"
        case .element(let name):
            guard (name == .focus && element.node.editable)
                || ([MirrorAXElementAction.increment, .decrement].contains(name) && element.node.type == "Slider")
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
