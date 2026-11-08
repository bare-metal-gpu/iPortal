import XCTest

@MainActor final class InputProbeTests: XCTestCase {
    private let app = XCUIApplication()
    private static var uncertain = false
    private static var contactOwned = false
    override func setUpWithError() throws {
        try XCTSkipIf(Self.uncertain || Self.contactOwned, "Prior native outcome/contact is unresolved; restart the isolated test runner")
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        app.launch()
        XCTAssertTrue(app.otherElements["probe.input.surface"].waitForExistence(timeout: 5))
    }
    private func snapshot() throws -> InputSnapshot {
        let value = try XCTUnwrap(app.staticTexts["probe.input.status"].value as? String)
        let snapshot = try JSONDecoder().decode(InputSnapshot.self, from: Data(value.utf8))
        // Only an actual recorder observation releases a possibly persistent
        // raw contact. An Apple completion callback by itself cannot do so.
        if snapshot.active == 0 { Self.contactOwned = false }
        return snapshot
    }
    private func save(_ name: String, _ value: InputSnapshot) throws {
        let attachment = XCTAttachment(data: try JSONEncoder().encode(value), uniformTypeIdentifier: "public.json")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
    func testDirectTouchCalibration() throws {
        let surface = app.otherElements["probe.input.surface"]
        let start = surface.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
        let end = surface.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
        start.press(forDuration: 0.05, thenDragTo: end)
        let result = try snapshot()
        XCTAssertEqual(result.active, 0)
        XCTAssertEqual(result.events.filter { $0.phase == "began" }.count, 1)
        XCTAssertEqual(result.events.filter { $0.phase == "ended" }.count, 1)
        XCTAssertTrue(result.events.contains { $0.phase == "moved" })
        try save("direct-touch-positive-control", result)
    }
    func testIndirectScrollDelivery() throws {
        try XCTSkipUnless(XCUIDevice.shared.supportsPointerInteraction, "Apple reports pointer interaction unavailable on this device")
        let center = app.otherElements["probe.input.surface"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        center.scroll(byDeltaX: 0, deltaY: -100)
        let result = try snapshot()
        try save("indirect-scroll-observation-not-acknowledgement", result)
        XCTAssertEqual(result.active, 0)
        // No observed event is a negative research result, not a transport success.
        print("IPORTAL_PROBE indirectDelivered=\(result.events.contains { $0.phase.hasPrefix("scroll.") })")
    }
    private struct DispatchTiming {
        let started: Double
        let completed: Double
        var acknowledgementMs: Double { (completed - started) * 1000 }
    }
    private func dispatch(_ bridge: ProbeTouchBridge, phase: String, point: CGPoint, confirmation: Double = 0.05) async throws -> DispatchTiming {
        guard !Self.uncertain else { throw NSError(domain: "InputProbe", code: 1) }
        XCTAssertEqual(app.state, .runningForeground)
        let completion = expectation(description: "Apple completion")
        var completed = false
        var completedAt = 0.0
        var failure: Error?
        let size = app.frame.size
        if phase == "begin" || phase == "tap" { Self.contactOwned = true }
        let started = ProcessInfo.processInfo.systemUptime
        bridge.sendPhase(phase, point: point, size: size, confirmation: confirmation) { error in
            completedAt = ProcessInfo.processInfo.systemUptime
            failure = error
            completed = true
            completion.fulfill()
        }
        await fulfillment(of: [completion], timeout: 3)
        guard completed else {
            Self.uncertain = true
            throw NSError(domain: "InputProbe.UnknownOutcome", code: 1)
        }
        if let failure { Self.uncertain = true; throw failure }
        return DispatchTiming(started: started, completed: completedAt)
    }
    func testRawContinuousContact() async throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["IPORTAL_RAW_INPUT_PROBE"] == "1", "Explicit isolated-device raw probe required")
        let surface = app.otherElements["probe.input.surface"].frame
        let point = CGPoint(x: surface.midX, y: surface.midY)
        _ = try await dispatch(ProbeTouchBridge(), phase: "tap", point: point)
        let calibration = try snapshot()
        XCTAssertEqual(calibration.active, 0)
        XCTAssertEqual(calibration.events.filter { $0.phase == "began" }.count, 1)
        XCTAssertEqual(calibration.events.filter { $0.phase == "ended" }.count, 1)
        app.buttons["probe.input.reset"].tap()
        let bridge = ProbeTouchBridge()
        let acknowledgement = try await dispatch(bridge, phase: "begin", point: point)
        var result = try snapshot()
        try save("down-only-after-completion", result)
        print("IPORTAL_PROBE downAckMs=\(acknowledgement.acknowledgementMs) activeAfterAck=\(result.active)")
        // Stop at decisive cancellation. Never label acknowledged chunks as continuous contact.
        if result.active == 0 { return }
        _ = try await dispatch(bridge, phase: "move", point: CGPoint(x: point.x, y: point.y - 30))
        result = try snapshot()
        try save("move-after-completion", result)
        if result.active == 0 { return }
        _ = try await dispatch(bridge, phase: "end", point: point)
        result = try snapshot()
        XCTAssertEqual(result.active, 0)
        try save("contact-after-release", result)
        print("IPORTAL_PROBE continuous=\(result.events.filter { $0.phase == "began" }.count == 1 && !result.events.contains { $0.phase == "cancelled" })")
    }
    func testRawCompletionTiming() async throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["IPORTAL_RAW_INPUT_PROBE"] == "1", "Explicit isolated-device raw probe required")
        let surface = app.otherElements["probe.input.surface"].frame
        let point = CGPoint(x: surface.midX, y: surface.midY)
        var samples: [[String: Double]] = []
        for confirmation in [0.0, 0.05] {
            for _ in 0..<30 {
                app.buttons["probe.input.reset"].tap()
                let timing = try await dispatch(ProbeTouchBridge(), phase: "tap", point: point, confirmation: confirmation)
                let result = try snapshot()
                let began = try XCTUnwrap(result.events.first { $0.phase == "began" })
                let ended = try XCTUnwrap(result.events.first { $0.phase == "ended" })
                XCTAssertEqual(result.active, 0)
                samples.append(["confirmationMs": confirmation * 1000, "ackMs": timing.acknowledgementMs,
                                "onsetMs": (began.timestamp - timing.started) * 1000,
                                "contactMs": (ended.timestamp - began.timestamp) * 1000,
                                "completionTailMs": (timing.completed - ended.timestamp) * 1000])
            }
        }
        let attachment = XCTAttachment(data: try JSONSerialization.data(withJSONObject: samples), uniformTypeIdentifier: "public.json")
        attachment.name = "native-dispatch-timing-not-visible-latency"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
