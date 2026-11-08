import XCTest

@testable import HelperCore

@MainActor private final class Gate {
  var started: [String] = []
  var continuation: CheckedContinuation<JSONValue, Error>?
  func perform(_ command: HelperCommand) async throws -> JSONValue {
    started.append(command.id)
    return try await withCheckedThrowingContinuation { continuation = $0 }
  }
  func complete() {
    continuation?.resume(returning: .null)
    continuation = nil
  }
}

final class ExecutorTests: XCTestCase {
  func testCancelledTransportPermitCannotExecuteAfterLateAdmission() async {
    let state = HelperStatus()
    let permit = DispatchPermit(budgetMs: 1000)
    permit.cancel(.init("cancelled", "Client disconnected"))
    let executor = HelperExecutor(status: state) { _ in
      XCTFail("Disconnected command executed")
      return .null
    }
    let reply = await executor.submit(command("disconnected", state.generation), permit: permit)
    XCTAssertEqual(reply.error?.code, "cancelled")
    XCTAssertEqual(reply.error?.outcome, "notExecuted")
    await executor.shutdown()
  }
  func testMainActorBacklogCannotDispatchExpiredOrStoppedWork() async throws {
    let state = HelperStatus()
    let entered = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)
    let executor = HelperExecutor(status: state) { _ in
      XCTFail("Expired command started after shutdown")
      return .null
    }
    let blocker = Task { @MainActor in
      // Deliberately emulate a synchronous Apple call occupying MainActor.
      let block = { entered.signal(); release.wait() }
      block()
    }
    await Task.detached { entered.wait() }.value
    let reply = await executor.submit(command("expired", state.generation, budget: 20))
    XCTAssertEqual(reply.error?.outcome, "notExecuted")
    await executor.shutdown()
    release.signal()
    await blocker.value
    try await Task.sleep(for: .milliseconds(30))
  }
  func testReadOnlyAndClipboardPayloadsAreNotCached() async {
    let state = HelperStatus()
    let executor = HelperExecutor(status: state) { _ in .string(String(repeating: "x", count: 10000)) }
    let read = HelperCommand(id: "read", generation: state.generation, budgetMs: 1000,
      operation: .screenshot, arguments: .object([:]))
    _ = await executor.submit(read)
    let clipboard = HelperCommand(id: "clipboard", generation: state.generation, budgetMs: 1000,
      operation: .clipboardRead, arguments: .object(["lease": .string("synthetic-lease")]))
    _ = await executor.submit(clipboard)
    let duplicate = await executor.submit(clipboard)
    XCTAssertNil(duplicate.result)
    XCTAssertEqual(duplicate.error?.code, "result unavailable")
    await executor.shutdown()
  }
  @MainActor func testLargeMutationRepliesAndErrorDetailsAreNotRetained() async {
    let state = HelperStatus()
    var calls = 0
    let executor = HelperExecutor(status: state) { command in
      calls += 1
      if command.id == "secret-error" { throw HelperFailure("invalid argument", "synthetic-private-text") }
      return .string(String(repeating: "x", count: 10000))
    }
    let large = command("large", state.generation)
    _ = await executor.submit(large)
    let repeated = await executor.submit(large)
    XCTAssertNil(repeated.result)
    XCTAssertEqual(repeated.error?.code, "result unavailable")
    let failed = command("secret-error", state.generation)
    _ = await executor.submit(failed)
    let error = await executor.submit(failed)
    XCTAssertEqual(error.error?.message, "Previous command failed")
    XCTAssertEqual(calls, 2, "large or private results never cause a replay")
    await executor.shutdown()
  }
  @MainActor func testExternalFailureRejectsQueuedAndFutureMutations() async throws {
    let state = HelperStatus()
    let gate = Gate()
    let executor = HelperExecutor(status: state) { try await gate.perform($0) }
    let first = Task { await executor.submit(command("first", state.generation)) }
    while gate.started.isEmpty { await Task.yield() }
    let queued = Task { await executor.submit(command("queued", state.generation)) }
    try await Task.sleep(for: .milliseconds(20))
    state.update(.failed)
    gate.complete()
    _ = await first.value
    let rejected = await queued.value
    XCTAssertEqual(rejected.error?.outcome, "notExecuted")
    XCTAssertEqual(rejected.error?.code, "helper unavailable")
    let future = await executor.submit(command("future", state.generation))
    XCTAssertEqual(future.error?.code, "helper unavailable")
    XCTAssertEqual(gate.started, ["first"])
    await executor.shutdown()
  }
  private func command(_ id: String, _ generation: String, budget: Int = 1000) -> HelperCommand {
    .init(
      id: id, generation: generation, budgetMs: budget, operation: .home,
      arguments: .object([:]))
  }
  @MainActor func testTimeoutRetainsOwnershipUntilNormalCompletion() async throws {
    let state = HelperStatus()
    let gate = Gate()
    let executor = HelperExecutor(status: state) { try await gate.perform($0) }
    let reply = await executor.submit(command("first", state.generation, budget: 30))
    XCTAssertEqual(reply.error?.outcome, "unknown")
    XCTAssertEqual(state.snapshot()["activeOperation"], .string("first"))
    let next = Task { await executor.submit(command("second", state.generation)) }
    try await Task.sleep(for: .milliseconds(20))
    XCTAssertEqual(gate.started, ["first"])
    gate.complete()
    try await Task.sleep(for: .milliseconds(20))
    XCTAssertEqual(gate.started, ["first", "second"])
    XCTAssertNotEqual(state.snapshot()["phase"], .string("blocked"))
    gate.complete()
    let nextReply = await next.value
    XCTAssertNil(nextReply.error)
    await executor.shutdown()
  }
  @MainActor func testStalledOperationRequiresRecoveryEvenAfterLateCompletion() async throws {
    let state = HelperStatus()
    let gate = Gate()
    let executor = HelperExecutor(status: state, recoveryGrace: .milliseconds(30),
      minimumExecutionTime: .milliseconds(50)) {
      try await gate.perform($0)
    }
    _ = await executor.submit(command("stalled", state.generation, budget: 20))
    try await Task.sleep(for: .milliseconds(100))
    XCTAssertEqual(state.snapshot()["phase"], .string("blocked"))
    let next = await executor.submit(command("unsafe", state.generation))
    XCTAssertEqual(next.error?.code, "helper unavailable")
    gate.complete()
    try await Task.sleep(for: .milliseconds(20))
    XCTAssertEqual(state.snapshot()["phase"], .string("blocked"))
    XCTAssertEqual(gate.started, ["stalled"])
    await executor.shutdown()
  }
  @MainActor func testShortDeadlineDoesNotMisclassifyHealthyNativeWorkAsStalled() async throws {
    let state = HelperStatus()
    let gate = Gate()
    let executor = HelperExecutor(status: state, recoveryGrace: .milliseconds(20),
      minimumExecutionTime: .milliseconds(30), minimumInspectionTime: .seconds(1)) {
        try await gate.perform($0)
      }
    let read = HelperCommand(id: "short-wait", generation: state.generation, budgetMs: 20,
      operation: .elements, arguments: .object([:]))
    let reply = await executor.submit(read)
    XCTAssertEqual(reply.error?.code, "timeout")
    XCTAssertEqual(reply.error?.outcome, "unknown")
    let next = Task { await executor.submit(command("after-wait", state.generation)) }
    // Beyond the caller's deadline and grace, but within normal native execution.
    try await Task.sleep(for: .milliseconds(80))
    XCTAssertNotEqual(state.snapshot()["phase"], .string("blocked"))
    XCTAssertEqual(state.snapshot()["activeOperation"], .string("short-wait"))
    XCTAssertEqual(gate.started, ["short-wait"])
    gate.complete()
    let deadline = ContinuousClock.now.advanced(by: .seconds(2))
    while gate.started.count < 2 && ContinuousClock.now < deadline { await Task.yield() }
    XCTAssertEqual(gate.started, ["short-wait", "after-wait"])
    gate.complete()
    let nextReply = await next.value
    XCTAssertNil(nextReply.error)
    XCTAssertEqual(gate.started, ["short-wait", "after-wait"])
    await executor.shutdown()
  }
  @MainActor func testQueuedCancellationNeverDispatches() async throws {
    let state = HelperStatus()
    let gate = Gate()
    let executor = HelperExecutor(status: state) { try await gate.perform($0) }
    let first = Task { await executor.submit(command("first", state.generation)) }
    while gate.started.isEmpty { await Task.yield() }
    let queued = Task { await executor.submit(command("queued", state.generation)) }
    try await Task.sleep(for: .milliseconds(20))
    await executor.cancel("queued")
    let cancelled = await queued.value
    XCTAssertEqual(cancelled.error?.code, "cancelled")
    gate.complete()
    let done = await first.value
    XCTAssertNil(done.error)
    XCTAssertEqual(gate.started, ["first"])
    await executor.shutdown()
  }
  @MainActor func testQueuedDeadlineExpiresWithoutReleasingActiveOwner() async throws {
    let state = HelperStatus()
    let gate = Gate()
    let executor = HelperExecutor(status: state) { try await gate.perform($0) }
    let first = Task { await executor.submit(command("first", state.generation)) }
    while gate.started.isEmpty { await Task.yield() }
    let timedOut = await executor.submit(command("queued", state.generation, budget: 20))
    XCTAssertEqual(timedOut.error?.code, "timeout")
    XCTAssertEqual(timedOut.error?.outcome, "notExecuted")
    XCTAssertEqual(state.snapshot()["activeOperation"], .string("first"))
    gate.complete()
    _ = await first.value
    XCTAssertEqual(gate.started, ["first"])
    await executor.shutdown()
  }
  @MainActor func testShutdownAcknowledgesWithoutReleasingInFlightAppleOperation() async throws {
    let state = HelperStatus()
    let gate = Gate()
    let executor = HelperExecutor(status: state) { try await gate.perform($0) }
    let first = Task { await executor.submit(command("first", state.generation)) }
    while gate.started.isEmpty { await Task.yield() }
    let stop = HelperCommand(
      id: "stop", generation: state.generation, budgetMs: 100, operation: .shutdown,
      arguments: .object([:]))
    let reply = await executor.submit(stop)
    XCTAssertNil(reply.error)
    XCTAssertEqual(state.snapshot()["phase"], .string("stopping"))
    XCTAssertEqual(state.snapshot()["activeOperation"], .string("first"))
    let firstReply = await first.value
    XCTAssertEqual(firstReply.error?.outcome, "unknown")
    gate.complete()
    try await Task.sleep(for: .milliseconds(20))
    XCTAssertEqual(state.snapshot()["phase"], .string("stopping"))
  }
  @MainActor func testIdentityMismatchAndDuplicatesDoNotExecute() async {
    let state = HelperStatus()
    var count = 0
    let executor = HelperExecutor(status: state) { _ in
      count += 1
      return .null
    }
    let stale = await executor.submit(command("stale", UUID().uuidString))
    XCTAssertEqual(stale.error?.code, "stale generation")
    XCTAssertEqual(count, 0)
    let same = command("once", state.generation)
    let a = await executor.submit(same)
    let b = await executor.submit(same)
    XCTAssertNil(a.error)
    XCTAssertNil(b.error)
    XCTAssertEqual(count, 1)
    let conflict = HelperCommand(
      id: "once", generation: state.generation, budgetMs: 1000, operation: .lock,
      arguments: .object([:]))
    let rejected = await executor.submit(conflict)
    XCTAssertEqual(rejected.error?.code, "conflicting command")
    XCTAssertEqual(count, 1)
    await executor.shutdown()
  }
}
