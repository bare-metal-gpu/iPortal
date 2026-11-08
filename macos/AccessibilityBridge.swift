import Cocoa

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
        setAccessibilityValue(node.value)
        setAccessibilityIdentifier("iportal.remote.\(revision.uuidString).\(node.path)")
        if node.scrollable {
            setAccessibilityCustomActions(["Scroll down", "Scroll up"].enumerated().map { index, name in
                NSAccessibilityCustomAction(name: name) { [weak self] in
                    guard let self else { return false }
                    return self.bridge?.perform(self, scrollDown: index == 0) ?? false
                }
            })
        }
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
    override func isAccessibilitySelectorAllowed(_ selector: Selector) -> Bool {
        if selector == #selector(accessibilityPerformPress) {
            return node.pressable && node.visible && bridge?.isCurrent(self) == true
        }
        // Setting AXValue means replacement, whereas /api/type inserts. Keep
        // the existing Mac keyboard route rather than pretending these agree.
        if selector == #selector(setAccessibilityValue(_:)) || selector == #selector(setAccessibilityFocused(_:)) { return false }
        return super.isAccessibilitySelectorAllowed(selector)
    }
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
    private var attemptedAt = -Double.infinity
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
        attemptedAt = -Double.infinity
        help = next == nil ? "Device content unavailable." : "Read the device’s accessible content."
    }

    func invalidate() {
        diagnostic("invalidate", ["roots": elements.count, "pending": task != nil])
        task?.cancel(); task = nil
        revision = UUID(); observation = nil; elements = []; sampledAt = -Double.infinity
        if let host { NSAccessibility.post(element: host, notification: .layoutChanged) }
    }

    func refreshIfNeeded() {
        guard let target, task == nil, actionTask == nil, clock() - attemptedAt >= 2 else { return }
        let token = revision
        diagnostic("request", [:])
        attemptedAt = clock()
        task = Task { [weak self] in
            guard let self else { return }
            defer { if self.revision == token { self.task = nil } }
            do {
                let value = try await request("observe", body: ["screenshot": false, "timeoutMs": 8000], target: target)
                try Task.checkCancellation()
                guard self.target == target, self.revision == token else { return }
                let observed = try MirrorAXObservation.parse(value)
                diagnostic("response", ["children": observed.root.children.count, "stable": observed.stable])
                let changed = observation?.root.matches(observed.root) != true
                    || observation?.app != observed.app || observation?.orientation != observed.orientation
                self.observation = observed; self.sampledAt = clock()
                // Keep object identity for an unchanged tree (screen readers may
                // still be traversing it). Changed content retires every handle.
                if changed { self.revision = UUID() }
                if let host = self.host {
                    if changed { self.elements = [MirrorAXElement(node: observed.root, revision: self.revision, bridge: self, parent: host)] }
                    self.help = observed.stable ? "Device accessibility content." : "Device content is changing; read again before acting."
                    if changed { NSAccessibility.post(element: host, notification: .layoutChanged) }
                }
                self.task = nil
            } catch {
                diagnostic("failure", ["kind": String(reflecting: type(of: error)), "cancelled": Task.isCancelled])
                // Input deliberately cancels its overlapping read. That old
                // callback must not erase the tree owned by the admitted action.
                guard !Task.isCancelled else { return }
                guard self.target == target, self.revision == token else { return }
                self.task = nil
                self.invalidate()
                self.help = "Device content unavailable. Read again to retry."
            }
        }
    }

    func canAct(_ element: MirrorAXElement) -> Bool {
        isCurrent(element) && observation?.stable == true
            && actionTask == nil && element.node.enabled && allowsActions()
    }

    func isCurrent(_ element: MirrorAXElement) -> Bool {
        target != nil && element.revision == revision && clock() - sampledAt < 12
    }

    func perform(_ element: MirrorAXElement, scrollDown: Bool? = nil) -> Bool {
        diagnostic("action", ["current": element.revision == revision, "stable": observation?.stable == true,
            "fresh": clock() - sampledAt < 12, "ready": allowsActions(), "visible": element.node.visible,
            "busy": actionTask != nil])
        guard canAct(element), element.node.visible, let observation, let target else { refreshIfNeeded(); return false }
        var body: [String: Any] = ["requestId": UUID().uuidString, "observationId": observation.id,
            "expectedApp": observation.app, "expectedOrientation": observation.orientation, "timeoutMs": 8000]
        let action: String
        if let down = scrollDown {
            guard element.node.scrollable else { return false }
            let visible = element.node.rect.intersection(observation.root.rect)
            guard !visible.isNull, visible.width > 20, visible.height > 40 else { return false }
            let screen = observation.root.rect
            let x = (visible.midX - screen.minX) / screen.width
            let top = (visible.minY + visible.height * 0.25 - screen.minY) / screen.height
            let bottom = (visible.minY + visible.height * 0.75 - screen.minY) / screen.height
            body["points"] = [[x, down ? bottom : top, 0], [x, down ? top : bottom, 250]]
            body["end"] = 250
            action = "gesture"
        } else {
            guard element.node.pressable else { return false }
            body["selector"] = ["using": "xpath", "value": element.node.path]
            action = "tap"
        }
        let token = UUID()
        actionID = token
        task?.cancel(); task = nil
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
            self.attemptedAt = -Double.infinity
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
