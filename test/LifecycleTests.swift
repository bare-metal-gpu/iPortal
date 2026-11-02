import Foundation

@main
struct LifecycleTests {
    static func main() {
        var gate = VideoReadinessGate()
        func observe(_ state: String, _ epoch: Int, _ now: Double, device: String = "A", document: String = "page1", server: String = "server1") -> VideoReadinessGate.Change {
            gate.observe(state, deviceID: device, epoch: epoch, bridgeID: document, serverInstance: server, statusRevision: epoch, now: now)
        }
        assert(observe("ready", 1, 100).invalidated)
        assert(!gate.acceptsFrame(at: 99, now: 101))
        assert(gate.acceptsFrame(at: 101, now: 101))
        assert(!observe("ready", 1, 102).invalidated)
        assert(gate.acceptsFrame(at: 101, now: 102))
        // A brief network failure must invalidate readiness even if capture kept running.
        assert(observe("connecting", 2, 103).invalidated)
        assert(!gate.acceptsFrame(at: 104, now: 104))
        assert(observe("ready", 3, 105).invalidated)
        assert(!gate.acceptsFrame(at: 104, now: 105))
        assert(gate.acceptsFrame(at: 106, now: 106))
        // Reloads can reuse a numeric epoch; document identity still separates them.
        assert(observe("ready", 3, 107, document: "page2").invalidated)
        assert(!gate.acceptsFrame(at: 106, now: 107))
        // Same state, different phone/server must not retain the old video binding.
        assert(observe("ready", 3, 108, device: "B", document: "page2").deviceChanged)
        assert(!gate.acceptsFrame(at: 107, now: 108))
        assert(observe("ready", 3, 109, device: "B", document: "page2", server: "server2").invalidated)
        assert(observe("locked", 4, 110, device: "B").invalidated)
        assert(!gate.acceptsFrame(at: 111, now: 111))
        _ = observe("unrecognized", 5, 112)
        assert(gate.lifecycle == "connecting")
        _ = observe("ready", 6, 113)
        assert(!gate.acceptsFrame(at: 114, now: 118), "stalled frames are not live")
        gate.suspend(at: 119)
        assert(!gate.acceptsFrame(at: 120, now: 120), "wake/navigation waits for a new observation")

        // Cached readiness echoes cannot undo a native suspension.
        let stale = gate.observe("ready", deviceID: "A", epoch: 6, bridgeID: "page1", serverInstance: "server1", statusRevision: 6, now: 121)
        assert(!stale.accepted)
        let freshStatus = gate.observe("ready", deviceID: "A", epoch: 6, bridgeID: "page1", serverInstance: "server1", statusRevision: 7, now: 122)
        assert(freshStatus.accepted && freshStatus.newStatus && freshStatus.invalidated)
        let regression = gate.observe("ready", deviceID: "A", epoch: 5, bridgeID: "page1", serverInstance: "server1", statusRevision: 8, now: 123)
        assert(!regression.accepted)
        let ack = gate.observe("ready", deviceID: "A", epoch: 6, bridgeID: "page1", serverInstance: "server1", statusRevision: 7, now: 124)
        assert(ack.accepted && !ack.newStatus, "readiness acknowledgements are not control-plane heartbeats")

        var budget = CaptureRetryBudget()
        assert(budget.beginAttempt(at: 0))
        budget.failed()
        assert(budget.beginAttempt(at: 1))
        budget.healthy(at: 2)
        budget.failed()
        assert(!budget.beginAttempt(at: 3), "one good frame cannot erase retry exhaustion")
        budget.healthy(at: 4)
        budget.healthy(at: 14)
        assert(budget.beginAttempt(at: 15), "sustained healthy video replenishes attempts")
        budget.failed()
        assert(budget.beginAttempt(at: 16))
        assert(!budget.beginAttempt(at: 17))
        assert(budget.beginAttempt(at: 77), "cooldown eventually permits recovery")
        print("Native identity, transient failure, fresh-frame and retry-budget tests passed.")
    }
}
