import Foundation
import UIKit
import XCTest

final class iPortalRunner: XCTestCase {
  override func setUp() {
    super.setUp()
    continueAfterFailure = true
  }
  @MainActor func testFixtureAccessibility() throws {
    guard ProcessInfo.processInfo.environment["IPORTAL_FIXTURE_AUDIT"] == "1" else {
      throw XCTSkip("Fixture accessibility audit was not requested")
    }
    // This test is intentionally confined to our fixture. It never audits
    // the user's foreground app or enables/disables VoiceOver.
    let app = XCUIApplication(bundleIdentifier: "com.baremetalgpu.iportal.mobile.fixture")
    app.launch()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
    var issues: [[String: String]] = []
    try app.performAccessibilityAudit { issue in
      issues.append([
        "type": String(issue.auditType.rawValue),
        "description": issue.compactDescription,
        "details": issue.detailedDescription,
        "identifier": issue.element?.identifier ?? "",
      ])
      // The fixture deliberately contains duplicate and disabled controls.
      // Emit an explicit diagnostic report rather than treating a report
      // as proof that the fixture has no accessibility issues.
      return true
    }
    let data = try JSONSerialization.data(withJSONObject: issues, options: [.sortedKeys])
    let report = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
    report.name = "iPortal fixture accessibility issues"
    report.lifetime = .keepAlways
    add(report)
    print("IPORTAL_FIXTURE_ACCESSIBILITY \(String(decoding: data, as: UTF8.self))")
  }
  @MainActor func testServe() async throws {
    let environment = ProcessInfo.processInfo.environment
    guard environment["IPORTAL_AUTOMATION"] == "1",
      let token = environment["IPORTAL_HELPER_TOKEN"]
    else { throw XCTSkip("Automation was not requested") }
    let pixels = UIScreen.main.nativeBounds.size
    let displayPixels = JSONValue.object([
      "width": .number(min(pixels.width, pixels.height)),
      "height": .number(max(pixels.width, pixels.height)),
    ])
    let status = HelperStatus(
      capabilities: try JSONValue.from(IPApple.capabilities()), displayPixels: displayPixels)
    // Media and commands observe the same cached operation ownership.
    let sharedMedia = HelperMedia(status: status)
    let automation = HelperAutomation(status: status, media: sharedMedia)
    let executor = HelperExecutor(status: status) { command in
      try await automation.execute(command)
    }
    let server = HelperHTTPServer(status: status, executor: executor, media: sharedMedia)
    IPApple.startLockObserver { locked in
      status.update(.lock(locked?.boolValue))
      if locked?.boolValue == false, status.snapshot()["automationReady"] != .bool(true) {
        Task { @MainActor in
          do { _ = try automation.foreground() } catch {
            status.update(.authorization(nil))
          }
        }
      }
    }
    defer { IPApple.stopLockObserver() }
    try await server.start(host: environment["USE_IP"] ?? "127.0.0.1", token: token)
    do { _ = try automation.foreground() } catch { status.update(.authorization(nil)) }
    do {
      while !Task.isCancelled, status.snapshot()["phase"] != .string("stopping") {
        try await Task.sleep(for: .milliseconds(100))
      }
    } catch is CancellationError {}
    automation.clipboard.restore()
    await server.stop()
  }
}
