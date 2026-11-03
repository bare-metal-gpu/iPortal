import Foundation

// USB can re-enumerate while screen capture is starting. Only that recovery
// window absorbs short removals; unplugging a working mirror is immediate.
struct USBRecoveryWindow {
    private var startedAt: TimeInterval?
    private var detachedUntil: TimeInterval?
    var active: Bool { startedAt != nil }
    mutating func attached(at now: TimeInterval) {
        if startedAt == nil { startedAt = now }
        // usbmuxd may publish the reattached device just after IOKit does.
        detachedUntil = now + 1.2
    }
    mutating func detached(at now: TimeInterval) -> Bool {
        guard let startedAt, now - startedAt < 8 else { finish(); return false }
        detachedUntil = now + 1.2
        return true
    }
    func holdsDisconnect(at now: TimeInterval) -> Bool {
        guard let startedAt, now - startedAt < 8 else { return false }
        return now < (detachedUntil ?? startedAt + 1.2)
    }
    mutating func finish() { startedAt = nil; detachedUntil = nil }
}

// Native readiness belongs to a specific web document, observation epoch and
// device. A new observation must receive a frame after its own transition.
struct VideoReadinessGate {
    private(set) var lifecycle = "connecting"
    private(set) var deviceID: String?
    private(set) var connectionID = ""
    private(set) var epoch = -1
    private(set) var bridgeID = ""
    private(set) var serverInstance = ""
    private(set) var statusRevision = -1
    private var suspendedRevision: Int?
    private(set) var requiredFrameAfter: TimeInterval = 0

    struct Change {
        let accepted: Bool
        let newStatus: Bool
        let invalidated: Bool
        let deviceChanged: Bool
        let reattached: Bool
    }

    mutating func observe(_ state: String, deviceID incomingID: String?, epoch: Int,
                          bridgeID: String, serverInstance: String, statusRevision: Int, now: TimeInterval,
                          connectionID: String = "") -> Change {
        let next = ["ready", "locked", "connecting", "disconnected"].contains(state) ? state : "connecting"
        let newDocument = bridgeID != self.bridgeID
        if !newDocument && (epoch < self.epoch || statusRevision < self.statusRevision
            || (next == "ready" && statusRevision <= (suspendedRevision ?? -1))) {
            return Change(accepted: false, newStatus: false, invalidated: false, deviceChanged: false, reattached: false)
        }
        let newStatus = newDocument || statusRevision > self.statusRevision
        if newStatus { suspendedRevision = nil }
        let deviceID = incomingID.flatMap { $0.isEmpty ? nil : $0 }
        let deviceChanged = deviceID != self.deviceID
        let reattached = !deviceChanged && ((lifecycle == "disconnected" && next != "disconnected")
            || (!self.connectionID.isEmpty && !connectionID.isEmpty && connectionID != self.connectionID))
        let invalidated = next != lifecycle || deviceChanged || epoch != self.epoch
            || bridgeID != self.bridgeID || serverInstance != self.serverInstance || reattached
        self.deviceID = deviceID
        self.connectionID = connectionID
        self.epoch = epoch
        self.bridgeID = bridgeID
        self.serverInstance = serverInstance
        self.statusRevision = statusRevision
        lifecycle = next
        if invalidated { requiredFrameAfter = now }
        return Change(accepted: true, newStatus: newStatus, invalidated: invalidated, deviceChanged: deviceChanged, reattached: reattached)
    }

    mutating func suspend(at now: TimeInterval) {
        lifecycle = "connecting"
        suspendedRevision = statusRevision
        requiredFrameAfter = now
    }

    mutating func disconnect(at now: TimeInterval) {
        suspend(at: now)
        lifecycle = "disconnected"
    }

    mutating func requireFreshFrame(at now: TimeInterval) { requiredFrameAfter = now }

    func acceptsFrame(at timestamp: TimeInterval, now: TimeInterval) -> Bool {
        lifecycle == "ready" && timestamp > requiredFrameAfter && timestamp <= now && now - timestamp < 3
    }
}

// A single frame cannot erase failure history. Limit attempts in a rolling
// minute; only ten seconds of continuous healthy video resets the budget.
struct CaptureRetryBudget {
    private var attempts: [TimeInterval] = []
    private var healthySince: TimeInterval?

    mutating func beginAttempt(at now: TimeInterval) -> Bool {
        attempts.removeAll { now - $0 >= 60 }
        guard attempts.count < 2 else { return false }
        attempts.append(now)
        healthySince = nil
        return true
    }

    mutating func healthy(at now: TimeInterval) {
        if healthySince == nil { healthySince = now }
        if now - (healthySince ?? now) >= 10 { attempts.removeAll() }
    }

    mutating func failed() { healthySince = nil }
}
