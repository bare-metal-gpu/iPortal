// Isolated public Network.framework feasibility check. This executable binds
// IPv4 loopback only and never advertises a service or discovers a real device.
// includePeerToPeer is configured, but loopback does not establish AWDL, Wi-Fi,
// USB handover, device authorization, or background-execution feasibility.
import Foundation
import Network
import Security

private struct PeerProbeFailure: Error { let reason: String }

private struct PeerProbeFrame: Equatable {
    static let maximumBytes = 64 * 1024
    static let minimumBytes = 21
    let generation: UUID
    let sequence: UInt32
    let payload: Data
    func encoded() throws -> Data {
        guard payload.count <= Self.maximumBytes - Self.minimumBytes else { throw PeerProbeFailure(reason: "frame_limit") }
        var body = Data([1]), uuid = generation.uuid, sequence = sequence.bigEndian
        withUnsafeBytes(of: &uuid) { body.append(contentsOf: $0) }
        withUnsafeBytes(of: &sequence) { body.append(contentsOf: $0) }
        body.append(payload)
        var length = UInt32(body.count).bigEndian, framed = Data()
        withUnsafeBytes(of: &length) { framed.append(contentsOf: $0) }
        framed.append(body)
        return framed
    }
    static func decode(_ bytes: Data) throws -> PeerProbeFrame {
        guard (minimumBytes...maximumBytes).contains(bytes.count), bytes[0] == 1 else {
            throw PeerProbeFailure(reason: "invalid_frame")
        }
        var uuid: uuid_t = (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
        _ = withUnsafeMutableBytes(of: &uuid) { bytes[1..<17].copyBytes(to: $0) }
        let sequence = bytes[17..<21].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        return PeerProbeFrame(generation: UUID(uuid: uuid), sequence: sequence, payload: bytes.subdata(in: 21..<bytes.count))
    }
}

private struct PeerProbeOwner {
    enum State { case ready, waiting(UInt32), closed }
    let generation = UUID()
    private(set) var state = State.ready
    private var next: UInt32 = 1
    mutating func begin() -> UInt32? {
        guard case .ready = state else { return nil }
        let sequence = next; next += 1; state = .waiting(sequence); return sequence
    }
    mutating func accept(_ frame: PeerProbeFrame) -> Bool {
        guard frame.generation == generation, case .waiting(let expected) = state, frame.sequence == expected else { return false }
        state = .ready; return true
    }
    mutating func close() { state = .closed }
}

private func peerProbeSecret() throws -> Data {
    var bytes = Data(count: 32)
    let result = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, $0.count, $0.baseAddress!) }
    guard result == errSecSuccess else { throw PeerProbeFailure(reason: "entropy_unavailable") }
    return bytes
}

private func peerProbeIdentity() throws -> Data {
    // Use a printable PSK identity rather than arbitrary binary (which can
    // contain NUL). The identity is random routing metadata, never the key.
    Data(try peerProbeSecret().map { String(format: "%02x", $0) }.joined().utf8)
}

private func peerProbeParameters(key: Data, identity: Data, listener: Bool) -> NWParameters {
    let tls = NWProtocolTLS.Options()
    let secret = key.withUnsafeBytes { DispatchData(bytes: $0) }
    let identifier = identity.withUnsafeBytes { DispatchData(bytes: $0) }
    sec_protocol_options_add_pre_shared_key(tls.securityProtocolOptions, secret as __DispatchData, identifier as __DispatchData)
    // TN3213: Network.framework's external PSKs support TLS 1.2 only, not
    // TLS 1.3/QUIC. This isolated test uses a random per-run key, never a password.
    sec_protocol_options_append_tls_ciphersuite(tls.securityProtocolOptions,
        tls_ciphersuite_t(rawValue: UInt16(TLS_PSK_WITH_AES_128_GCM_SHA256))!)
    sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv12)
    sec_protocol_options_set_max_tls_protocol_version(tls.securityProtocolOptions, .TLSv12)
    let tcp = NWProtocolTCP.Options()
    tcp.noDelay = true
    tcp.connectionTimeout = 2
    let parameters = NWParameters(tls: tls, tcp: tcp)
    parameters.includePeerToPeer = true
    parameters.serviceClass = .responsiveData
    parameters.requiredInterfaceType = .loopback
    if listener { parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any) }
    return parameters
}

