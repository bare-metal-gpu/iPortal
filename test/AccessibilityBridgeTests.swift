import Cocoa
import CoreVideo

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

// Stands in for UserDefaults, so a test never leaves a remembered stall behind.
private final class Store { var value: [String: Any] = [:] }

@main struct AccessibilityBridgeTests {
    private static func memory(_ store: Store, now: @escaping () -> TimeInterval) -> MirrorAXStallMemory {
        MirrorAXStallMemory(load: { store.value }, save: { store.value = $0 }, now: now)
    }
    // An Android node as its helper reports it: Java class name, pixel bounds.
    static func view(_ type: String, label: Any = NSNull(), name: Any = NSNull(), value: Any = NSNull(),
                     traits: String = "", rect: [Int] = [0, 0, 1080, 2400], children: [[String: Any]] = []) -> [String: Any] {
        ["type": type, "label": label, "name": name, "value": value, "traits": traits,
         "rect": ["x": rect[0], "y": rect[1], "width": rect[2], "height": rect[3]],
         "isEnabled": "1", "isVisible": "1", "isFocused": "0", "isAccessible": "1", "children": children]
    }
    static func decoded(_ value: Any) -> Any {
        try! JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: value))
    }
    static func node(_ type: String = "Application", label: String = "Fixture", visible: Bool = true,
                     enabled: Bool = true, children: [[String: Any]] = []) -> [String: Any] {
        ["type": type, "label": label, "name": label, "value": "fixture value",
         "rect": ["x": 0.0, "y": 0.0, "width": 402.0, "height": 874.0],
         "isEnabled": enabled ? "1" : "0", "isVisible": visible ? "1" : "0",
         "isFocused": "0", "isAccessible": "1", "children": children]
    }
    static func observation(_ source: [String: Any], stable: Bool = true, id: String = "observation-a",
                            app: String = "com.example.fixture", orientation: String = "PORTRAIT") -> [String: Any] {
        ["id": id, "app": ["bundleId": app], "orientation": orientation, "stable": stable, "source": source]
    }
    @MainActor static func eventually(line: Int = #line, _ condition: () -> Bool) async {
        for _ in 0..<5000 { if condition() { return }; try? await Task.sleep(nanoseconds: 1_000_000) }
        preconditionFailure("Asynchronous bridge did not settle (line \(line))")
    }
    static func pixels(_ value: UInt8) -> CVPixelBuffer {
        var pixel: CVPixelBuffer?
        precondition(CVPixelBufferCreate(kCFAllocatorDefault, 48, 64, kCVPixelFormatType_32BGRA, nil, &pixel) == kCVReturnSuccess)
        let result = pixel!
        CVPixelBufferLockBaseAddress(result, [])
        memset(CVPixelBufferGetBaseAddress(result)!, Int32(value), CVPixelBufferGetDataSize(result))
        CVPixelBufferUnlockBaseAddress(result, [])
        return result
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
        invalid = node(); for _ in 0..<102 { invalid = node(children: [invalid]) }; rejects(invalid)
        var deep = node(); for _ in 0..<80 { deep = node(children: [deep]) }
        _ = try MirrorAXNode.parse(deep) // Android hierarchies are deeper than iPhone ones.
        invalid = source; invalid["type"] = "Not A Type"; rejects(invalid)
        invalid = source; invalid["type"] = "android..Button"; rejects(invalid)
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
        let white = pixels(255), black = pixels(0)
        for _ in 0..<100 { frameBridge.presented(white) }
        await eventually { frameNetwork.requests.count == 2 }
        frameBridge.presented(black)
        frameNetwork.reply(1, observation(source))
        await eventually { frameNetwork.requests.count == 3 }
        frameNetwork.reply(2, observation(source))
        await eventually { frameBridge.observation != nil && frameNetwork.pending.isEmpty }
        for _ in 0..<100 { frameBridge.presented(black) }
        precondition(frameNetwork.requests.count == 3, "Identical frames cannot trigger another inspection")
        let previous = frameBridge.elements[0]
        now += 13
        frameBridge.contentDidChange("idle")
        precondition(!frameBridge.wantsVisualEvents && !previous.isAccessibilityElement())
        precondition(frameNetwork.requests.count == 3, "Idle events must not turn into background polling")
        frameBridge.update(target: nil)
        // A slow snapshot owns the device helper. Moving pictures must not chain
        // another one straight after it, by frame events or by repeated reads.
        let slowNetwork = Network()
        let slowBridge = MirrorAccessibilityBridge(clock: { now }, send: slowNetwork.send)
        let slowHost = MirrorAXHost(frame: hostRect, bridge: slowBridge)
        slowBridge.update(target: a)
        _ = slowHost.accessibilityChildren()
        await eventually { slowNetwork.requests.count == 1 }
        now += 2
        slowBridge.presented(white)
        slowNetwork.reply(0, observation(source))
        await eventually { !slowBridge.elements.isEmpty }
        slowBridge.presented(black)
        _ = slowHost.accessibilityChildren()
        try await Task.sleep(nanoseconds: 400_000_000)
        precondition(slowNetwork.requests.count == 1, "A two-second snapshot holds frame-driven refreshes for six seconds")
        precondition(!slowBridge.elements.isEmpty, "The cached tree stays readable during the hold")
        slowBridge.receiveContentRevision(1, instance: a.instance)
        await eventually { slowNetwork.requests.count == 2 }
        slowNetwork.reply(1, observation(source))
        await eventually { slowBridge.observation != nil && slowNetwork.pending.isEmpty }
        try await Task.sleep(nanoseconds: 100_000_000)
        slowBridge.presented(white)
        await eventually { slowNetwork.requests.count == 3 }
        slowNetwork.reply(2, observation(source), code: 502)
        await eventually { slowBridge.elements.isEmpty }
        slowNetwork.requests.removeAll()
        now += 1.5; _ = slowHost.accessibilityChildren()
        await eventually { slowNetwork.requests.count == 1 }
        slowNetwork.reply(0, observation(source), code: 502)
        try await Task.sleep(nanoseconds: 200_000_000)
        now += 1.5; _ = slowHost.accessibilityChildren()
        try await Task.sleep(nanoseconds: 300_000_000)
        precondition(slowNetwork.requests.count == 1, "Repeated failures back off instead of retrying every second")
        slowBridge.update(target: nil)
        // A snapshot that stalls is not retried while the same app stays in front.
        var wall = 1_000_000.0
        let stallStore = Store()
        let stallNetwork = Network()
        let stallBridge = MirrorAccessibilityBridge(clock: { now }, memory: memory(stallStore) { wall }, send: stallNetwork.send)
        let stallHost = MirrorAXHost(frame: hostRect, bridge: stallBridge)
        func routes() -> [String] { stallNetwork.requests.map { $0.url!.lastPathComponent } }
        stallBridge.update(target: a)
        _ = stallHost.accessibilityChildren()
        await eventually { routes() == ["observe"] }
        now += 8
        stallNetwork.reply(0, observation(source), code: 408)
        try await Task.sleep(nanoseconds: 200_000_000)
        now += 10; _ = stallHost.accessibilityChildren()
        await eventually { routes() == ["observe", "state"] }
        stallNetwork.reply(1, ["app": ["bundleId": "com.example.video"]])
        try await Task.sleep(nanoseconds: 200_000_000)
        now += 10; _ = stallHost.accessibilityChildren()
        await eventually { routes().count == 3 }
        precondition(routes()[2] == "state", "The stalled app is checked cheaply, never snapshotted again")
        stallNetwork.reply(2, ["app": ["bundleId": "com.example.video"]])
        try await Task.sleep(nanoseconds: 200_000_000)
        now += 10; _ = stallHost.accessibilityChildren()
        await eventually { routes().count == 4 }
        stallNetwork.reply(3, ["app": ["bundleId": "com.example.notes"]])
        await eventually { routes().count == 5 }
        precondition(routes()[3] == "state" && routes()[4] == "observe", "Another app in front lifts the hold")
        stallNetwork.reply(4, observation(source))
        await eventually { !stallBridge.elements.isEmpty }
        precondition(memory(stallStore) { wall }.heldUntil(device: a.device, app: "com.example.video") == wall + 600,
                     "The first stall of an app withholds it for ten minutes")
        stallBridge.update(target: nil)
        // The stall usually arrives as a lost target: the helper was restarted
        // under the pending snapshot. It must still be remembered afterwards.
        let lostNetwork = Network()
        let lostBridge = MirrorAccessibilityBridge(clock: { now }, memory: memory(Store()) { wall }, send: lostNetwork.send)
        let lostHost = MirrorAXHost(frame: hostRect, bridge: lostBridge)
        lostBridge.update(target: a)
        _ = lostHost.accessibilityChildren()
        await eventually { lostNetwork.requests.count == 1 }
        now += 9
        lostBridge.update(target: nil)
        lostBridge.update(target: MirrorAXTarget(port: a.port, instance: a.instance, device: a.device,
                                                 generation: a.generation + 1, epoch: a.epoch + 1))
        _ = lostHost.accessibilityChildren()
        await eventually { lostNetwork.requests.count == 2 }
        precondition(lostNetwork.requests[1].url!.lastPathComponent == "state",
                     "After a restart caused by a stalled snapshot, the snapshot is not repeated")
        lostBridge.update(target: nil)

        // What is remembered about stalls: longer holds for repeat offenders,
        // an end to each hold, and nothing shared between devices.
        let ladderStore = Store()
        let ladder = memory(ladderStore) { wall }
        precondition(!ladder.holdsAny(device: "phone-a") && ladder.heldUntil(device: "phone-a", app: "com.example.video") == nil)
        precondition(ladder.record(device: "phone-a", app: "com.example.video") == wall + 600)
        precondition(ladder.holdsAny(device: "phone-a") && !ladder.holdsAny(device: "phone-b"), "A stall belongs to one device")
        precondition(ladder.heldUntil(device: "phone-a", app: "com.example.notes") == nil, "Other apps stay readable")
        wall += 601
        precondition(!ladder.holdsAny(device: "phone-a"), "A hold ends by itself")
        precondition(ladder.record(device: "phone-a", app: "com.example.video") == wall + 86_400, "A relapse is held for longer")
        ladder.release(device: "phone-a", app: "com.example.video")
        precondition(ladder.heldUntil(device: "phone-a", app: "com.example.video") == nil)
        precondition(ladder.record(device: "phone-a", app: "com.example.video") == wall + 7 * 86_400, "A successful read does not reset the count")
        precondition(ladder.record(device: "phone-a", app: "com.example.video") == wall + 30 * 86_400)
        precondition(ladder.record(device: "phone-a", app: "com.example.video") == wall + 30 * 86_400, "Holds are capped at thirty days")
        ladder.record(device: "phone-b", app: "com.example.other")
        precondition(ladder.heldUntil(device: "phone-a", app: "com.example.video") != nil, "Recording for one device keeps the others")
        wall += 61 * 86_400
        precondition(ladder.record(device: "phone-a", app: "com.example.video") == wall + 600, "A long quiet app starts over")
        for index in 0..<80 { ladder.record(device: "phone-c", app: "com.example.app\(index)") }
        precondition((ladderStore.value["phone-c"] as? [String: Any])?.count == 64, "The list per device is bounded")

        // A stall is remembered across launches: the next session asks which
        // app is in front before any snapshot, and does not take one of it.
        let keptStore = Store()
        let firstNetwork = Network()
        let firstBridge = MirrorAccessibilityBridge(clock: { now }, memory: memory(keptStore) { wall }, send: firstNetwork.send)
        let firstHost = MirrorAXHost(frame: hostRect, bridge: firstBridge)
        var notices: [String] = []
        firstBridge.notice = { notices.append($0) }
        firstBridge.update(target: a)
        for _ in 0..<20 { _ = firstHost.accessibilityChildren() }
        await eventually { firstNetwork.requests.count == 1 }
        precondition(firstNetwork.requests[0].url!.lastPathComponent == "observe", "A device with nothing remembered is read without a state query")
        precondition(notices.count == 1 && notices[0].contains("is reading device content"), "Reading is reported once, not per read")
        now += 8
        firstNetwork.reply(0, observation(source), code: 408)
        await eventually { notices.count == 2 }
        now += 2; _ = firstHost.accessibilityChildren()
        await eventually { firstNetwork.requests.count == 2 }
        precondition(firstNetwork.requests[1].url!.lastPathComponent == "state")
        firstNetwork.reply(1, ["app": ["bundleId": "com.example.video"]])
        await eventually { firstBridge.heldApp == "com.example.video" }
        precondition(firstBridge.elements.isEmpty && firstBridge.help.contains("paused"))
        precondition(firstHost.accessibilityCustomActions()?.map(\.name) == ["Read anyway"])
        precondition(notices.count == 4 && notices[2].contains("com.example.video") && notices[3].contains("paused"))
        precondition(!notices.contains { $0.contains("Fixture") || $0.contains("Open") }, "Notices never carry UI text")
        firstBridge.update(target: nil)
        precondition(firstHost.accessibilityCustomActions()?.isEmpty != false && firstBridge.heldApp == nil)

        let nextNetwork = Network()
        let nextBridge = MirrorAccessibilityBridge(clock: { now }, memory: memory(keptStore) { wall }, send: nextNetwork.send)
        let nextHost = MirrorAXHost(frame: hostRect, bridge: nextBridge)
        func nextRoutes() -> [String] { nextNetwork.requests.map { $0.url!.lastPathComponent } }
        nextBridge.update(target: a)
        _ = nextHost.accessibilityChildren()
        await eventually { nextRoutes() == ["state"] }
        nextNetwork.reply(0, ["app": ["bundleId": "com.example.video"]])
        await eventually { nextBridge.heldApp == "com.example.video" }
        try await Task.sleep(nanoseconds: 100_000_000)
        precondition(nextRoutes() == ["state"], "The first snapshot of a remembered app is never taken")
        // A failed state query must not be followed by a blind snapshot.
        now += 4; _ = nextHost.accessibilityChildren()
        await eventually { nextRoutes().count == 2 }
        nextNetwork.reply(1, [:], code: 502)
        try await Task.sleep(nanoseconds: 100_000_000)
        precondition(nextRoutes() == ["state", "state"] && keptStore.value.count == 1)
        // The reader may insist. A read that works ends the hold.
        precondition(nextHost.accessibilityCustomActions()?.first?.handler?() == true)
        await eventually { nextRoutes().count == 3 }
        precondition(nextRoutes()[2] == "state")
        nextNetwork.reply(2, ["app": ["bundleId": "com.example.video"]])
        await eventually { nextRoutes().count == 4 }
        precondition(nextRoutes()[3] == "observe")
        nextNetwork.reply(3, observation(source, app: "com.example.video"))
        await eventually { !nextBridge.elements.isEmpty }
        precondition(nextBridge.heldApp == nil && nextHost.accessibilityCustomActions()?.isEmpty != false)
        precondition(!memory(keptStore) { wall }.holdsAny(device: a.device))
        now += 0.1; nextBridge.contentDidChange("test")
        await eventually { nextRoutes().count == 5 }
        precondition(nextRoutes()[4] == "observe", "With no hold left, reading goes back to snapshots alone")
        // The helper is restarted under that snapshot. The app is not known
        // (nothing was held, so nothing was asked); it is asked for afterwards.
        now += 9
        nextBridge.update(target: nil)
        nextBridge.update(target: MirrorAXTarget(port: a.port, instance: a.instance, device: a.device, generation: 5, epoch: 5))
        _ = nextHost.accessibilityChildren()
        await eventually { nextRoutes().count == 6 }
        precondition(nextRoutes()[5] == "state")
        nextNetwork.reply(5, ["app": ["bundleId": "com.example.video"]])
        await eventually { nextBridge.heldApp == "com.example.video" }
        precondition(memory(keptStore) { wall }.heldUntil(device: a.device, app: "com.example.video") == wall + 86_400)
        // Another app in front is read; a restart under its snapshot is put
        // down to that app at once, because it was confirmed just before.
        now += 4; _ = nextHost.accessibilityChildren()
        await eventually { nextRoutes().count == 7 }
        nextNetwork.reply(6, ["app": ["bundleId": "com.example.feed"]])
        await eventually { nextRoutes().count == 8 }
        precondition(nextRoutes()[7] == "observe" && nextBridge.heldApp == nil)
        now += 9
        nextBridge.update(target: nil)
        precondition(memory(keptStore) { wall }.heldUntil(device: a.device, app: "com.example.feed") == wall + 600)
        // A hold that ran out costs nothing: no state query, a plain snapshot.
        wall += 2 * 86_400
        nextBridge.update(target: a)
        _ = nextHost.accessibilityChildren()
        await eventually { nextRoutes().count == 9 }
        precondition(nextRoutes()[8] == "observe")
        nextBridge.update(target: nil)

        // Android: Java class names as types, traits, pixel bounds.
        let androidSource = view("android.widget.FrameLayout", children: [
            view("android.widget.Button", label: "Send", traits: "clickable, focusable", rect: [100, 200, 300, 120]),
            view("android.widget.EditText", label: "Message", value: "hi", traits: "clickable, editable, focusable"),
            view("android.widget.EditText", name: "com.example:id/pin", traits: "editable, password"),
            view("android.widget.SeekBar", label: "Volume", value: 30.0),
            view("android.widget.Switch", label: "Wi-Fi", value: "1", traits: "clickable, checkable"),
            view("android.widget.TextView", label: "Title", value: "Title"),
            view("android.widget.ImageView", name: "com.example:id/avatar"),
            view("androidx.compose.ui.platform.ComposeView", children: [
                view("android.view.View", label: "Compose button", traits: "clickable"),
                view("android.view.View", traits: "scrollable", children: [view("android.widget.TextView", label: "Row")]),
                view("android.view.View", traits: "clickable", children: [view("android.widget.TextView", label: "Card")]),
                view("android.view.View", label: "Compose field", traits: "editable"),
            ]),
            view("androidx.recyclerview.widget.RecyclerView", traits: "scrollable"),
            view("com.example.Outer$Inner_View"),
            view("android.widget.ProgressBar", value: 0.5),
        ])
        let android = try MirrorAXNode.parse(decoded(androidSource))
        let views = android.children, compose = views[7].children
        precondition(android.role == .group && android.android && !parsed.android)
        precondition(views[0].role == .button && views[0].pressable && views[0].path == "/*[1]/*[1]")
        precondition(views[1].role == .textField && views[1].editable && views[1].settable && views[1].value as? String == "hi")
        precondition(views[2].secure && views[2].value == nil && !views[2].settable && views[2].label == "pin")
        precondition(views[3].role == .slider && views[3].value as? Double == 30 && views[3].normalizedValue == nil && !views[3].settable)
        precondition(views[4].role == .checkBox && views[4].pressable)
        precondition(views[5].role == .staticText && !views[5].pressable)
        precondition(views[6].role == .image && views[6].label == "avatar" && !views[6].pressable,
                     "An unlabeled view is named by its resource ID, and is not pressable just for being accessible")
        precondition(views[7].role == .group && compose[0].role == .button && compose[1].role == .scrollArea)
        precondition(compose[2].role == .group && compose[2].pressable && compose[2].children[0].path == "/*[1]/*[8]/*[3]/*[1]",
                     "A clickable container can be pressed and still be read into")
        precondition(compose[3].role == .textField && compose[3].editable)
        precondition(views[8].role == .scrollArea && views[8].scrollable && views[9].role == .group && views[10].role == .progressIndicator)

        // The Android root is the active window, here a dialog, and bounds are
        // pixels. Nodes are placed against the display reported by /api/state.
        let dialog = view("android.widget.FrameLayout", rect: [90, 800, 900, 800], children: [
            view("android.widget.Button", label: "OK", traits: "clickable", rect: [540, 1350, 360, 150]),
            view("android.widget.ScrollView", traits: "scrollable", rect: [90, 800, 900, 600]),
        ])
        let phoneState: [String: Any] = ["app": ["bundleId": "com.example.android"], "orientation": "PORTRAIT",
                                         "screen": ["width": 1080, "height": 2400]]
        let pixel = MirrorAXTarget(port: 7102, instance: "server-a", device: "synthetic-android", generation: 1, epoch: 1, android: true)
        let androidNetwork = Network()
        let androidBridge = MirrorAccessibilityBridge(clock: { now }, memory: memory(Store()) { wall }, send: androidNetwork.send)
        let androidHost = MirrorAXHost(frame: hostRect, bridge: androidBridge)
        func androidRoutes() -> [String] { androidNetwork.requests.map { $0.url!.lastPathComponent } }
        androidBridge.update(target: pixel)
        _ = androidHost.accessibilityChildren()
        await eventually { androidRoutes() == ["state"] }
        androidNetwork.reply(0, phoneState)
        await eventually { androidRoutes() == ["state", "observe"] }
        androidNetwork.reply(1, observation(dialog, app: "com.example.android"))
        await eventually { !androidBridge.elements.isEmpty }
        let display = CGRect(x: 0, y: 0, width: 1080, height: 2400)
        precondition(androidBridge.observation?.screen == display, "The display, not the dialog, is the frame of reference")
        let ok = androidBridge.elements[0].descendants[0]
        precondition(MirrorAXNode.frame(ok.node.rect, screen: display, host: CGRect(x: 0, y: 0, width: 360, height: 800))
                     == CGRect(x: 180, y: 300, width: 120, height: 50), "Pixels map to the window by proportion")
        precondition(androidBridge.perform(androidBridge.elements[0].descendants[1], scrollDown: true))
        await eventually { androidRoutes().count == 3 }
        let swipe = try JSONSerialization.jsonObject(with: androidNetwork.requests[2].httpBody!) as! [String: Any]
        precondition((swipe["points"] as? [[Double]]) == [[0.5, 1250.0 / 2400, 0], [0.5, 950.0 / 2400, 250]],
                     "Gestures are normalized to the display")
        androidNetwork.reply(2, [:])
        await eventually { androidRoutes().count == 4 }
        precondition(androidRoutes()[3] == "observe", "The display size is asked for once per connection")
        // Turned on its side between the state query and the snapshot.
        let wide = view("android.widget.FrameLayout", rect: [0, 0, 2400, 1080], children: [
            view("android.widget.Button", label: "OK", traits: "clickable", rect: [540, 400, 360, 150])])
        androidNetwork.reply(3, observation(wide, app: "com.example.android", orientation: "LANDSCAPE"))
        await eventually { androidBridge.observation?.orientation == "LANDSCAPE" }
        precondition(androidBridge.observation?.screen == CGRect(x: 0, y: 0, width: 2400, height: 1080))
        precondition(androidBridge.elements[0].descendants[0].accessibilityPerformPress())
        await eventually { androidRoutes().count == 5 }
        let tap = try JSONSerialization.jsonObject(with: androidNetwork.requests[4].httpBody!) as! [String: Any]
        precondition(androidRoutes()[4] == "tap" && tap["selector"] as? [String: String] == ["using": "xpath", "value": "/*[1]/*[1]"])
        androidBridge.update(target: nil)

        let actionNetwork = Network()
        let actionBridge = MirrorAccessibilityBridge(clock: { now }, send: actionNetwork.send)
        let actionHost = MirrorAXHost(frame: hostRect, bridge: actionBridge)
        var slider = node("Slider", label: "Level"); slider["value"] = "50\u{00a0}%"
        let parsedSlider = try MirrorAXNode.parse(slider)
        precondition(parsedSlider.normalizedValue == 0.5)
        for (text, expected) in [("12,5 %", 0.125), ("100%", 1.0)] {
            var localized = slider; localized["value"] = text
            let parsed = try MirrorAXNode.parse(localized)
            precondition(parsed.normalizedValue == expected)
        }
        for text in ["101%", "1,000%", "50% invalid", "50 points"] {
            var invalid = slider; invalid["value"] = text
            let parsed = try MirrorAXNode.parse(invalid)
            precondition(parsed.normalizedValue == nil)
        }
        var emptyEditor = node("TextField", label: "Input"); emptyEditor["value"] = NSNull()
        let controls = node(children: [emptyEditor, slider,
            node("Button", label: "Tap"), node("ScrollView", label: "Content"), node("SecureTextField", label: "Password")])
        actionBridge.update(target: a); _ = actionHost.accessibilityChildren()
        await eventually { actionNetwork.requests.count == 1 }
        actionNetwork.reply(0, observation(controls))
        await eventually { !actionBridge.elements.isEmpty }
        precondition(actionBridge.elements[0].descendants[0].accessibilityValue() as? String == "")
        precondition(actionBridge.elements[0].descendants[1].accessibilityValue() as? Double == 0.5)
        precondition(actionBridge.elements[0].descendants[1].accessibilityCustomActions()?.map(\.name) == ["Increase", "Decrease"])
        func act(_ index: Int, _ action: MirrorAXAction, expected: String, extra: String? = nil) async throws {
            let offset = actionNetwork.requests.count
            let element = actionBridge.elements[0].descendants[index]
            switch action {
            case .replaceText(let text):
                precondition(element.isAccessibilitySelectorAllowed(#selector(NSAccessibilityElement.setAccessibilityValue(_:))))
                element.setAccessibilityValue(text)
            case .element(.increment): precondition(element.accessibilityPerformIncrement())
            case .element(.decrement): precondition(element.accessibilityPerformDecrement())
            case .adjust(let value):
                precondition(element.isAccessibilitySelectorAllowed(#selector(NSAccessibilityElement.setAccessibilityValue(_:))))
                element.setAccessibilityValue(String(value)) // Computer sends string values.
            default: precondition(actionBridge.perform(element, action: action))
            }
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
        try await act(0, .element(.focus), expected: "element-action", extra: "focus")
        try await act(0, .replaceText("café 世界"), expected: "element-action", extra: "replaceText")
        try await act(0, .replaceText(""), expected: "element-action", extra: "replaceText")
        try await act(1, .element(.increment), expected: "element-action", extra: "increment")
        try await act(1, .element(.decrement), expected: "element-action", extra: "decrement")
        try await act(1, .adjust(0.75), expected: "element-action", extra: "adjust")
        try await act(2, .element(.doubleTap), expected: "element-action", extra: "doubleTap")
        try await act(2, .element(.longPress), expected: "element-action", extra: "longPress")
        try await act(3, .scroll(.left), expected: "gesture")
        try await act(3, .scroll(.right), expected: "gesture")
        let secure = actionBridge.elements[0].descendants[4]
        precondition(!actionBridge.perform(secure, action: .replaceText("secret")))
        precondition(!actionBridge.perform(actionBridge.elements[0].descendants[2], action: .adjust(0.5)))
        precondition(!actionBridge.perform(actionBridge.elements[0].descendants[1], action: .adjust(.nan)))
        precondition(!secure.isAccessibilitySelectorAllowed(#selector(NSAccessibilityElement.setAccessibilityValue(_:))))
        actionBridge.update(target: nil)
        print("Accessibility bridge: roles, off-screen content, password redaction, geometry, guarded actions, scroll, expiry, cancellation, device isolation, remembered stalls and Android trees passed.")
    }
}
