import Foundation

@main struct DiscoveryRecoveryTests {
    static func main() {
        var recovery = PairedDiscoveryRecovery()
        func begin(_ now: TimeInterval, id: String = "phone", state: String = "disconnected",
                   paired: Bool = true, product: String? = "iPhone17,1", version: String? = "27.3",
                   transport: String? = "localNetwork") -> Bool {
            recovery.begin(id: id, state: state, paired: paired, product: product,
                           version: version, transport: transport, now: now)
        }
        assert(!begin(0, paired: false), "recovery must never initiate pairing")
        for state in ["unavailable", "connecting", "connected"] { assert(!begin(0, state: state)) }
        for transport in ["cloud", "sameMachine", nil] { assert(!begin(0, transport: transport)) }
        assert(!begin(0, product: "Watch7,1")); assert(!begin(0, version: "26.5"))
        assert(!begin(0, version: nil)); assert(!begin(0, id: ""))
        assert(begin(0)); assert(!begin(20), "an unfinished attempt cannot duplicate")
        assert(begin(0, id: "tablet", product: "iPad16,1"))
        assert(!begin(0, id: "third"), "at most two simultaneous recovery children per observer")
        recovery.finished(id: "phone", connected: false, now: 1)
        assert(!begin(2)); assert(begin(3))
        recovery.finished(id: "phone", connected: false, now: 4)
        assert(!begin(7)); assert(begin(8))
        recovery.networkChanged()
        assert(!begin(9), "network events cannot duplicate in-flight work")
        recovery.finished(id: "phone", connected: false, now: 9)
        assert(!begin(10))
        recovery.networkChanged()
        assert(begin(10), "a new network can retry without the old backoff")
        recovery.finished(id: "phone", connected: true, now: 11)
        assert(!begin(12)); assert(begin(13))
        recovery.finished(id: "phone", connected: false, now: 14)
        assert(begin(16), "success reset the exponential failure history")
        recovery.finished(id: "phone", connected: false, now: 17)
        recovery.retain(["tablet"])
        assert(begin(18), "removed identities do not retain retry history")
        print("Paired recovery: supported/pairing gates, concurrency, backoff and network wake tests passed.")
    }
}
