import Cocoa
@preconcurrency import AVFoundation
import VideoToolbox

// BEGIN TESTABLE MEDIA INPUT
func readAvailableMediaBytes(_ handle: FileHandle) -> Data { handle.availableData }
// END TESTABLE MEDIA INPUT

// BEGIN TESTABLE MEDIA DECODE OWNERSHIP
// The decoder may complete synchronously, asynchronously, or out of order.
// Every submitted compressed frame keeps its reference dependencies; only an
// obsolete decoded presentation is discarded. Saturation applies bounded
// backpressure instead of silently dropping HEVC reference frames.
final class MediaDecodeOwnership: @unchecked Sendable {
    private let condition = NSCondition()
    private var pending: Set<UInt64> = []
    private var next: UInt64 = 0
    private var presented: UInt64?
    private var retired = false
    let capacity: Int

    init(capacity: Int = 2) { precondition(capacity > 0); self.capacity = capacity }

    func admit(until deadline: Date) -> UInt64? {
        condition.lock(); defer { condition.unlock() }
        while !retired && pending.count >= capacity {
            if !condition.wait(until: deadline) { return nil }
        }
        guard !retired else { return nil }
        let sequence = next; next &+= 1
        pending.insert(sequence)
        return sequence
    }

    func complete(_ sequence: UInt64) {
        condition.lock(); defer { condition.unlock() }
        pending.remove(sequence)
        condition.broadcast()
    }

    func retire() {
        condition.lock(); defer { condition.unlock() }
        retired = true
        condition.broadcast()
    }

    var isCurrent: Bool {
        condition.lock(); defer { condition.unlock() }
        return !retired
    }

    @discardableResult func present(_ sequence: UInt64, _ action: () -> Void) -> Bool {
        condition.lock(); defer { condition.unlock() }
        guard !retired, pending.contains(sequence), presented.map({ sequence > $0 }) ?? true else { return false }
        presented = sequence
        // FrameStore consumption is brief. Holding the ownership lock makes
        // retirement atomic with delivery, so an old generation cannot flash
        // after its replacement has started.
        action()
        return true
    }
}

// Decoder teardown is synchronous inside VideoToolbox and has no deadline API.
// A per-device budget includes active and retiring sessions across replacement
// receivers, so a stalled teardown cannot accumulate unbounded generations.
final class MediaDecoderBudget: @unchecked Sendable {
    private final class WeakBudget { weak var value: MediaDecoderBudget?; init(_ value: MediaDecoderBudget) { self.value = value } }
    private static let registryLock = NSLock()
    private static var devices: [String: WeakBudget] = [:]
    private let lock = NSLock()
    private var sessions: Set<UUID> = []
    private let capacity: Int
    init(capacity: Int = 3) { precondition(capacity > 0); self.capacity = capacity }
    static func device(_ identifier: String) -> MediaDecoderBudget {
        registryLock.lock(); defer { registryLock.unlock() }
        devices = devices.filter { $0.value.value != nil }
        let key = identifier.lowercased().filter { $0.isLetter || $0.isNumber }
        if let existing = devices[key]?.value { return existing }
        let budget = MediaDecoderBudget()
        devices[key] = WeakBudget(budget)
        return budget
    }
    func acquire() -> UUID? {
        lock.lock(); defer { lock.unlock() }
        guard sessions.count < capacity else { return nil }
        let token = UUID(); sessions.insert(token); return token
    }
    func release(_ token: UUID) { lock.lock(); sessions.remove(token); lock.unlock() }
}
// END TESTABLE MEDIA DECODE OWNERSHIP

