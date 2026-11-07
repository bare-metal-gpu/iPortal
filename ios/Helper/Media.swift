import Foundation
import UIKit
import XCTest

@MainActor final class HelperMedia: HelperVideoSource {
  private let status: HelperStatus
  private var last: ContinuousClock.Instant?
  private var cached: HelperVideoFrame?
  private var pending: Task<HelperVideoFrame?, Never>?
  private var sequence: UInt64 = 0
  private var revision: UInt64 = 0
  private var quality: CGFloat = 0.5
  private var scale: CGFloat = 0.5
  private var interval = Duration.milliseconds(33)
  init(status: HelperStatus) { self.status = status }
  func configure(_ preset: String) throws {
    switch preset {
    case "low":
      quality = 0.25
      scale = 0.4
      interval = .milliseconds(50)
    case "balanced":
      quality = 0.5
      scale = 0.5
      interval = .milliseconds(33)
    case "high":
      quality = 0.7
      scale = 0.75
      interval = .milliseconds(16)
    default: throw HelperFailure.invalid("Unsupported quality")
    }
    revision &+= 1
    cached = nil
  }
  func frame() async -> HelperVideoFrame? {
    guard status.snapshot()["phase"] == .string("ready"),
      IPApple.locked()?.boolValue == false
    else { return nil }
    if let last, last.duration(to: .now) < interval { return cached }
    if let pending { return await pending.value }
    last = .now
    let requestedRevision = revision
    // Capture happens only in response to a writable subscribed channel.
    // No frame history or encode queue is retained across disconnects.
    let task = Task { @MainActor () -> HelperVideoFrame? in
      let data: Data? = await withCheckedContinuation { continuation in
        let once = CallbackOnce()
        let timeout = Task { @MainActor in
          try? await Task.sleep(for: .seconds(3))
          guard !Task.isCancelled else { return }
          once.run {
            // The native capture may still be in flight. Block new
            // captures until the owner replaces this helper.
            status.update(.failed)
            continuation.resume(returning: nil)
          }
        }
        IPApple.captureJPEG(withQuality: Double(quality), scale: Double(scale)) { data in
          once.run {
            timeout.cancel()
            continuation.resume(returning: data)
          }
        }
      }
      pending = nil
      guard let data, requestedRevision == revision,
        status.snapshot()["phase"] == .string("ready"),
        IPApple.locked()?.boolValue == false
      else { return nil }
      sequence &+= 1
      let frame = HelperVideoFrame(sequence: sequence, data: data)
      cached = frame
      return frame
    }
    pending = task
    return await task.value
  }
}
