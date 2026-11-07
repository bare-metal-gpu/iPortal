import Foundation
import CryptoKit

// Shared by transport and executor. Cancellation can arrive before actor
// admission; claiming on MainActor is the last step before native execution.
final class DispatchPermit: @unchecked Sendable {
  private let lock = NSLock()
  private let deadline: ContinuousClock.Instant
  private var claimed = false
  private var rejection: HelperFailure?
  init(budgetMs: Int) { deadline = .now.advanced(by: .milliseconds(budgetMs)) }
  func claim() throws {
    lock.lock()
    defer { lock.unlock() }
    if let rejection { throw rejection }
    guard !claimed else { throw HelperFailure("conflicting command", "Command already dispatched") }
    guard ContinuousClock.now < deadline else {
      throw HelperFailure("timeout", "Command expired before native dispatch")
    }
    claimed = true
  }
  @discardableResult func cancel(_ reason: HelperFailure) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard !claimed else { return false }
    if rejection == nil { rejection = reason }
    return true
  }
  var dispatched: Bool {
    lock.lock()
    defer { lock.unlock() }
    return claimed
  }
}

final class HelperStatus: @unchecked Sendable {
  private let mutex = NSLock()
  private var lifecycle = HelperLifecycle()
  private var observers: [UUID: (JSONValue) -> Void] = [:]
  private let capabilities: JSONValue
  private let displayPixels: JSONValue
  init(capabilities: JSONValue = .object([:]), displayPixels: JSONValue = .null) {
    self.capabilities = capabilities
    self.displayPixels = displayPixels
    lifecycle.reduce(.start)
    lifecycle.reduce(.authenticated)
  }
  var generation: String {
    mutex.lock()
    defer { mutex.unlock() }
    return lifecycle.generation
  }
  func update(_ event: HelperLifecycle.Event) {
    mutex.lock()
    lifecycle.reduce(event)
    let callbacks = Array(observers.values)
    mutex.unlock()
    let value = snapshot()
    callbacks.forEach { $0(value) }
  }
  func observe(_ callback: @escaping (JSONValue) -> Void) -> UUID {
    let id = UUID()
    mutex.lock()
    observers[id] = callback
    mutex.unlock()
    return id
  }
  func removeObserver(_ id: UUID) {
    mutex.lock()
    observers.removeValue(forKey: id)
    mutex.unlock()
  }
  func snapshot() -> JSONValue {
    mutex.lock()
    defer { mutex.unlock() }
    return .object([
      "protocol": .number(Double(HelperProtocol.version)),
      "build": .string(HelperProtocol.build),
      "generation": .string(lifecycle.generation), "phase": .string(lifecycle.phase.rawValue),
      "automationReady": lifecycle.authorized.map(JSONValue.bool) ?? .null,
      "locked": lifecycle.locked.map(JSONValue.bool) ?? .null,
      "activeOperation": lifecycle.active.map(JSONValue.string) ?? .null,
      "capabilities": capabilities,
      "displayPixels": displayPixels,
    ])
  }
}

