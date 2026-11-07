import Cocoa
@preconcurrency import AVFoundation
import VideoToolbox

// BEGIN TESTABLE MEDIA INPUT
func readAvailableMediaBytes(_ handle: FileHandle) -> Data { handle.availableData }
// END TESTABLE MEDIA INPUT

// One process and decoder per physical device. The child owns only its paired
// CoreDevice session; malformed records, exit, or stale callbacks cannot migrate
// into a replacement capture. All queues are bounded by the OS pipe and decoder.
final class NativeMediaReceiver: @unchecked Sendable {
    private let queue = DispatchQueue(label: "iportal.native-media", qos: .userInteractive)
    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private let lifetime: CaptureLifetime
    private let frames: FrameStore
    private var decoder: VTDecompressionSession?
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

    init(lifetime: CaptureLifetime, frames: FrameStore, capabilities: @escaping @Sendable (PairedCapabilities) -> Void,
         unchanged: @escaping @Sendable (UInt32) -> Void, failed: @escaping @Sendable () -> Void) {
        self.lifetime = lifetime; self.frames = frames; self.failed = failed; self.capabilities = capabilities
        self.unchanged = unchanged
    }
    func start(udid: String) throws {
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
    func stop() {
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
        if let decoder { VTDecompressionSessionWaitForAsynchronousFrames(decoder); VTDecompressionSessionInvalidate(decoder) }
        decoder = nil; format = nil
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
        var session: VTDecompressionSession?
        let pixelOptions: [String: Any] = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                                         kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
        guard VTDecompressionSessionCreate(allocator: nil, formatDescription: description, decoderSpecification: nil,
                imageBufferAttributes: pixelOptions as CFDictionary, outputCallback: nil, decompressionSessionOut: &session) == noErr,
              let session else { throw CocoaError(.coderReadCorrupt) }
        VTSessionSetProperty(session, key: kVTDecompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        decoder = session
    }
    private func decode(_ data: Data, sync: Bool, time: UInt32) throws {
        guard let decoder, let format, !waitingForSync || sync else { return }
        waitingForSync = false
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
        // Synchronous decode on this dedicated queue bounds in-flight work to one.
        // Presentation independently retains only the newest decoded image.
        let status = VTDecompressionSessionDecodeFrame(decoder, sampleBuffer: sample, flags: [], infoFlagsOut: nil) { [frames, lifetime, rotation] status, _, pixel, time, duration in
            guard status == noErr, let pixel, !lifetime.isCancelled else { return }
            guard let pixel = rotation.apply(pixel) else { return }
            var format: CMVideoFormatDescription?, output: CMSampleBuffer?
            guard CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: pixel, formatDescriptionOut: &format) == noErr, let format else { return }
            var timing = CMSampleTimingInfo(duration: duration, presentationTimeStamp: time, decodeTimeStamp: .invalid)
            if CMSampleBufferCreateReadyWithImageBuffer(allocator: nil, imageBuffer: pixel, formatDescription: format, sampleTiming: &timing, sampleBufferOut: &output) == noErr, let output {
                frames.consume(output)
            }
        }
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
    private let context = CIContext(options: [.cacheIntermediates: false])
    private var pool: CVPixelBufferPool?
    private var poolSize = CGSize.zero
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
    func apply(_ pixel: CVPixelBuffer) -> CVPixelBuffer? {
        lock.lock(); let orientation = orientation; lock.unlock()
        guard orientation != .up else { return pixel }
        let image = CIImage(cvPixelBuffer: pixel).oriented(orientation)
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
// Runtime availability alone does not make a newer Swift overlay visible to
// older SDKs. Invoke the public Objective-C NSError API by its stable selector
// so an older-SDK build still gets recoverable errors on a newer macOS host.
func nativeAudioStartUsingErrorAPI(_ receiver: NSObject) throws -> Bool {
    let selector = NSSelectorFromString("playAndReturnError:")
    guard receiver.responds(to: selector) else { return false }
    guard let implementation = receiver.method(for: selector) else {
        throw CocoaError(.featureUnsupported)
    }
    typealias Start = @convention(c) (AnyObject, Selector, AutoreleasingUnsafeMutablePointer<NSError?>?) -> ObjCBool
    let start = unsafeBitCast(implementation, to: Start.self)
    var error: NSError?
    guard start(receiver, selector, &error).boolValue else {
        throw error ?? NSError(domain: "iPortal.Audio", code: 1,
                               userInfo: [NSLocalizedDescriptionKey: "Audio playback could not start"])
    }
    return true
}

func startNativeAudioPlayer(_ player: AVAudioPlayerNode) throws {
    if try nativeAudioStartUsingErrorAPI(player) { return }
    // Choose the legacy path only when the runtime lacks the error API.
    // A dispatched failure is propagated above and is never replayed via play().
    guard player.engine?.isRunning == true else { throw CocoaError(.featureUnsupported) }
    player.play()
}
// END TESTABLE AUDIO START

// Remote system audio needs no access to the Mac microphone. The existing mute
// control still governs playback. A small queue prevents stale audio catch-up.
private final class NativeMediaAudio {
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
    init() {
        engine.attach(player); engine.attach(rateUnit)
        engine.connect(player, to: rateUnit, format: output)
        engine.connect(rateUnit, to: engine.mainMixerNode, format: output)
    }
    func setVolume(_ volume: Float) { lock.lock(); self.volume = volume; lock.unlock() }
    func consume(_ data: Data, timestamp: UInt32) {
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
                    "maximumGapMs": maximumGap * 1000, "rebufferings": rebufferings, "outputFailures": outputFailures])
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
            do { try engine.start() }
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
    func stop() { player.stop(); engine.stop(); converter = nil }
}
