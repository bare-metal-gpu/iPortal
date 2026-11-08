import Foundation

enum HelperPhase: String, Codable, Sendable {
  case stopped, starting, authenticating, ready, locked, recovering, blocked, stopping
}

struct HelperLifecycle: Sendable {
  enum Event: Sendable {
    case start, authenticated
    case authorization(Bool?)
    case lock(Bool?)
    case begin(String)
    case finish(String)
    case stalled(String)
    case failed, stop, stopped
  }
  let generation = UUID().uuidString
  private(set) var phase: HelperPhase = .stopped
  private(set) var authorized: Bool?
  private(set) var locked: Bool?
  private(set) var active: String?
  private(set) var stalled = false
  mutating func reduce(_ event: Event) {
    switch event {
    case .start:
      guard phase == .stopped else { return }
      phase = .starting
    case .authenticated:
      guard phase == .starting else { return }
      phase = .authenticating
    case .authorization(let value):
      authorized = value
      refresh()
    case .lock(let value):
      locked = value
      refresh()
    case .begin(let id):
      guard active == nil, !stalled else { return }
      active = id
    case .finish(let id):
      guard active == id else { return }
      active = nil
      if !stalled { refresh() }
    case .stalled(let id):
      guard active == id else { return }
      stalled = true
      phase = .blocked
    case .failed:
      guard phase != .stopping, phase != .stopped else { return }
      stalled = true
      phase = .blocked
    case .stop: phase = .stopping
    case .stopped:
      phase = .stopped
      active = nil
      authorized = nil
      locked = nil
      stalled = false
    }
  }
  private mutating func refresh() {
    guard ![.stopped, .stopping].contains(phase), !stalled else { return }
    if locked == true {
      phase = .locked
    } else if authorized == false {
      phase = .blocked
    } else if authorized == true, locked == false {
      phase = .ready
    } else {
      phase = .authenticating
    }
  }
}

// Apple compatibility callbacks may race cancellation or report more than once.
// Only the first completion can resume a Swift continuation.
final class CallbackOnce: @unchecked Sendable {
  private let lock = NSLock()
  private var completed = false
  func run(_ body: () -> Void) {
    lock.lock()
    if completed {
      lock.unlock()
      return
    }
    completed = true
    lock.unlock()
    body()
  }
}