// BEGIN TESTABLE MEDIA PIXEL ATTRIBUTES
func nativeMediaUsesYUV(bitsPerComponent: Int?, transferFunction: String?) -> Bool {
    // The established display/crop path is SDR. Native HDR needs matching
    // transforms, EDR presentation and screenshot handling before opting in.
    // Missing metadata is not proof of SDR or of an eight-bit source.
    guard bitsPerComponent == 8, let transferFunction else { return false }
    return [kCVImageBufferTransferFunction_ITU_R_709_2 as String,
            kCVImageBufferTransferFunction_sRGB as String].contains(transferFunction)
}
func nativeMediaPixelAttributeCandidates(_ recommended: [String: Any], nativeYUV: Bool = false) -> [[String: Any]] {
    let surface: [String: Any] = [kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
    let legacy = surface.merging([kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]) { _, new in new }
    var resolved: CFDictionary?
    let status = CVPixelBufferCreateResolvedAttributesDictionary(nil, [recommended, surface] as CFArray, &resolved)
    var candidates: [[String: Any]] = []
    if status == kCVReturnSuccess, let attributes = resolved as? [String: Any] {
        // Let VT choose the native range for confirmed eight-bit SDR. All
        // other formats retain the previous BGRA decode behavior consistently
        // in portrait, landscape, and codec-padding crops.
        var native = attributes
        if nativeYUV { native.removeValue(forKey: kCVPixelBufferPixelFormatTypeKey as String) }
        else { native[kCVPixelBufferPixelFormatTypeKey as String] = kCVPixelFormatType_32BGRA }
        candidates.append(native)
    }
    if nativeYUV { candidates.append(surface) }
    candidates.append(legacy)
    return candidates
}
// END TESTABLE MEDIA PIXEL ATTRIBUTES

// One process and decoder per physical device. The child owns only its paired
// CoreDevice session; malformed records, exit, or stale callbacks cannot migrate
// into a replacement capture. All queues are bounded by the OS pipe and decoder.
final class NativeMediaReceiver: @unchecked Sendable {
    private let queue = DispatchQueue(label: "iportal.native-media", qos: .userInteractive)
    private let presentationQueue = DispatchQueue(label: "iportal.native-media-pixels", qos: .userInteractive)
    private let decoderCleanupQueue = DispatchQueue(label: "iportal.native-media-cleanup", qos: .utility)
    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private let lifetime: CaptureLifetime
    private let frames: FrameStore
    private var decoder: VTDecompressionSession?
    private var decoderBudget = MediaDecoderBudget()
    private var decoderPermit: UUID?
    private var decodeOwnership = MediaDecodeOwnership()
    private let ownershipLock = NSLock()
    private let pixelBufferAttributes: [String: Any]
    private var format: CMVideoFormatDescription?
    private var waitingForSync = true
    private var receivedFrames = 0
    private var buffered = Data()
    private let failed: @Sendable () -> Void
    private let capabilities: @Sendable (PairedCapabilities) -> Void
    private let unchanged: @Sendable (UInt32) -> Void
    private let audio = NativeMediaAudio()
    private let rotation = NativeMediaRotation()
    static var executable: URL { Bundle.main.executableURL!.deletingLastPathComponent().appendingPathComponent("iPortalTransport") }
    static var available: Bool { FileManager.default.isExecutableFile(atPath: executable.path) }

    init(lifetime: CaptureLifetime, frames: FrameStore, pixelBufferAttributes: [String: Any] = [:], capabilities: @escaping @Sendable (PairedCapabilities) -> Void,
         unchanged: @escaping @Sendable (UInt32) -> Void, failed: @escaping @Sendable () -> Void) {
        self.lifetime = lifetime; self.frames = frames; self.failed = failed; self.capabilities = capabilities
        self.unchanged = unchanged
        self.pixelBufferAttributes = pixelBufferAttributes
    }
    func start(udid: String) throws {
        decoderBudget = MediaDecoderBudget.device(udid)
        process.executableURL = Self.executable
        process.arguments = ["--stream", udid]
        process.standardInput = input; process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { [weak self] child in iportalTrace("paired-media-exit", ["code":child.terminationStatus]); self?.reportFailure() }
        try process.run()
        queue.async { [self] in
            defer { resetDecoder(); audio.stop() }
            while !lifetime.isCancelled {
                // read(upToCount:) fills its requested count on Darwin pipes,
                // batching small HEVC frames for seconds. availableData returns
                // as soon as any bytes arrive; framing below handles partial reads.
                let data = readAvailableMediaBytes(output.fileHandleForReading)
                guard !data.isEmpty else { break }
                buffered.append(data)
                while buffered.count >= 16 {
                    let kind = word(buffered, 0), flags = word(buffered, 4), time = word(buffered, 8), size = Int(word(buffered, 12))
                    guard size <= 8 * 1024 * 1024 else { reportFailure(); return }
                    if buffered.count < 16 + size { break }
                    let data = Data(buffered[16..<16 + size])
                    buffered.removeSubrange(0..<16 + size)
                    do { try receive(kind: kind, flags: flags, time: time, data: data) }
                    catch { reportFailure(); return }
                }
            }
            if !lifetime.isCancelled { reportFailure() }
        }
    }
    func setVolume(_ volume: Float) { audio.setVolume(volume) }
    func setOrientation(_ value: String) { rotation.setOrientation(value) }
    func setDisplayPixels(_ value: CGSize) { rotation.setDisplayPixels(value) }
    func stop() {
        ownershipLock.lock(); decodeOwnership.retire(); ownershipLock.unlock()
        audio.stop()
        try? input.fileHandleForWriting.close()
        // Let the child cancel and drop its lease; force only this owned child
        // after the deadline if an incompatible framework stalls during startup.
        let child = process
        DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
            if child.isRunning { child.terminate() }
        }
    }
    private func reportFailure() { if !lifetime.isCancelled { failed() } }
    private func word(_ data: Data, _ offset: Int) -> UInt32 {
        data[offset..<offset + 4].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
    }
    private func resetDecoder() {
        waitingForSync = true
        ownershipLock.lock()
        decodeOwnership.retire()
        decodeOwnership = MediaDecodeOwnership()
        ownershipLock.unlock()
        if let decoder, let permit = decoderPermit {
            // Invalidation is an orderly teardown; retired callbacks cannot
            // publish. Never wait for decoder teardown on the media pipe or
            // main queue, particularly across sleep and format replacement.
            let budget = decoderBudget
            decoderCleanupQueue.async {
                VTDecompressionSessionInvalidate(decoder)
                budget.release(permit)
            }
        }
        decoder = nil; decoderPermit = nil; format = nil
    }
    private func receive(kind: UInt32, flags: UInt32, time: UInt32, data: Data) throws {
        guard !lifetime.isCancelled else { return }
        switch kind {
        case 0: break // Endpoint metadata belongs to the transport monitor.
        case 2: try configure(data)
        case 1: receivedFrames += 1; try decode(data, sync: flags & 1 != 0, time: time)
        case 3: audio.consume(data, timestamp: time)
        case 7: capabilities(try JSONDecoder().decode(PairedCapabilities.self, from: data))
        case 8: unchanged(time)
        case 5: resetDecoder()
        case 6: if var stats = try JSONSerialization.jsonObject(with: data) as? [String:Any] { stats["receivedFrames"] = receivedFrames; iportalTrace("paired-media-stats", stats) }
        default: throw CocoaError(.coderReadCorrupt)
        }
    }
    private func configure(_ data: Data) throws {
        var sets: [Data] = [], offset = 0
        while offset + 4 <= data.count {
            let size = Int(word(data, offset)); offset += 4
            guard (2...65536).contains(size), offset + size <= data.count else { throw CocoaError(.coderReadCorrupt) }
            sets.append(data.subdata(in: offset..<offset + size)); offset += size
        }
        guard offset == data.count, sets.count == 3 else { throw CocoaError(.coderReadCorrupt) }
        resetDecoder()
        var description: CMFormatDescription?
        let status = sets[0].withUnsafeBytes { a in sets[1].withUnsafeBytes { b in sets[2].withUnsafeBytes { c in
            let pointers = [a.baseAddress!.assumingMemoryBound(to: UInt8.self), b.baseAddress!.assumingMemoryBound(to: UInt8.self), c.baseAddress!.assumingMemoryBound(to: UInt8.self)]
            return CMVideoFormatDescriptionCreateFromHEVCParameterSets(allocator: nil, parameterSetCount: 3, parameterSetPointers: pointers,
                parameterSetSizes: sets.map(\.count), nalUnitHeaderLength: 4, extensions: nil, formatDescriptionOut: &description)
        }}}
        guard status == noErr, let description else { throw CocoaError(.coderReadCorrupt) }
        format = description
        let coded = CMVideoFormatDescriptionGetDimensions(description)
        let aperture = CMVideoFormatDescriptionGetCleanAperture(description, originIsAtTopLeft: false)
        let depth = (CMFormatDescriptionGetExtension(description, extensionKey: kCMFormatDescriptionExtension_BitsPerComponent) as? NSNumber)?.intValue
        let transfer = CMFormatDescriptionGetExtension(description, extensionKey: kCMFormatDescriptionExtension_TransferFunction) as? String
        let nativeYUV = nativeMediaUsesYUV(bitsPerComponent: depth, transferFunction: transfer)
        iportalTrace("paired-video-format", ["codedWidth": coded.width, "codedHeight": coded.height,
            "visibleWidth": aperture.width, "visibleHeight": aperture.height,
            "visibleX": aperture.minX, "visibleY": aperture.minY,
            "bitsPerComponent": depth ?? 0, "nativeYUV": nativeYUV])
        guard let permit = decoderBudget.acquire() else {
            iportalTrace("paired-decoder-retirement-stalled")
            throw CocoaError(.coderReadCorrupt)
        }
        var session: VTDecompressionSession?
        for attributes in nativeMediaPixelAttributeCandidates(pixelBufferAttributes, nativeYUV: nativeYUV) {
            let status = VTDecompressionSessionCreate(allocator: nil, formatDescription: description, decoderSpecification: nil,
                imageBufferAttributes: attributes as CFDictionary, outputCallback: nil, decompressionSessionOut: &session)
            if status == noErr, session != nil { break }
            if let rejected = session {
                // An unexpectedly partially created session still consumes its
                // budget until orderly teardown. Do not overlap a fallback.
                decoder = rejected; decoderPermit = permit
                throw CocoaError(.coderReadCorrupt)
            }
        }
        guard let session else { decoderBudget.release(permit); throw CocoaError(.coderReadCorrupt) }
        VTSessionSetProperty(session, key: kVTDecompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        decoder = session; decoderPermit = permit
    }
    private func decode(_ data: Data, sync: Bool, time: UInt32) throws {
        guard let decoder, let format, !waitingForSync || sync else { return }
        waitingForSync = false
        ownershipLock.lock(); let ownership = decodeOwnership; ownershipLock.unlock()
        guard let sequence = ownership.admit(until: Date(timeIntervalSinceNow: 1)) else {
            if lifetime.isCancelled || !ownership.isCurrent { return }
            throw CocoaError(.coderReadCorrupt) // Stalled decoder: bounded capture recovery.
        }
        var dispatched = false
        defer { if !dispatched { ownership.complete(sequence) } }
        var block: CMBlockBuffer?
        guard CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: data.count,
                blockAllocator: nil, customBlockSource: nil, offsetToData: 0, dataLength: data.count, flags: 0,
                blockBufferOut: &block) == noErr, let block else { throw CocoaError(.coderReadCorrupt) }
        let copied = data.withUnsafeBytes { CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: data.count) }
        guard copied == noErr else { throw CocoaError(.coderReadCorrupt) }
        var sample: CMSampleBuffer?, size = data.count
        var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: CMTime(value: Int64(time), timescale: 90000), decodeTimeStamp: .invalid)
        guard CMSampleBufferCreateReady(allocator: nil, dataBuffer: block, formatDescription: format, sampleCount: 1,
                sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 1, sampleSizeArray: &size,
                sampleBufferOut: &sample) == noErr, let sample else { throw CocoaError(.coderReadCorrupt) }
        // Two asynchronous decodes let the pipe deliver audio while the GPU
        // works, with no unbounded compressed-frame queue. Do not opt into
        // temporal processing, which permits delayed output for frame reordering.
        let aperture = CMVideoFormatDescriptionGetCleanAperture(format, originIsAtTopLeft: false)
        let started = ProcessInfo.processInfo.systemUptime
        let status = VTDecompressionSessionDecodeFrame(decoder, sampleBuffer: sample, flags: [._EnableAsynchronousDecompression], infoFlagsOut: nil) { [weak self, frames, lifetime, rotation, presentationQueue] status, _, pixel, time, duration in
            defer { ownership.complete(sequence) }
            guard ownership.isCurrent, !lifetime.isCancelled else { return }
            guard status == noErr else { self?.reportFailure(); return }
            guard let pixel else { return }
            // Core Image and its output pool are serial. This callback retains
            // its admission until conversion finishes, keeping pixel work bounded.
            presentationQueue.sync {
                guard ownership.isCurrent, !lifetime.isCancelled,
                      let rendered = rotation.apply(pixel, aperture: aperture) else { return }
                var format: CMVideoFormatDescription?, output: CMSampleBuffer?
                guard CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: rendered, formatDescriptionOut: &format) == noErr, let format else { return }
                var timing = CMSampleTimingInfo(duration: duration, presentationTimeStamp: time, decodeTimeStamp: .invalid)
                if CMSampleBufferCreateReadyWithImageBuffer(allocator: nil, imageBuffer: rendered, formatDescription: format, sampleTiming: &timing, sampleBufferOut: &output) == noErr, let output {
                    ownership.present(sequence) {
                        guard !lifetime.isCancelled else { return }
                        frames.consume(output)
                        if sequence == 0 || sequence % 120 == 0 {
                            iportalTrace("paired-video-decoded", ["decodeAndTransformMs": (ProcessInfo.processInfo.systemUptime - started) * 1000,
                                "nativePixelFormat": CVPixelBufferGetPixelFormatType(pixel),
                                "displayPixelFormat": CVPixelBufferGetPixelFormatType(rendered)])
                        }
                    }
                }
            }
        }
        dispatched = status == noErr
        guard status == noErr else { throw CocoaError(.coderReadCorrupt) }
    }
}