actor HelperExecutor {
  struct Pending {
    let command: HelperCommand
    let permit: DispatchPermit
    let admitted: ContinuousClock.Instant
    let continuation: CheckedContinuation<HelperReply, Never>
  }
  let status: HelperStatus
  private var queue: [Pending] = []
  private var queuedDeadlines: [String: Task<Void, Never>] = [:]
  private var active: Pending?
  private var replied = false
  private var stopped = false
  private var blocked = false
  private struct Receipt {
    let fingerprint: Data
    let reply: HelperReply
  }
  private var completed: [String: Receipt] = [:]
  private var completionOrder: [String] = []
  private var timeoutTask: Task<Void, Never>?
  private var stallTask: Task<Void, Never>?
  private let recoveryGrace: Duration
  private let perform: @MainActor (HelperCommand) async throws -> JSONValue
  init(
    status: HelperStatus,
    recoveryGrace: Duration = .seconds(2),
    perform: @escaping @MainActor (HelperCommand) async throws -> JSONValue
  ) {
    self.status = status
    self.recoveryGrace = recoveryGrace
    self.perform = perform
  }
  func submit(_ command: HelperCommand, permit supplied: DispatchPermit? = nil) async -> HelperReply {
    let permit = supplied ?? DispatchPermit(budgetMs: command.budgetMs)
    if command.generation != status.generation {
      return failure(command, "stale generation", "Helper restarted")
    }
    if command.operation == .shutdown {
      shutdown()
      return .init(id: command.id, generation: status.generation, result: .null, error: nil)
    }
    if let previous = completed[command.id] {
      guard previous.fingerprint == fingerprint(command)
      else { return failure(command, "conflicting command", "Command identity was reused") }
      return previous.reply
    }
    if active?.command.id == command.id
      || queue.contains(where: { $0.command.id == command.id })
    {
      return failure(
        command, "command pending", "Command is already executing", outcome: "unknown")
    }
    if [.presence, .portal, .quality, .clipboardStatus].contains(command.operation), !stopped {
      do {
        return .init(
          id: command.id, generation: status.generation,
          result: try await dispatch(command, permit: permit), error: nil)
      } catch let error as HelperFailure {
        return .init(
          id: command.id, generation: status.generation, result: nil, error: error)
      } catch { return failure(command, "unknown error", "Helper maintenance failed") }
    }
    if stopped || blocked || status.snapshot()["phase"] == .string("blocked") {
      return failure(command, "helper unavailable", "Helper requires recovery")
    }
    if queue.count >= 64 { return failure(command, "queue full", "Helper is busy") }
    return await withCheckedContinuation { continuation in
      queue.append(Pending(command: command, permit: permit, admitted: .now, continuation: continuation))
      queuedDeadlines[command.id] = Task {
        try? await Task.sleep(for: .milliseconds(command.budgetMs))
        if !Task.isCancelled {
          self.removeQueued(
            command.id, code: "timeout", message: "Command expired in queue")
        }
      }
      pump()
    }
  }
  func cancel(_ id: String) {
    // A lost client only cancels unstarted work. A dispatched native operation
    // retains exclusive ownership until its callback or helper termination.
    removeQueued(id, code: "cancelled", message: "Command cancelled")
    if let item = active, item.command.id == id, !replied,
       item.permit.cancel(.init("cancelled", "Command cancelled before dispatch")) {
      replied = true
      let reply = failure(item.command, "cancelled", "Command cancelled before dispatch")
      remember(item.command, reply)
      item.continuation.resume(returning: reply)
      finish(item.command, reply)
    }
  }
  private func removeQueued(_ id: String, code: String, message: String) {
    guard let index = queue.firstIndex(where: { $0.command.id == id }) else { return }
    let item = queue.remove(at: index)
    item.permit.cancel(.init(code, message))
    queuedDeadlines.removeValue(forKey: id)?.cancel()
    let reply = failure(item.command, code, message)
    remember(item.command, reply)
    item.continuation.resume(returning: reply)
  }
  func shutdown() {
    stopped = true
    timeoutTask?.cancel()
    stallTask?.cancel()
    status.update(.stop)
    if let item = active, !replied {
      item.permit.cancel(.init("cancelled", "Helper stopping"))
      replied = true
      let reply = failure(item.command, "cancelled", "Helper stopping",
                          outcome: item.permit.dispatched ? "unknown" : "notExecuted")
      remember(item.command, reply)
      item.continuation.resume(returning: reply)
    }
    for item in queue {
      item.permit.cancel(.init("cancelled", "Helper stopping"))
      item.continuation.resume(
        returning: failure(item.command, "cancelled", "Helper stopping"))
    }
    queue.removeAll()
    queuedDeadlines.values.forEach { $0.cancel() }
    queuedDeadlines.removeAll()
    // Do not pretend an in-flight Apple operation has been cancelled.
  }
  private func failure(
    _ command: HelperCommand, _ code: String, _ message: String, outcome: String = "notExecuted"
  ) -> HelperReply {
    .init(
      id: command.id, generation: status.generation, result: nil,
      error: .init(code, message, outcome: outcome))
  }
  private func pump() {
    guard active == nil, !stopped, !blocked, !queue.isEmpty else { return }
    if status.snapshot()["phase"] == .string("blocked") {
      for item in queue {
        item.continuation.resume(
          returning: failure(item.command, "helper unavailable", "Helper requires recovery"))
      }
      queue.removeAll()
      queuedDeadlines.values.forEach { $0.cancel() }
      queuedDeadlines.removeAll()
      return
    }
    let index =
      queue.firstIndex { $0.command.operation == .keepAlive }
      ?? queue.firstIndex { $0.command.operation.mutates } ?? 0
    let item = queue.remove(at: index)
    queuedDeadlines.removeValue(forKey: item.command.id)?.cancel()
    let elapsed = item.admitted.duration(to: .now)
    let budget = Duration.milliseconds(item.command.budgetMs)
    if elapsed >= budget {
      item.continuation.resume(
        returning: failure(item.command, "timeout", "Command expired in queue"))
      pump()
      return
    }
    active = item
    replied = false
    status.update(.begin(item.command.id))
    timeoutTask = Task {
      try? await Task.sleep(for: budget - elapsed)
      if !Task.isCancelled { self.expire(item.command.id) }
    }
    Task {
      let reply: HelperReply
      do {
        reply = .init(
          id: item.command.id, generation: status.generation,
          result: try await dispatch(item.command, permit: item.permit), error: nil)
      } catch let error as HelperFailure {
        reply = .init(
          id: item.command.id, generation: status.generation, result: nil, error: error)
      } catch {
        let native = error as NSError
        let unsupported = native.domain == "iPortal.Apple" && native.code == 2
        if native.code == 41 { status.update(.authorization(false)) }
        reply = failure(
          item.command, unsupported ? "unsupported operation" : "unknown error",
          unsupported ? native.localizedDescription : "Apple operation failed",
          outcome: !unsupported && item.command.operation.mutates
            ? "unknown" : "notExecuted")
      }
      self.finish(item.command, reply)
    }
  }
  private func expire(_ id: String) {
    guard let item = active, item.command.id == id, !replied else { return }
    item.permit.cancel(.init("timeout", "Command expired before native dispatch"))
    let reply = failure(
      item.command, "timeout", item.permit.dispatched ? "Native operation outcome unknown" : "Command expired before native dispatch",
      outcome: item.permit.dispatched ? "unknown" : "notExecuted")
    replied = true
    remember(item.command, reply)
    item.continuation.resume(returning: reply)
    // A short client deadline is not evidence that Apple is stalled. Keep
    // exclusive ownership, allowing normal completion during a bounded
    // grace period. An ordinary wait timeout must not restart the helper.
    stallTask = Task {
      try? await Task.sleep(for: recoveryGrace)
      if !Task.isCancelled { self.stall(id) }
    }
  }
  private func stall(_ id: String) {
    guard active?.command.id == id, !stopped else { return }
    blocked = true
    status.update(.stalled(id))
    for pending in queue {
      pending.continuation.resume(
        returning: failure(
          pending.command, "helper unavailable", "Native operation is still executing"))
    }
    queue.removeAll()
    queuedDeadlines.values.forEach { $0.cancel() }
    queuedDeadlines.removeAll()
  }
  private func finish(_ command: HelperCommand, _ reply: HelperReply) {
    guard active?.command.id == command.id else { return }
    timeoutTask?.cancel()
    timeoutTask = nil
    stallTask?.cancel()
    stallTask = nil
    if !replied {
      remember(command, reply)
      active?.continuation.resume(returning: reply)
    }
    active = nil
    status.update(.finish(command.id))
    pump()
  }
  private func remember(_ command: HelperCommand, _ reply: HelperReply) {
    // Read-only results are fresh observations, not replayable mutations. Never
    // retain screenshots, UI trees, clipboard data or typed text in receipts.
    guard command.operation.mutates else { return }
    let safeReply: HelperReply
    if command.operation.rawValue.hasPrefix("clipboard") {
      safeReply = failure(command, "result unavailable", "Inspect the clipboard before retrying", outcome: "unknown")
    } else if let error = reply.error {
      safeReply = failure(command, error.code, "Previous command failed", outcome: error.outcome)
    } else {
      safeReply = reply
    }
    let bounded = (try? JSONEncoder().encode(safeReply).count).map { $0 <= 4096 } ?? false
    completed[command.id] = Receipt(fingerprint: fingerprint(command), reply: bounded ? safeReply
      : failure(command, "result unavailable", "Previous result is not retained", outcome: "unknown"))
    completionOrder.append(command.id)
    if completionOrder.count > 256 {
      completed.removeValue(forKey: completionOrder.removeFirst())
    }
  }
  private func fingerprint(_ command: HelperCommand) -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    // Already validated JSONValue is always encodable.
    let data = (try? encoder.encode(command.arguments)) ?? Data()
    return Data(SHA256.hash(data: Data(command.operation.rawValue.utf8) + data))
  }
  @MainActor private func dispatch(_ command: HelperCommand, permit: DispatchPermit) async throws -> JSONValue {
    try permit.claim()
    return try await perform(command)
  }
}
