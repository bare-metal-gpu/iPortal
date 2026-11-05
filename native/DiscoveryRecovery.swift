import Foundation

// Passive CoreDevice inventory can retain a paired phone without reconnecting
// its tunnel. Bound active recovery independently for each supported local device.
struct PairedDiscoveryRecovery {
    private struct Attempt {
        var failures = 0
        var retryAt: TimeInterval = 0
        var startedAt: TimeInterval = -.infinity
        var running = false
    }
    private var attempts: [String: Attempt] = [:]

    static func eligible(paired: Bool, product: String?, version: String?, transport: String?) -> Bool {
        guard paired, let product, product.hasPrefix("iPhone") || product.hasPrefix("iPad"),
              let version, (Int(version.split(separator: ".").first ?? "") ?? 0) >= 27,
              transport == "localNetwork" || transport == "wired" else { return false }
        return true
    }

    mutating func begin(id: String, state: String, paired: Bool, product: String?, version: String?,
                        transport: String?, now: TimeInterval) -> Bool {
        guard !id.isEmpty, state == "disconnected",
              Self.eligible(paired: paired, product: product, version: version, transport: transport) else { return false }
        var attempt = attempts[id] ?? Attempt()
        guard !attempt.running, now >= attempt.retryAt,
              now - attempt.startedAt >= 2,
              attempts.values.filter(\.running).count < 2 else { return false }
        attempt.running = true; attempt.startedAt = now
        attempts[id] = attempt
        return true
    }

    mutating func finished(id: String, connected: Bool, now: TimeInterval) {
        guard var attempt = attempts[id] else { return }
        attempt.running = false
        attempt.failures = connected ? 0 : min(attempt.failures + 1, 6)
        attempt.retryAt = now + (connected ? 2 : min(60, pow(2, Double(attempt.failures))))
        attempts[id] = attempt
    }

    mutating func networkChanged() {
        for id in attempts.keys where attempts[id]?.running == false {
            attempts[id]?.retryAt = 0
        }
    }

    mutating func retain(_ ids: Set<String>) {
        attempts = attempts.filter { ids.contains($0.key) || $0.value.running }
    }
}
