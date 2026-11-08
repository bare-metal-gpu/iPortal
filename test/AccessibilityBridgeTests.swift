import Cocoa

@MainActor private final class Network {
    var requests: [URLRequest] = []
    var pending: [Int: CheckedContinuation<(Data, URLResponse), Error>] = [:]
    func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        let index = requests.count
        requests.append(request)
        return try await withCheckedThrowingContinuation { pending[index] = $0 }
    }
    func reply(_ index: Int, _ value: Any, instance: String = "server-a", code: Int = 200) {
        let data = try! JSONSerialization.data(withJSONObject: ["ok": code == 200, "value": value])
        let response = HTTPURLResponse(url: requests[index].url!, statusCode: code, httpVersion: "HTTP/1.1",
                                      headerFields: ["x-iportal-instance": instance])!
        pending.removeValue(forKey: index)!.resume(returning: (data, response))
    }
}

@main struct AccessibilityBridgeTests {
    static func node(_ type: String = "Application", label: String = "Fixture", visible: Bool = true,
                     enabled: Bool = true, children: [[String: Any]] = []) -> [String: Any] {
        ["type": type, "label": label, "name": label, "value": "fixture value",
         "rect": ["x": 0.0, "y": 0.0, "width": 402.0, "height": 874.0],
         "isEnabled": enabled ? "1" : "0", "isVisible": visible ? "1" : "0",
         "isFocused": "0", "isAccessible": "1", "children": children]
    }
    static func observation(_ source: [String: Any], stable: Bool = true, id: String = "observation-a") -> [String: Any] {
        ["id": id, "app": ["bundleId": "com.example.fixture"], "orientation": "PORTRAIT", "stable": stable, "source": source]
    }
    @MainActor static func eventually(_ condition: () -> Bool) async {
        for _ in 0..<5000 { if condition() { return }; try? await Task.sleep(nanoseconds: 1_000_000) }
        preconditionFailure("Asynchronous bridge did not settle")
    }
    static func rejects(_ source: [String: Any]) {
        do { _ = try MirrorAXNode.parse(source); preconditionFailure("Invalid tree accepted") }
        catch { }
    }