private struct PeerProbeResult: Encodable {
    var mode: String
    var exchanges = 0
    var pathEvents = 0
    var viabilityEvents = 0
    var betterPathEvents = 0
    var establishmentMs: Double?
    var elapsedMs = 0.0
    var activeRequestMs: Double?
    var transportRTTMs: Double?
    var sentBytes: UInt64?
    var receivedBytes: UInt64?
    var tlsVersion: UInt16?
    var cipherSuite: UInt16?
    var authenticationRejected = false
    var tlsRejectionCode: Int32?
    var oversizedRejected = false
    var deadlineExpired = false
    var cancelled = false
    var requestObserved = false
    let loopbackOnly = true
    let includePeerToPeerConfigured = true
}

private final class PeerNetworkProbe: @unchecked Sendable {
    enum Mode: String { case roundtrip, wrongKey, wrongIdentity, oversized, deadline, cancellation }
    private let queue = DispatchQueue(label: "iportal.experiment.peer-network")
    private let mode: Mode
    private var result: PeerProbeResult
    private var owner = PeerProbeOwner()
    private var listener: NWListener?
    private var client: NWConnection?
    private var server: NWConnection?
    private var deadline: DispatchWorkItem?
    private var requestDeadline: DispatchWorkItem?
    private var transfer: NWConnection.PendingDataTransferReport?
    private var continuation: CheckedContinuation<PeerProbeResult, Error>?
    private var terminal: Result<PeerProbeResult, Error>?
    private var expected: PeerProbeFrame?
    private var clientReady = false
    private var readBodies = 0
    private var pendingRequestObserver: CheckedContinuation<Bool, Never>?
    private var startedAt = ProcessInfo.processInfo.systemUptime
    private var admittedAt: TimeInterval?

