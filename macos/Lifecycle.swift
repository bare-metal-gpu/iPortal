import Foundation

// Native readiness belongs to a specific web document, observation epoch and
// device. A new observation must receive a frame after its own transition.
struct VideoReadinessGate {
    private(set) var lifecycle = "connecting"
    private(set) var deviceID: String?
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
    }

    mutating func observe(_ state: String, deviceID incomingID: String?, epoch: Int,
                          bridgeID: String, serverInstance: String, statusRevision: Int, now: TimeInterval) -> Change {
        let next = ["ready", "locked", "connecting", "disconnected"].contains(state) ? state : "connecting"
        let newDocument = bridgeID != self.bridgeID
        if !newDocument && (epoch < self.epoch || statusRevision < self.statusRevision
            || (next == "ready" && statusRevision <= (suspendedRevision ?? -1))) {
            return Change(accepted: false, newStatus: false, invalidated: false, deviceChanged: false)
        }
        let newStatus = newDocument || statusRevision > self.statusRevision
        if newStatus { suspendedRevision = nil }
        let deviceID = incomingID.flatMap { $0.isEmpty ? nil : $0 }
        let deviceChanged = deviceID != self.deviceID
        let invalidated = next != lifecycle || deviceChanged || epoch != self.epoch
            || bridgeID != self.bridgeID || serverInstance != self.serverInstance
        self.deviceID = deviceID
        self.epoch = epoch
        self.bridgeID = bridgeID
        self.serverInstance = serverInstance
        self.statusRevision = statusRevision
        lifecycle = next
        if invalidated { requiredFrameAfter = now }
        return Change(accepted: true, newStatus: newStatus, invalidated: invalidated, deviceChanged: deviceChanged)
    }

    mutating func suspend(at now: TimeInterval) {
        lifecycle = "connecting"
        suspendedRevision = statusRevision
        requiredFrameAfter = now
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
