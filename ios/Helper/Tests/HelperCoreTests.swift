import XCTest

@testable import HelperCore

final class HelperCoreTests: XCTestCase {
  func testRelativeSliderAdjustmentExceedsRoundedReadbackAndClampsEndpoints() throws {
    XCTAssertEqual(try SliderAdjustment.relativePosition(0.8, increment: false), 0.7, accuracy: 0.0001)
    XCTAssertEqual(try SliderAdjustment.relativePosition(0.7, increment: true), 0.8, accuracy: 0.0001)
    XCTAssertEqual(try SliderAdjustment.relativePosition(0, increment: false), 0)
    XCTAssertEqual(try SliderAdjustment.relativePosition(1, increment: true), 1)
    for invalid in [Double.nan, .infinity, -0.1, 1.1] {
      XCTAssertThrowsError(try SliderAdjustment.relativePosition(invalid, increment: true))
    }
  }
  func testElementActionsRejectMalformedPayloadsBeforeDispatch() throws {
    XCTAssertTrue(Operation.elementAction.mutates)
    XCTAssertTrue(Operation.elementAction.guarded)
    let cases: [[String: JSONValue]] = [
      ["action": .string("replaceText")],
      ["action": .string("focus"), "text": .string("unexpected")],
      ["action": .string("adjust"), "value": .number(1.1)],
      ["action": .string("adjust"), "value": .string("0.5")],
      ["action": .string("increment"), "value": .number(0.5)],
      ["action": .string("unknown")],
    ]
    for fields in cases {
      var args = fields
      args["id"] = .string("synthetic-element")
      XCTAssertThrowsError(try Operation.elementAction.validate(.object(args)))
    }
    XCTAssertNoThrow(try Operation.elementAction.validate(.object([
      "id": .string("synthetic-element"), "action": .string("replaceText"), "text": .string("")
    ])))
  }
  func testWebNavigationSharesStrictURLCorpus() throws {
    let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .appendingPathComponent("../../../test/fixtures/web-urls.json")
    let urls = try JSONDecoder().decode([String: [String]].self, from: Data(contentsOf: file))
    for value in try XCTUnwrap(urls["valid"]) {
      XCTAssertNoThrow(try Operation.openURL.validate(.object(["url": .string(value)])), value)
    }
    for value in try XCTUnwrap(urls["invalid"]) {
      XCTAssertThrowsError(try Operation.openURL.validate(.object(["url": .string(value)])), value)
    }
    XCTAssertTrue(Operation.openURL.mutates)
    XCTAssertTrue(Operation.openURL.guarded)
  }
  func testSnapshotPreorderRetainsRootDuplicatesAndSiblingOrder() {
    struct Tree {
      let name: String
      let children: [Tree]
    }
    let tree = Tree(
      name: "root",
      children: [
        Tree(name: "duplicate", children: [Tree(name: "nested", children: [])]),
        Tree(name: "duplicate", children: []), Tree(name: "last", children: []),
      ])
    XCTAssertEqual(
      SelectorIndex.preorder(tree, children: \.children).map(\.name),
      ["root", "duplicate", "nested", "duplicate", "last"])
  }
  func testInputGuardsRejectOppositeOrientationsAndChangedApps() throws {
    for (expected, actual) in [
      ("PORTRAIT", "UIA_DEVICE_ORIENTATION_PORTRAIT_UPSIDEDOWN"),
      ("LANDSCAPE", "UIA_DEVICE_ORIENTATION_LANDSCAPERIGHT"),
    ] {
      XCTAssertThrowsError(
        try InputGuard.check(
          .object(["expectedOrientation": .string(expected)]),
          bundle: "fixture", orientation: actual))
    }
    XCTAssertThrowsError(
      try InputGuard.check(
        .object(["expectedBundleId": .string("old")]),
        bundle: "new", orientation: "PORTRAIT"))
    for operation in [Operation.text, .key, .tapElement, .typeElement] {
      var args: [String: JSONValue] = [
        "expectedBundleId": .string("fixture"), "expectedOrientation": .string("PORTRAIT"),
      ]
      switch operation {
      case .text: args["text"] = .string("synthetic")
      case .key:
        args["key"] = .string("ArrowLeft")
        args["modifiers"] = .array([])
      case .tapElement: args["id"] = .string("id")
      case .typeElement:
        args["id"] = .string("id")
        args["text"] = .string("synthetic")
      default: break
      }
      XCTAssertNoThrow(try operation.validate(.object(args)))
      args["expectedOrientation"] = .string("SIDEWAYS")
      XCTAssertThrowsError(try operation.validate(.object(args)))
    }
  }
  func testDuplicateAccessibilityIDsDoNotCrashXPathIndex() throws {
    let nodes = [(path: "0.1", appleID: "0"), (path: "0.2", appleID: "0")]
    XCTAssertEqual(try SelectorIndex.build(nodes, key: \.path).count, 2)
    XCTAssertThrowsError(try SelectorIndex.build(nodes + [nodes[0]], key: \.path)) { error in
      XCTAssertEqual((error as? HelperFailure)?.code, "invalid snapshot")
    }
  }
  func testClassChainEscapingAndIndexes() throws {
    let steps = try ClassChain.parse(
      "**/XCUIElementTypeCell[`label == 'a/b[c]'`][-1]/XCUIElementTypeButton[2]")
    XCTAssertEqual(steps.count, 2)
    XCTAssertTrue(steps[0].descendants)
    XCTAssertEqual(
      steps[0].filters, [.predicate("label == 'a/b[c]'", descendants: false), .index(-1)])
    for malformed in ["", "**/", "*/", "*[0]", "*[`bad]", "*[]", "*[1]extra", "**/*/../../*"] {
      XCTAssertThrowsError(try ClassChain.parse(malformed), malformed)
    }
  }
  func testPredicateLiteralsCannotBeMistakenForDispatch() throws {
    try PredicateSyntax.validate("label == 'FUNCTION(hi)' AND name == \"CAST(foo)\"")
    try PredicateSyntax.validate("label == 'a\\'FUNCTION(foo)'")
    XCTAssertThrowsError(try PredicateSyntax.validate("FUNCTION(SELF, 'description') == 'x'"))
    XCTAssertThrowsError(try PredicateSyntax.validate("label == CAST('x', 'NSString')"))
  }
  func testUnknownDoesNotBecomeReadyOrLocked() {
    var state = HelperLifecycle()
    state.reduce(.start)
    state.reduce(.authenticated)
    state.reduce(.authorization(true))
    XCTAssertEqual(state.phase, .authenticating)
    state.reduce(.lock(false))
    XCTAssertEqual(state.phase, .ready)
    state.reduce(.lock(nil))
    XCTAssertEqual(state.phase, .authenticating)
    state.reduce(.lock(true))
    XCTAssertEqual(state.phase, .locked)
  }
  func testLateCompletionCannotClearBlockedOperation() {
    var state = HelperLifecycle()
    state.reduce(.start)
    state.reduce(.authenticated)
    state.reduce(.begin("a"))
    state.reduce(.begin("b"))
    XCTAssertEqual(state.active, "a")
    state.reduce(.finish("b"))
    XCTAssertEqual(state.active, "a")
    state.reduce(.stalled("a"))
    state.reduce(.finish("a"))
    XCTAssertEqual(state.phase, .blocked)
    state.reduce(.begin("c"))
    XCTAssertNil(state.active)
  }
  func testMediaFailureCannotBeClearedByLateReadiness() {
    var state = HelperLifecycle()
    state.reduce(.start)
    state.reduce(.authorization(true))
    state.reduce(.lock(false))
    state.reduce(.failed)
    state.reduce(.authorization(true))
    state.reduce(.lock(false))
    XCTAssertEqual(state.phase, .blocked)
    XCTAssertNil(state.active)
    state.reduce(.stop)
    state.reduce(.failed)
    XCTAssertEqual(state.phase, .stopping)
  }
  func testAuthenticationRejectsAmbiguityAndBrowserRequests() {
    let token = String(repeating: "a", count: 64)
    let auth = ("Authorization", "Bearer " + String(repeating: "a", count: 64))
    XCTAssertTrue(HelperProtocol.authorized([auth], token: token))
    for headers in [
      [auth, auth], [auth, ("Origin", "null")], [auth, ("Sec-Fetch-Site", "same-origin")],
      [("Authorization", "Bearer bad")], [],
    ] {
      XCTAssertFalse(HelperProtocol.authorized(headers, token: token))
    }
  }
  func testDuplicateCallbackCannotResumeTwice() {
    let once = CallbackOnce()
    let count = NSLock()
    var completions = 0
    DispatchQueue.concurrentPerform(iterations: 100) { _ in
      once.run {
        count.lock()
        completions += 1
        count.unlock()
      }
    }
    XCTAssertEqual(completions, 1)
  }
  func testSharedWireCorpus() throws {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .appendingPathComponent("../../../test/fixtures/helper-contract.json")
    let corpus = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
    let commands = try XCTUnwrap(corpus["commands"].array)
    XCTAssertEqual(Set(commands.compactMap { $0["operation"].string }), Set(Operation.allCases.map(\.rawValue)))
    for raw in commands {
      let data = try JSONEncoder().encode(raw)
      let command = try HelperCommand.decode(data)
      var args = try XCTUnwrap(command.arguments.object)
      args["unknown"] = .bool(true)
      XCTAssertThrowsError(
        try command.operation.validate(.object(args)), command.operation.rawValue)
      for key in command.arguments.object!.keys {
        args = command.arguments.object!
        args[key] = .null
        XCTAssertThrowsError(
          try command.operation.validate(.object(args)), "\(command.operation).\(key)")
      }
    }
    for entry in try XCTUnwrap(corpus["results"].array) {
      let reply = HelperReply(
        id: "result-1", generation: corpus["generation"].string!, result: entry["result"],
        error: nil)
      let raw = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(reply))
      XCTAssertEqual(raw["result"], entry["result"])
      XCTAssertNil(raw.object?["error"])
    }
    for failure in try XCTUnwrap(corpus["errors"].array) {
      let decoded = try JSONDecoder().decode(
        HelperFailure.self, from: JSONEncoder().encode(failure))
      let reply = HelperReply(
        id: "request-1", generation: corpus["generation"].string!, result: nil,
        error: decoded)
      let raw = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(reply))
      XCTAssertEqual(raw["error"], failure)
      XCTAssertNil(raw.object?["result"])
    }
  }
  func testEnvelopeIsStrict() throws {
    let command = HelperCommand(
      id: "a", generation: UUID().uuidString, budgetMs: 100, operation: .home,
      arguments: .object([:]))
    let data = try JSONEncoder().encode(command)
    XCTAssertEqual(try HelperCommand.decode(data).operation, .home)
    var object = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    object["extra"] = true
    XCTAssertThrowsError(
      try HelperCommand.decode(JSONSerialization.data(withJSONObject: object)))
    object.removeValue(forKey: "extra")
    object["budgetMs"] = 0
    XCTAssertThrowsError(
      try HelperCommand.decode(JSONSerialization.data(withJSONObject: object)))
  }
}