    init(_ mode: Mode) { self.mode = mode; result = PeerProbeResult(mode: mode.rawValue) }
    func run() async throws -> PeerProbeResult {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                queue.async {
                    if let terminal = self.terminal { continuation.resume(with: terminal); return }
                    self.continuation = continuation
                    do { try self.start() } catch { self.finish(.failure(error)) }
                }
            }
        } onCancel: { self.queue.async { self.cancel() } }
    }
    func waitForPendingRequest() async -> Bool {
        await withCheckedContinuation { continuation in
            queue.async {
                if self.result.requestObserved { continuation.resume(returning: true) }
                else if self.terminal != nil { continuation.resume(returning: false) }
                else { self.pendingRequestObserver = continuation }
            }
        }
    }
    private func cancel() {
        result.cancelled = true
        finish(.success(result))
    }
    private func start() throws {
        startedAt = ProcessInfo.processInfo.systemUptime
        let key = try peerProbeSecret(), identity = try peerProbeIdentity()
        let listener = try NWListener(using: peerProbeParameters(key: key, identity: identity, listener: true), on: .any)
        self.listener = listener
        let timeout = DispatchWorkItem { [weak self] in self?.fail("setup_or_probe_deadline") }
        deadline = timeout; queue.asyncAfter(deadline: .now() + 8, execute: timeout)
        listener.newConnectionHandler = { [weak self] connection in
            guard let self, self.terminal == nil, self.server == nil else { connection.forceCancel(); return }
            self.server = connection
            connection.stateUpdateHandler = { [weak self] state in
                guard let self, self.terminal == nil else { return }
                switch state {
                case .ready: self.readFrame(connection, isServer: true)
                case .failed(let error): self.connectionFailed(error)
                default: break
                }
            }
            connection.start(queue: self.queue)
        }
        listener.stateUpdateHandler = { [weak self] state in
            guard let self, self.terminal == nil else { return }
            switch state {
            case .ready:
                guard self.client == nil, let port = listener.port else { return }
                do {
                    let clientKey = self.mode == .wrongKey ? try peerProbeSecret() : key
                    let clientIdentity = self.mode == .wrongIdentity ? try peerProbeIdentity() : identity
                    self.startClient(port: port, key: clientKey, identity: clientIdentity)
                } catch { self.finish(.failure(error)) }
            case .failed: self.fail("listener_failure")
            default: break
            }
        }
        listener.start(queue: queue)
    }
    private func startClient(port: NWEndpoint.Port, key: Data, identity: Data) {
        let connection = NWConnection(host: "127.0.0.1", port: port,
            using: peerProbeParameters(key: key, identity: identity, listener: false))
        client = connection
        connection.pathUpdateHandler = { [weak self] _ in
            guard let self, self.terminal == nil else { return }; self.result.pathEvents += 1
        }
        connection.viabilityUpdateHandler = { [weak self] _ in
            guard let self, self.terminal == nil else { return }; self.result.viabilityEvents += 1
        }
        connection.betterPathUpdateHandler = { [weak self] _ in
            guard let self, self.terminal == nil else { return }; self.result.betterPathEvents += 1
        }
        connection.stateUpdateHandler = { [weak self] state in
            guard let self, self.terminal == nil else { return }
            switch state {
            case .ready:
                self.clientReady = true
                guard self.mode != .wrongKey && self.mode != .wrongIdentity else { self.fail("unauthenticated_connection_became_ready"); return }
                guard let tls = connection.metadata(definition: NWProtocolTLS.definition) as? NWProtocolTLS.Metadata else {
                    self.fail("tls_metadata_missing"); return
                }
                self.result.tlsVersion = sec_protocol_metadata_get_negotiated_tls_protocol_version(tls.securityProtocolMetadata).rawValue
                self.result.cipherSuite = sec_protocol_metadata_get_negotiated_tls_ciphersuite(tls.securityProtocolMetadata).rawValue
                connection.requestEstablishmentReport(queue: self.queue) { [weak self] report in
                    guard let self, self.terminal == nil else { return }; self.result.establishmentMs = report.map { $0.duration * 1000 }
                }
                self.transfer = connection.startDataTransferReport()
                self.sendNext()
            case .failed(let error): self.connectionFailed(error)
            default: break
            }
        }
        connection.start(queue: queue)
    }
    private func sendNext() {
        guard terminal == nil, let client else { return }
        if mode == .oversized {
            var length = UInt32(PeerProbeFrame.maximumBytes + 1).bigEndian
            let bytes = withUnsafeBytes(of: &length) { Data($0) }
            send(bytes, on: client)
            return
        }
        guard let sequence = owner.begin() else { fail("overlapping_request"); return }
        let frame = PeerProbeFrame(generation: owner.generation, sequence: sequence,
            payload: Data(repeating: UInt8(sequence % 255), count: 128))
        expected = frame
        let timeout = DispatchWorkItem { [weak self] in
            guard let self, self.terminal == nil else { return }
            if self.mode == .deadline { self.result.deadlineExpired = true; self.finish(.success(self.result)) }
            else { self.fail("request_deadline") }
        }
        requestDeadline = timeout
        queue.asyncAfter(deadline: .now() + (mode == .deadline ? 0.08 : 2), execute: timeout)
        do { send(try frame.encoded(), on: client) }
        catch { finish(.failure(error)); return }
        readFrame(client, isServer: false)
    }
    private func send(_ bytes: Data, on connection: NWConnection) {
        connection.send(content: bytes, completion: .contentProcessed { [weak self] error in
            guard let self, self.terminal == nil else { return }
            if let error { self.connectionFailed(error) }
        })
    }
    private func readFrame(_ connection: NWConnection, isServer: Bool) {
        connection.receive(minimumIncompleteLength: 4, maximumLength: 4) { [weak self] data, _, complete, error in
            guard let self, self.terminal == nil else { return }
            guard error == nil, let data, data.count == 4 else { self.fail("frame_header_incomplete"); return }
            let size = data.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
            guard (PeerProbeFrame.minimumBytes...PeerProbeFrame.maximumBytes).contains(Int(size)) else {
                if self.mode == .oversized && isServer && self.readBodies == 0 {
                    self.result.oversizedRejected = true; self.finish(.success(self.result))
                } else { self.fail("frame_limit") }
                return
            }
            guard !complete else { self.fail("frame_body_missing"); return }
            self.readBodies += 1
            connection.receive(minimumIncompleteLength: Int(size), maximumLength: Int(size)) { [weak self] body, _, _, error in
                guard let self, self.terminal == nil else { return }
                guard error == nil, let body, body.count == Int(size) else { self.fail("frame_body_incomplete"); return }
                do { try self.received(PeerProbeFrame.decode(body), on: connection, isServer: isServer) }
                catch { self.finish(.failure(error)) }
            }
        }
    }
    private func received(_ frame: PeerProbeFrame, on connection: NWConnection, isServer: Bool) throws {
        guard frame == expected else { fail("stale_or_corrupt_response"); return }
        if isServer {
            result.requestObserved = true
            if admittedAt == nil { admittedAt = ProcessInfo.processInfo.systemUptime }
            pendingRequestObserver?.resume(returning: true); pendingRequestObserver = nil
            if mode == .deadline || mode == .cancellation { return }
            send(try frame.encoded(), on: connection)
            readFrame(connection, isServer: true)
            return
        }
        guard owner.accept(frame) else { fail("receipt_ownership"); return }
        requestDeadline?.cancel(); requestDeadline = nil
        result.exchanges += 1
        if result.exchanges < 30 { sendNext(); return }
        guard let transfer else { fail("transfer_report_missing"); return }
        transfer.collect(queue: queue) { [weak self] report in
            guard let self, self.terminal == nil else { return }
            self.result.transportRTTMs = report.aggregatePathReport.transportSmoothedRTT * 1000
            self.result.sentBytes = report.aggregatePathReport.sentApplicationByteCount
            self.result.receivedBytes = report.aggregatePathReport.receivedApplicationByteCount
            self.finish(.success(self.result))
        }
    }
    private func connectionFailed(_ error: NWError) {
        let authenticationFailures: Set<OSStatus> = [errSSLPeerHandshakeFail, errSSLPeerBadRecordMac,
            errSSLPeerDecryptError, errSSLPeerAccessDenied, errSSLDecryptionFail,
            errSSLBadRecordMac, errSSLUnknownPSKIdentity]
        if (mode == .wrongKey || mode == .wrongIdentity), !clientReady, readBodies == 0,
           case .tls(let code) = error, authenticationFailures.contains(code) {
            result.tlsRejectionCode = code
            result.authenticationRejected = true; finish(.success(result))
        } else if mode == .wrongKey || mode == .wrongIdentity {
            // The opposite endpoint can report a generic close first. Wait for
            // the specific TLS failure, or fail the bounded probe deadline.
            // A socket close by itself never establishes authentication safety.
        } else { fail("connection_failure_\(error)") }
    }
    private func fail(_ reason: String) { finish(.failure(PeerProbeFailure(reason: "\(mode.rawValue): \(reason)"))) }
    private func finish(_ completion: Result<PeerProbeResult, Error>) {
        guard terminal == nil else { return }
        let now = ProcessInfo.processInfo.systemUptime
        let completion = completion.map { result -> PeerProbeResult in
            var result = result
            result.elapsedMs = (now - startedAt) * 1000
            result.activeRequestMs = admittedAt.map { (now - $0) * 1000 }
            return result
        }
        terminal = completion; owner.close()
        deadline?.cancel(); requestDeadline?.cancel()
        client?.stateUpdateHandler = nil; server?.stateUpdateHandler = nil
        client?.pathUpdateHandler = nil; client?.viabilityUpdateHandler = nil
        client?.betterPathUpdateHandler = nil
        listener?.stateUpdateHandler = nil; listener?.newConnectionHandler = nil
        client?.forceCancel(); server?.forceCancel(); listener?.cancel()
        client = nil; server = nil; listener = nil; transfer = nil
        pendingRequestObserver?.resume(returning: false); pendingRequestObserver = nil
        let continuation = continuation; self.continuation = nil
        continuation?.resume(with: completion)
    }
}