    @MainActor static func main() async throws {
        let source = node(children: [node("Button", label: "Open"), node("StaticText", label: "Off-screen prompt", visible: false),
                                    node("SecureTextField", label: "Password"), node("Button", label: "Disabled", enabled: false),
                                    node("ScrollView", label: "Profile")])
        let parsed = try MirrorAXNode.parse(source)
        precondition(parsed.children.count == 5 && !parsed.children[1].visible)
        precondition(parsed.children[1].label == "Off-screen prompt", "Preserve off-screen content reported by the app")
        precondition(parsed.children[0].path == "/*[1]/*[1]" && parsed.children[4].path == "/*[1]/*[5]")
        precondition(parsed.children[2].value == nil && parsed.children[2].secure, "Password values must never enter AX")
        precondition(parsed.children[0].role == .button && parsed.children[1].role == .staticText)
        var invalid = source; invalid["isVisible"] = "unknown"; rejects(invalid)
        invalid = source; invalid["rect"] = ["x": 0, "y": 0, "width": -1, "height": 20]; rejects(invalid)
        invalid = source; invalid["children"] = "not a tree"; rejects(invalid)
        invalid = node(); for _ in 0..<52 { invalid = node(children: [invalid]) }; rejects(invalid)
        invalid = node(children: Array(repeating: node(), count: 10_000)); rejects(invalid)
        let hostRect = CGRect(x: -600, y: 120, width: 201, height: 437)
        precondition(MirrorAXNode.frame(CGRect(x: 20, y: 40, width: 100, height: 60), screen: parsed.rect, host: hostRect)
                     == CGRect(x: -590, y: 507, width: 50, height: 30), "Retina-independent mapping on negative-coordinate monitors")
        let landscape = CGRect(x: 0, y: 0, width: 874, height: 402)
        precondition(MirrorAXNode.frame(landscape, screen: landscape, host: hostRect) == hostRect, "Oriented geometry must not be rotated twice")
        let outside = MirrorAXNode.frame(CGRect(x: 0, y: 1000, width: 50, height: 50), screen: parsed.rect, host: hostRect)
        precondition(outside.maxY < hostRect.minY, "Off-screen bounds must not alias an on-screen control")

        var now = 0.0
        let network = Network()
        let bridge = MirrorAccessibilityBridge(clock: { now }, send: network.send)
        var focusCount = 0
        bridge.prepareInput = { focusCount += 1 }
        let host = MirrorAXHost(frame: hostRect, bridge: bridge)
        let a = MirrorAXTarget(port: 7100, instance: "server-a", device: "synthetic-a", generation: 1, epoch: 1)
        let b = MirrorAXTarget(port: 7101, instance: "server-b", device: "synthetic-b", generation: 2, epoch: 3)
        bridge.update(target: a)
        precondition(network.requests.isEmpty, "Normal mirroring must not poll accessibility")
        precondition(host.hitTest(.zero) == nil, "Bridge cannot intercept pointer events")
        for _ in 0..<50 { _ = host.accessibilityChildren() }
        await eventually { network.requests.count == 1 }
        precondition(network.requests[0].value(forHTTPHeaderField: "x-iportal-instance") == a.instance)
        let readBody = try JSONSerialization.jsonObject(with: network.requests[0].httpBody!) as! [String: Any]
        precondition(readBody["screenshot"] as? Bool == false)
        network.reply(0, observation(source))
        await eventually { bridge.elements.count == 1 }
        let root = bridge.elements[0], button = root.descendants[0], offscreen = root.descendants[1]
        precondition(root.descendants.count == 5 && root.accessibilityVisibleChildren()?.count == 4)
        precondition(!offscreen.accessibilityPerformPress() && !root.descendants[3].accessibilityPerformPress())
        precondition(!root.descendants[2].isAccessibilitySelectorAllowed(#selector(NSAccessibilityElement.setAccessibilityValue(_:))), "Inserting text cannot masquerade as replacing AXValue")
        for _ in 0..<50 { _ = host.accessibilityChildren() }
        precondition(network.requests.count == 1, "Unchanged reads must use the cache without polling")
        precondition(focusCount == 0, "Inspection and rejected actions cannot steal focus")
        bridge.allowsActions = { false }
        precondition(!button.accessibilityPerformPress(), "A video refresh cannot admit input")
        precondition(root.isAccessibilityElement() && root.accessibilityChildren()?.count == 5 && button.isAccessibilityEnabled(),
                     "Video-only interruption cannot erase readable phone state or falsify the phone's enabled attribute")
        bridge.allowsActions = { true }

        now = 0.1; bridge.contentDidChange("test")
        await eventually { network.requests.count == 2 }
        network.reply(1, observation(source, id: "observation-b"))
        await eventually { bridge.observation?.id == "observation-b" }
        precondition(bridge.elements[0] === root, "Unchanged trees preserve assistive focus and object identity")
        precondition(button.accessibilityPerformPress())
        precondition(focusCount == 1, "Typing after AXPress must belong to the selected device window")
        precondition(!button.accessibilityPerformPress(), "Do not admit overlapping mutations")
        await eventually { network.requests.count == 3 }
        let command = try JSONSerialization.jsonObject(with: network.requests[2].httpBody!) as! [String: Any]
        precondition(command["observationId"] as? String == "observation-b")
        precondition(command["expectedApp"] as? String == "com.example.fixture" && command["expectedOrientation"] as? String == "PORTRAIT")
        precondition((command["selector"] as? [String: String])?["value"] == "/*[1]/*[1]")
        precondition(command["requestId"] is String)
        bridge.invalidate() // A concurrent real click must not leave action ownership stuck.
        network.reply(2, [:], code: 504)
        await eventually { network.requests.count == 4 }
        precondition(network.requests[3].url!.lastPathComponent == "observe", "An uncertain action must never be replayed")
        network.reply(3, observation(source))
        await eventually { !bridge.elements.isEmpty }
        precondition(!button.accessibilityPerformPress(), "Retired objects cannot target replacement content")
        precondition(!button.isAccessibilityElement() && button.accessibilityFrame() == .zero,
                     "Retired handles must not offer coordinates for a client's fallback click")

        let scroll = bridge.elements[0].descendants[4]
        precondition(bridge.perform(scroll, scrollDown: true))
        await eventually { network.requests.count == 5 }
        let gesture = try JSONSerialization.jsonObject(with: network.requests[4].httpBody!) as! [String: Any]
        precondition(network.requests[4].url!.lastPathComponent == "gesture")
        precondition((gesture["points"] as? [[Double]]) == [[0.5, 0.75, 0], [0.5, 0.25, 250]])
        bridge.update(target: b)
        bridge.refreshIfNeeded()
        await eventually { network.requests.count == 6 }
        network.reply(4, [:]) // Obsolete action completion must not clear the new device's request.
        network.reply(5, observation(source), instance: "server-b")
        await eventually { !bridge.elements.isEmpty }
        precondition(bridge.target == b)

        now = 20
        precondition(!bridge.elements[0].isAccessibilityElement(), "Expired content cannot offer stale click coordinates")
        precondition(!bridge.elements[0].descendants[0].accessibilityPerformPress(), "Expired observations are read-only")
        await eventually { network.requests.count == 7 }
        bridge.update(target: a); bridge.refreshIfNeeded()
        await eventually { network.requests.count == 8 }
        network.reply(6, observation(node(label: "WRONG DEVICE")), instance: "server-b")
        network.reply(7, observation(source, stable: false))
        await eventually { !bridge.elements.isEmpty }
        precondition(bridge.elements[0].node.label == "Fixture" && !bridge.elements[0].descendants[0].accessibilityPerformPress())
        now = 23; bridge.refreshIfNeeded()
        await eventually { network.requests.count == 9 }
        network.reply(8, observation(source), instance: "obsolete-server")
        await eventually { bridge.elements.isEmpty }
        precondition(bridge.observation == nil, "Wrong server response must clear stale content")
        bridge.update(target: nil)
        precondition(!host.isAccessibilityElement(), "Disconnected mirrors must not expose a phantom remote tree")
        now = 30; bridge.refreshIfNeeded()
        precondition(network.requests.count == 9 && network.pending.isEmpty)
        // Reproduce the live AX traversal/read cancellation race: pressing an
        // element cancels a refresh, whose late callback must leave it intact.
        let racingNetwork = Network()
        let racingBridge = MirrorAccessibilityBridge(clock: { now }, send: racingNetwork.send)
        let racingHost = MirrorAXHost(frame: hostRect, bridge: racingBridge)
        var cancelledReads = 0
        racingBridge.diagnostic = { event, fields in
            if event == "failure", fields["cancelled"] as? Bool == true { cancelledReads += 1 }
        }
        racingBridge.update(target: a)
        _ = racingHost.accessibilityChildren()
        await eventually { racingNetwork.requests.count == 1 }
        racingNetwork.reply(0, observation(source))
        await eventually { !racingBridge.elements.isEmpty }
        let racingRoot = racingBridge.elements[0]
        now += 0.1; racingBridge.contentDidChange("test"); _ = racingHost.accessibilityChildren()
        await eventually { racingNetwork.requests.count == 2 }
        precondition(racingRoot.descendants[0].accessibilityPerformPress())
        await eventually { racingNetwork.requests.count == 3 }
        racingNetwork.reply(1, observation(source))
        await eventually { cancelledReads == 1 }
        precondition(racingBridge.elements.first === racingRoot, "Cancelled refresh cannot erase an admitted action's tree")
        precondition(!racingRoot.descendants[0].accessibilityPerformPress(), "Cancelled read cannot release mutation ownership")
        racingNetwork.reply(2, [:])
        await eventually { racingNetwork.requests.count == 4 }
        racingNetwork.reply(3, observation(source))
        await eventually { !racingBridge.elements.isEmpty }
        racingBridge.update(target: nil)
        // A changed frame is a push source, independent of another AX read.
        let frameNetwork = Network()
        let frameBridge = MirrorAccessibilityBridge(clock: { now }, send: frameNetwork.send)
        let frameHost = MirrorAXHost(frame: hostRect, bridge: frameBridge)
        frameBridge.update(target: a)
        frameBridge.contentDidChange()
        precondition(frameNetwork.requests.isEmpty, "Events without an AX reader do no inspection")
        _ = frameHost.accessibilityChildren()
        await eventually { frameNetwork.requests.count == 1 }
        frameNetwork.reply(0, observation(source))
        await eventually { !frameBridge.elements.isEmpty }
        for _ in 0..<100 { frameBridge.contentDidChange("burst") }
        await eventually { frameNetwork.requests.count == 2 }
        frameBridge.contentDidChange("during read")
        frameNetwork.reply(1, observation(source))
        await eventually { frameNetwork.requests.count == 3 }
        frameNetwork.reply(2, observation(source))
        await eventually { frameBridge.observation != nil && frameNetwork.pending.isEmpty }
        let previous = frameBridge.elements[0]
        now += 13
        frameBridge.contentDidChange("idle")
        precondition(!frameBridge.wantsVisualEvents && !previous.isAccessibilityElement())
        precondition(frameNetwork.requests.count == 3, "Idle events must not turn into background polling")
        frameBridge.update(target: nil)

        let actionNetwork = Network()
        let actionBridge = MirrorAccessibilityBridge(clock: { now }, send: actionNetwork.send)
        let actionHost = MirrorAXHost(frame: hostRect, bridge: actionBridge)
        var slider = node("Slider", label: "Level"); slider["value"] = "50%"
        let controls = node(children: [node("TextField", label: "Input"), slider,
            node("Button", label: "Tap"), node("ScrollView", label: "Content"), node("SecureTextField", label: "Password")])
        actionBridge.update(target: a); _ = actionHost.accessibilityChildren()
        await eventually { actionNetwork.requests.count == 1 }
        actionNetwork.reply(0, observation(controls))
        await eventually { !actionBridge.elements.isEmpty }
        func act(_ index: Int, _ action: MirrorAXAction, expected: String, extra: String? = nil) async throws {
            let offset = actionNetwork.requests.count
            precondition(actionBridge.perform(actionBridge.elements[0].descendants[index], action: action))
            await eventually { actionNetwork.requests.count == offset + 1 }
            let request = actionNetwork.requests[offset]
            let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
            precondition(request.url!.lastPathComponent == expected)
            if let extra { precondition(body["action"] as? String == extra) }
            precondition(body["observationId"] != nil && body["expectedApp"] != nil)
            actionNetwork.reply(offset, [:])
            await eventually { actionNetwork.requests.count == offset + 2 }
            actionNetwork.reply(offset + 1, observation(controls))
            await eventually { !actionBridge.elements.isEmpty }
        }
        try await act(0, .element("focus"), expected: "element-action", extra: "focus")
        try await act(0, .replaceText("café 世界"), expected: "element-action", extra: "replaceText")
        try await act(0, .replaceText(""), expected: "element-action", extra: "replaceText")
        try await act(1, .element("increment"), expected: "element-action", extra: "increment")
        try await act(1, .element("decrement"), expected: "element-action", extra: "decrement")
        try await act(1, .adjust(0.75), expected: "element-action", extra: "adjust")
        try await act(2, .element("doubleTap"), expected: "element-action", extra: "doubleTap")
        try await act(2, .element("longPress"), expected: "element-action", extra: "longPress")
        try await act(3, .scroll(.left), expected: "gesture")
        try await act(3, .scroll(.right), expected: "gesture")
        let secure = actionBridge.elements[0].descendants[4]
        precondition(!actionBridge.perform(secure, action: .replaceText("secret")))
        precondition(!actionBridge.perform(actionBridge.elements[0].descendants[2], action: .adjust(0.5)))
        precondition(!actionBridge.perform(actionBridge.elements[0].descendants[1], action: .adjust(.nan)))
        precondition(!secure.isAccessibilitySelectorAllowed(#selector(NSAccessibilityElement.setAccessibilityValue(_:))))
        actionBridge.update(target: nil)
        print("Accessibility bridge: roles, off-screen content, password redaction, geometry, guarded actions, scroll, expiry, cancellation and device isolation passed.")
    }
}