// Rotate pixels and their dimensions together before they enter FrameStore.
// The helper reports the foreground app's interface orientation, so holding a
// portrait-only app sideways does not incorrectly rotate its mirror.
// BEGIN TESTABLE MEDIA ROTATION
private final class NativeMediaRotation: @unchecked Sendable {
    private let lock = NSLock()
    private var orientation: CGImagePropertyOrientation = .up
    private var displayPixels: CGSize?
    private let context = CIContext(options: [.cacheIntermediates: false])
    private var pool: CVPixelBufferPool?
    private var poolSize = CGSize.zero
    func setDisplayPixels(_ size: CGSize) {
        guard size.width.isFinite, size.height.isFinite,
              (1...16384).contains(size.width), (1...16384).contains(size.height) else { return }
        lock.lock(); displayPixels = CGSize(width: min(size.width, size.height), height: max(size.width, size.height)); lock.unlock()
    }
    func setOrientation(_ value: String) {
        let next: CGImagePropertyOrientation
        switch value {
        case "PORTRAIT": next = .up
        case "LANDSCAPE": next = .left
        case "UIA_DEVICE_ORIENTATION_LANDSCAPERIGHT": next = .right
        case "UIA_DEVICE_ORIENTATION_PORTRAIT_UPSIDEDOWN": next = .down
        default: return
        }
        lock.lock(); orientation = next; lock.unlock()
    }
    func apply(_ pixel: CVPixelBuffer, aperture: CGRect? = nil) -> CVPixelBuffer? {
        lock.lock(); let orientation = orientation, displayPixels = displayPixels; lock.unlock()
        let bounds = CGRect(x: 0, y: 0, width: CVPixelBufferGetWidth(pixel), height: CVPixelBufferGetHeight(pixel))
        var visible = aperture ?? bounds
        // CoreDevice sometimes omits the HEVC conformance window. In that case
        // only remove codec-block padding beyond the authenticated device's
        // actual native pixel dimensions. Never infer a crop from black pixels
        // or apply full-resolution dimensions to a downscaled stream.
        if visible == bounds, let displayPixels,
           (0..<64).contains(bounds.width - displayPixels.width),
           (0..<64).contains(bounds.height - displayPixels.height) {
            visible = CGRect(x: 0, y: bounds.height - displayPixels.height,
                             width: displayPixels.width, height: displayPixels.height)
        }
        // HEVC's coded frame can include padding below/right of the display.
        // Preserve its declared clean aperture before rebuilding the format
        // description or rotating; otherwise that metadata is lost.
        guard !visible.isEmpty, !visible.isInfinite, bounds.contains(visible) else { return nil }
        guard orientation != .up || visible != bounds else { return pixel }
        let image = CIImage(cvPixelBuffer: pixel).cropped(to: visible)
            .transformed(by: CGAffineTransform(translationX: -visible.minX, y: -visible.minY))
            .oriented(orientation)
        let size = image.extent.size
        if pool == nil || size != poolSize {
            pool = nil; poolSize = size
            let attributes: [String: Any] = [kCVPixelBufferWidthKey as String: Int(size.width),
                kCVPixelBufferHeightKey as String: Int(size.height),
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
            guard CVPixelBufferPoolCreate(nil, nil, attributes as CFDictionary, &pool) == kCVReturnSuccess else { return nil }
        }
        guard let pool else { return nil }
        var output: CVPixelBuffer?
        let limits = [kCVPixelBufferPoolAllocationThresholdKey as String: 6] as CFDictionary
        guard CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(nil, pool, limits, &output) == kCVReturnSuccess,
              let output else { return nil }
        context.render(image, to: output)
        return output
    }
}
// END TESTABLE MEDIA ROTATION

// BEGIN TESTABLE AUDIO CLOCK
struct AudioPacketClock {
    private var last: UInt32?
    mutating func observe(_ timestamp: UInt32) -> (silence: Int, reset: Bool)? {
        defer { if last == nil { last = timestamp } }
        guard let previous = last else { return (0, false) }
        let delta = Int32(bitPattern: timestamp &- previous)
        if delta < -5760 { last = timestamp; return (0, true) }
        guard delta > 0 else { return nil } // duplicate or late packet, including wrap
        last = timestamp
        let gap = Int(delta) - 480
        if gap < 0 || gap > 5760 { return (0, true) }
        return (gap, false)
    }
}
struct AudioDriftControl {
    private var average = 18.0
    mutating func rate(pendingPackets: Int) -> Float {
        average = average * 0.99 + Double(pendingPackets) * 0.01
        // Correct small device/output clock skew without periodic whole-buffer
        // drops. Hard limits and discontinuity recovery still bound latency.
        return Float(min(1.002, max(0.998, 1 + (average - 18) * 0.00025)))
    }
}
// END TESTABLE AUDIO CLOCK

// BEGIN TESTABLE AUDIO START
func startNativeAudioPlayer(_ player: AVAudioPlayerNode) throws {
    if #available(macOS 27.0, *) {
        // play() passes no NSError destination and raises an Objective-C
        // exception when the output stops producing I/O during sleep.
        try player.playAudio()
    } else {
        guard player.engine?.isRunning == true else { throw CocoaError(.featureUnsupported) }
        player.play()
    }
}
// END TESTABLE AUDIO START

