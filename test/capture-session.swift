import Foundation

private final class Events: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String] = []
    func add(_ value: String) { lock.lock(); values.append(value); lock.unlock() }
    var all: [String] { lock.lock(); defer { lock.unlock() }; return values }
}

private func wait(_ semaphore: DispatchSemaphore, _ message: String) {
    precondition(semaphore.wait(timeout: .now() + 3) == .success, message)
}

private func drain() {
    let done = DispatchSemaphore(value: 0)
    CaptureSessionExecutor.start(CaptureLifetime(), operation: { true }, completion: { _ in done.signal() })
    wait(done, "Capture executor failed to drain")
}

@main
struct CaptureSessionTests {
    static func main() {
        // One stalled phone must not block capture on a different device.
        let slowEntered = DispatchSemaphore(value: 0), slowRelease = DispatchSemaphore(value: 0)
        let otherReady = DispatchSemaphore(value: 0)
        CaptureSessionExecutor.start(CaptureLifetime(), key: "slow-phone", operation: {
            slowEntered.signal(); wait(slowRelease, "slow capture was not released"); return true
        }, completion: { _ in })
        wait(slowEntered, "slow capture did not begin")
        CaptureSessionExecutor.start(CaptureLifetime(), key: "other-ipad", operation: { true }, completion: { _ in otherReady.signal() })
        wait(otherReady, "a different device must not wait for stalled capture")
        slowRelease.signal()
        // Replacement must wait for the old start AND a deliberately slow
        // teardown. Cancellation must suppress the old ready notification.
        let events = Events()
        let a = CaptureLifetime(), b = CaptureLifetime()
        let enteredStart = DispatchSemaphore(value: 0), releaseStart = DispatchSemaphore(value: 0)
        let enteredStop = DispatchSemaphore(value: 0), releaseStop = DispatchSemaphore(value: 0)
        let replacementReady = DispatchSemaphore(value: 0)
        CaptureSessionExecutor.start(a, operation: {
            events.add("a.start")
            enteredStart.signal()
            wait(releaseStart, "Test did not release first start")
            return true
        }, completion: { _ in events.add("a.ready") })
        wait(enteredStart, "First capture did not start")
        CaptureSessionExecutor.stop(a) {
            events.add("a.stop")
            enteredStop.signal()
            wait(releaseStop, "Test did not release teardown")
            events.add("a.released")
        }
        CaptureSessionExecutor.start(b, operation: {
            events.add("b.start")
            return true
        }, completion: { ok in
            precondition(ok)
            events.add("b.ready")
            replacementReady.signal()
        })
        precondition(a.isCancelled, "Stop must cancel immediately while startRunning blocks")
        precondition(replacementReady.wait(timeout: .now() + 0.03) == .timedOut)
        releaseStart.signal()
        wait(enteredStop, "Old capture was not stopped")
        precondition(replacementReady.wait(timeout: .now() + 0.03) == .timedOut,
                     "Replacement started before old device resources were released")
        releaseStop.signal()
        wait(replacementReady, "Replacement did not start after teardown")
        precondition(events.all == ["a.start", "a.stop", "a.released", "b.start", "b.ready"],
                     "Capture ordering or stale completion violation: \(events.all)")

        // A delayed permission/device callback may attempt to submit work after
        // stop. The canceled lifetime cannot configure a capture session again.
        let cancelled = CaptureLifetime()
        let cancelledEvents = Events()
        CaptureSessionExecutor.stop(cancelled) { cancelledEvents.add("stop") }
        CaptureSessionExecutor.start(cancelled, operation: {
            cancelledEvents.add("start")
            return true
        }, completion: { _ in cancelledEvents.add("ready") })
        drain()
        precondition(cancelledEvents.all == ["stop"])

        // A start already in the queue must be skipped when canceled behind a
        // different session's blocking operation.
        let blocker = CaptureLifetime(), queued = CaptureLifetime()
        let enteredBlocker = DispatchSemaphore(value: 0), releaseBlocker = DispatchSemaphore(value: 0)
        let queuedEvents = Events()
        CaptureSessionExecutor.start(blocker, operation: {
            enteredBlocker.signal()
            wait(releaseBlocker, "Test did not release blocker")
            return true
        }, completion: { _ in })
        wait(enteredBlocker, "Blocker did not start")
        CaptureSessionExecutor.start(queued, operation: {
            queuedEvents.add("start")
            return true
        }, completion: { _ in queuedEvents.add("ready") })
        CaptureSessionExecutor.stop(queued) { queuedEvents.add("stop") }
        releaseBlocker.signal()
        drain()
        precondition(queuedEvents.all == ["stop"])

        // A genuine configuration/start failure still reaches the owner once.
        let failed = Events()
        CaptureSessionExecutor.start(CaptureLifetime(), operation: { false }, completion: {
            failed.add($0 ? "unexpected success" : "failure")
        })
        drain()
        precondition(failed.all == ["failure"])
        print("Capture serialization, cancellation and completion tests passed.")
    }
}