#if os(macOS)
@main private enum NetworkProbeMain {
    static func main() async {
        do { try await check() }
        catch {
            FileHandle.standardError.write(Data("Network probe failed: \(error)\n".utf8))
            exit(1)
        }
    }
    private static func check() async throws {
        guard CommandLine.arguments.count == 1 else { throw PeerProbeFailure(reason: "loopback_only_no_peer_mode") }
        var owner = PeerProbeOwner()
        let id = owner.begin()!
        precondition(owner.begin() == nil, "Only one request may own this connection")
        let stale = PeerProbeFrame(generation: UUID(), sequence: id, payload: Data())
        precondition(!owner.accept(stale))
        let correct = PeerProbeFrame(generation: owner.generation, sequence: id, payload: Data())
        precondition(owner.accept(correct)); precondition(!owner.accept(correct), "Receipts cannot replay")
        _ = owner.begin(); owner.close()
        precondition(owner.begin() == nil && !owner.accept(correct), "Cancellation retires ownership")
        var rejectedLimit = false
        do { _ = try PeerProbeFrame(generation: UUID(), sequence: 1, payload: Data(count: PeerProbeFrame.maximumBytes)).encoded() }
        catch { rejectedLimit = true }
        precondition(rejectedLimit)
        for invalid in [Data(), Data(repeating: 1, count: PeerProbeFrame.minimumBytes - 1),
                        Data(repeating: 2, count: PeerProbeFrame.minimumBytes)] {
            var rejected = false
            do { _ = try PeerProbeFrame.decode(invalid) } catch { rejected = true }
            precondition(rejected, "Malformed frame must fail before ownership")
        }
        var results: [PeerProbeResult] = []
        for mode in [PeerNetworkProbe.Mode.roundtrip, .wrongKey, .wrongIdentity, .oversized, .deadline] {
            results.append(try await PeerNetworkProbe(mode).run())
        }
        let cancellationProbe = PeerNetworkProbe(.cancellation)
        let cancelled = Task { try await cancellationProbe.run() }
        let admitted = await cancellationProbe.waitForPendingRequest()
        precondition(admitted, "Cancellation test must own an admitted request")
        cancelled.cancel()
        results.append(try await cancelled.value)
        let bytes = try JSONEncoder().encode(results)
        FileHandle.standardOutput.write(bytes + Data([10]))
    }
}
#endif