// Remote system audio needs no access to the Mac microphone. The existing mute
// control still governs playback. A small queue prevents stale audio catch-up.
private final class NativeMediaAudio: @unchecked Sendable {
    private let work = DispatchQueue(label: "iportal.native-audio", qos: .userInteractive)
    private var converter: AVAudioConverter?
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let rateUnit = AVAudioUnitVarispeed()
    private var clock = AudioPacketClock()
    private var drift = AudioDriftControl()
    private let output = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2)!
    private var queued = 0
    private var errors = 0
    private var reportedPlayback = false
    private var decodedPackets = 0
    private var droppedPackets = 0
    private var decodeFailures = 0
    private var maximumQueue = 0
    private var maximumGap = 0.0
    private var lastPacket = 0.0
    private var lastReport = 0.0
    private var playing = false
    private var queueGeneration: UInt64 = 0
    private var rebufferings = 0
    private var nextOutputAttemptAt = 0.0
    private var outputFailures = 0
    // The paired Wi-Fi tunnel delivers 10 ms packets in bursts as far as
    // 110 ms apart. Prime 120 ms once; bound backlog to 240 ms. This buffer is
    // audio-only and never holds a video frame or input event.
    private let primePackets = 12
    private let maximumPackets = 24
    private var volume: Float = 1
    private let lock = NSLock()
    private var stopped = false
    private var configurationObserver: NSObjectProtocol?
    private var graphConnected = false
    init() {
        engine.attach(player); engine.attach(rateUnit)
        configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange,
            object: engine, queue: nil) { [weak self] _ in
                // Apple posts on its internal audio queue. Reconfiguration and
                // teardown there can deadlock; all graph work belongs to ours.
                guard let self else { return }
                self.work.async { [weak self] in self?.configurationChanged() }
            }
    }
    deinit { if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver) } }
    private var isStopped: Bool { lock.lock(); defer { lock.unlock() }; return stopped }
    private func connectGraph() throws {
        graphConnected = false
        if #available(macOS 27.0, *) {
            // Like playAudio(), the new connection methods report an NSError
            // instead of raising an Objective-C exception during device changes.
            try engine.connectNode(player, to: rateUnit, format: output)
            try engine.connectNode(rateUnit, to: engine.mainMixerNode, format: output)
        } else {
            engine.connect(player, to: rateUnit, format: output)
            engine.connect(rateUnit, to: engine.mainMixerNode, format: output)
        }
        graphConnected = true
    }
    func setVolume(_ volume: Float) { lock.lock(); self.volume = volume; lock.unlock() }
    func consume(_ data: Data, timestamp: UInt32) {
        // A serial owner also keeps a hardware-change notification from
        // mutating the graph halfway through scheduling a packet. The call is
        // synchronous so there is no unbounded queue of stale audio payloads.
        work.sync { consumePacket(data, timestamp: timestamp) }
    }
    private func consumePacket(_ data: Data, timestamp: UInt32) {
        guard !isStopped else { return }
        guard ProcessInfo.processInfo.systemUptime >= nextOutputAttemptAt else { return }
        guard !data.isEmpty, let continuity = clock.observe(timestamp) else { return }
        if continuity.reset {
            lock.lock(); queueGeneration &+= 1; queued = 0; lock.unlock()
            player.stop(); playing = false; converter = nil; rebufferings += 1
        }
        let now = ProcessInfo.processInfo.systemUptime
        if lastPacket > 0 { maximumGap = max(maximumGap, now - lastPacket) }
        lastPacket = now
        defer {
            if now - lastReport >= 2 {
                iportalTrace("paired-audio-stats", ["decoded": decodedPackets, "dropped": droppedPackets,
                    "decodeFailures": decodeFailures, "maximumQueue": maximumQueue,
                    "maximumGapMs": maximumGap * 1000, "rebufferings": rebufferings, "outputFailures": outputFailures,
                    "primeMs": primePackets * 10,
                    // This is measurement, not a safe prediction of the next
                    // route. Keep the proven 120 ms floor across seamless
                    // USB/Wi-Fi handover until a lower target passes live tests.
                    "observedGapBufferMs": min(240, max(40, (ceil(maximumGap * 100) + 1) * 10)),
                    "outputPresentationLatencyMs": player.outputPresentationLatency * 1000])
                lastReport = now; maximumGap = 0; maximumQueue = 0
            }
        }
        if converter == nil {
            var format = AudioStreamBasicDescription(mSampleRate: 48000, mFormatID: kAudioFormatMPEG4AAC_ELD,
                mFormatFlags: 0, mBytesPerPacket: 0, mFramesPerPacket: 480, mBytesPerFrame: 0, mChannelsPerFrame: 2,
                mBitsPerChannel: 0, mReserved: 0)
            guard let input = AVAudioFormat(streamDescription: &format), let decoder = AVAudioConverter(from: input, to: output) else { return }
            decoder.magicCookie = Data([0xF8, 0xE6, 0x40, 0x00]); converter = decoder
        }
        guard let converter, let pcm = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: 480) else { return }
        let packet = AVAudioCompressedBuffer(format: converter.inputFormat, packetCapacity: 1, maximumPacketSize: data.count)
        data.withUnsafeBytes { packet.data.copyMemory(from: $0.baseAddress!, byteCount: data.count) }
        packet.byteLength = UInt32(data.count); packet.packetCount = 1
        packet.packetDescriptions?.pointee = AudioStreamPacketDescription(mStartOffset: 0, mVariableFramesInPacket: 480, mDataByteSize: UInt32(data.count))
        var supplied = false, error: NSError?
        let status = converter.convert(to: pcm, error: &error) { _, result in
            if supplied { result.pointee = .noDataNow; return nil }
            supplied = true; result.pointee = .haveData; return packet
        }
        guard error == nil, status != .error, pcm.frameLength > 0 else {
            decodeFailures += 1
            errors += 1; if errors >= 5 { self.converter = nil; errors = 0 }; return
        }
        decodedPackets += 1
        errors = 0
        if !reportedPlayback { reportedPlayback = true; iportalTrace("paired-audio-decoded", ["frames": pcm.frameLength]) }
        var scheduled = pcm
        if continuity.silence > 0,
           let padded = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: pcm.frameLength + AVAudioFrameCount(continuity.silence)),
           let destination = padded.floatChannelData, let source = pcm.floatChannelData {
            padded.frameLength = padded.frameCapacity
            for channel in 0..<Int(output.channelCount) {
                destination[channel].initialize(repeating: 0, count: continuity.silence)
                destination[channel].advanced(by: continuity.silence).update(from: source[channel], count: Int(pcm.frameLength))
            }
            scheduled = padded
        }
        let packetCount = max(1, Int(scheduled.frameLength) / 480)
        lock.lock(); let pending = queued; lock.unlock()
        if pending + packetCount > maximumPackets || (playing && pending == 0) {
            // Recover a real underrun or excessive backlog as one discontinuity,
            // rather than repeatedly dropping individual chunks of live audio.
            lock.lock(); queueGeneration &+= 1; queued = 0; lock.unlock()
            player.stop(); playing = false; rebufferings += 1
            if pending >= maximumPackets { droppedPackets += pending }
        }
        lock.lock(); queued += packetCount; let generation = queueGeneration
        let pendingAfterAppend = queued; maximumQueue = max(maximumQueue, queued); lock.unlock()
        lock.lock(); let currentVolume = volume; lock.unlock(); player.volume = currentVolume
        rateUnit.rate = drift.rate(pendingPackets: pendingAfterAppend)
        if !engine.isRunning {
            do { if !graphConnected { try connectGraph() }; try engine.start() }
            catch { outputFailed(); return }
        }
        // Bound pending render work, not hardware latency. dataPlayedBack also
        // includes the output device's delay (notably Bluetooth); using it for
        // a small cap drops valid packets while the renderer needs more audio.
        player.scheduleBuffer(scheduled, completionCallbackType: .dataConsumed) { [weak self] _ in
            guard let self else { return }; self.lock.lock()
            if self.queueGeneration == generation { self.queued = max(0, self.queued - packetCount) }
            self.lock.unlock()
        }
        if !playing && pendingAfterAppend >= primePackets {
            do { try startNativeAudioPlayer(player); playing = true }
            catch { outputFailed() }
        }
    }
    private func outputFailed() {
        // Output failures are audio-local. Retire old completion callbacks and
        // re-prime fresh packets after a bounded retry; never replay stale audio.
        lock.lock(); queueGeneration &+= 1; queued = 0; lock.unlock()
        player.stop(); engine.stop(); playing = false; converter = nil
        clock = AudioPacketClock(); drift = AudioDriftControl()
        outputFailures += 1
        nextOutputAttemptAt = ProcessInfo.processInfo.systemUptime + 1
        iportalTrace("paired-audio-output-retry", ["failures": outputFailures])
    }
    private func configurationChanged() {
        guard !isStopped else { return }
        // An output format change stops/uninitializes AVAudioEngine while
        // leaving node connections in their previous formats. Retire their
        // callbacks before reconnecting, then prime fresh audio on the next
        // packet. Never restart capture or replay the old device's queued sound.
        lock.lock(); queueGeneration &+= 1; queued = 0; lock.unlock()
        player.stop(); engine.stop(); playing = false; converter = nil
        clock = AudioPacketClock(); drift = AudioDriftControl()
        engine.disconnectNodeOutput(player)
        engine.disconnectNodeOutput(rateUnit)
        do { try connectGraph() }
        catch { outputFailed(); return }
        rebufferings += 1
        nextOutputAttemptAt = 0
        iportalTrace("paired-audio-output-changed", ["sampleRate": engine.outputNode.outputFormat(forBus: 0).sampleRate])
    }
    func stop() {
        lock.lock()
        guard !stopped else { lock.unlock(); return }
        stopped = true; queueGeneration &+= 1; queued = 0
        lock.unlock()
        work.async { [self] in player.stop(); engine.stop(); converter = nil }
    }
}
