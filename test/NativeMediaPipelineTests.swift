// Appended to the production source by test-native-media.mjs. No phone, process,
// window, microphone, or audio playback is involved in this hardware codec test.
extension NativeMediaReceiver {
    func testConfigure(_ data: Data) throws { try configure(data) }
    func testDecode(_ data: Data, sync: Bool, time: UInt32) throws { try decode(data, sync: sync, time: time) }
    func testRetireDecoder() { resetDecoder() }
}

final class EncodedMediaSamples: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [CMSampleBuffer] = []
    private var errors: [OSStatus] = []
    func add(status: OSStatus, sample: CMSampleBuffer?) {
        lock.lock(); defer { lock.unlock() }
        if status == noErr, let sample { values.append(sample) } else { errors.append(status) }
    }
    var samples: [CMSampleBuffer] {
        lock.lock(); defer { lock.unlock() }
        precondition(errors.isEmpty, "Synthetic HEVC encoding failed")
        return values.sorted { CMSampleBufferGetPresentationTimeStamp($0) < CMSampleBufferGetPresentationTimeStamp($1) }
    }
}

func nativeMediaCodecRoundtrip() throws {
    var candidate: VTCompressionSession?
    precondition(VTCompressionSessionCreate(allocator: nil, width: 64, height: 96,
        codecType: kCMVideoCodecType_HEVC, encoderSpecification: nil,
        imageBufferAttributes: nil, compressedDataAllocator: nil, outputCallback: nil,
        refcon: nil, compressionSessionOut: &candidate) == noErr)
    let encoder = candidate!
    defer { VTCompressionSessionInvalidate(encoder) }
    precondition(VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue) == noErr)
    precondition(VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse) == noErr)
    precondition(VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: 60 as CFNumber) == noErr)
    precondition(VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_ColorPrimaries, value: kCVImageBufferColorPrimaries_ITU_R_709_2) == noErr)
    precondition(VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_TransferFunction, value: kCVImageBufferTransferFunction_sRGB) == noErr)
    precondition(VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_YCbCrMatrix, value: kCVImageBufferYCbCrMatrix_ITU_R_709_2) == noErr)
    let encoded = EncodedMediaSamples()
    for index in 0..<30 {
        var createdImage: CVPixelBuffer?
        precondition(CVPixelBufferCreate(nil, 64, 96, kCVPixelFormatType_32BGRA,
            [kCVPixelBufferIOSurfacePropertiesKey as String: [:]] as CFDictionary, &createdImage) == kCVReturnSuccess)
        let image = createdImage!
        CVBufferSetAttachment(image, kCVImageBufferCGColorSpaceKey, CGColorSpace(name: CGColorSpace.sRGB)!, .shouldPropagate)
        CVPixelBufferLockBaseAddress(image, [])
        let bytes = CVPixelBufferGetBaseAddress(image)!.assumingMemoryBound(to: UInt8.self)
        let stride = CVPixelBufferGetBytesPerRow(image)
        for y in 0..<96 { for x in 0..<64 {
            let offset = y * stride + x * 4
            bytes[offset] = 120; bytes[offset + 1] = 80
            bytes[offset + 2] = UInt8(index * 7); bytes[offset + 3] = 255
        }}
        CVPixelBufferUnlockBaseAddress(image, [])
        precondition(VTCompressionSessionEncodeFrame(encoder, imageBuffer: image,
            presentationTimeStamp: CMTime(value: Int64(index), timescale: 60),
            duration: CMTime(value: 1, timescale: 60), frameProperties: nil,
            infoFlagsOut: nil) { status, _, sample in encoded.add(status: status, sample: sample) } == noErr)
    }
    precondition(VTCompressionSessionCompleteFrames(encoder, untilPresentationTimeStamp: .invalid) == noErr)
    let samples = encoded.samples
    precondition(samples.count == 30)
    let description = CMSampleBufferGetFormatDescription(samples[0])!
    var configuration = Data()
    for index in 0..<3 {
        var pointer: UnsafePointer<UInt8>?, size = 0, count = 0, length: Int32 = 0
        precondition(CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(description,
            parameterSetIndex: index, parameterSetPointerOut: &pointer,
            parameterSetSizeOut: &size, parameterSetCountOut: &count,
            nalUnitHeaderLengthOut: &length) == noErr)
        var sizeBytes = UInt32(size).bigEndian
        withUnsafeBytes(of: &sizeBytes) { configuration.append(contentsOf: $0) }
        configuration.append(pointer!, count: size)
    }
    let lifetime = CaptureLifetime(), frames = FrameStore()
    let receiver = NativeMediaReceiver(lifetime: lifetime, frames: frames,
        capabilities: { _ in }, unchanged: { _ in }, failed: { preconditionFailure("Synthetic HEVC decoding failed") })
    try receiver.testConfigure(configuration)
    for (index, sample) in samples.enumerated() {
        let block = CMSampleBufferGetDataBuffer(sample)!
        var bytes = Data(count: CMBlockBufferGetDataLength(block))
        precondition(bytes.withUnsafeMutableBytes {
            CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: $0.count, destination: $0.baseAddress!)
        } == noErr)
        try receiver.testDecode(bytes, sync: index == 0, time: UInt32(index * 1500))
    }
    let deadline = Date(timeIntervalSinceNow: 5)
    while frames.samples.last.map({ CMSampleBufferGetPresentationTimeStamp($0).value }) != 29 * 1500, Date() < deadline {
        Thread.sleep(forTimeInterval: 0.005)
    }
    let decoded = frames.samples
    precondition(!decoded.isEmpty)
    precondition(CMSampleBufferGetPresentationTimeStamp(decoded.last!).value == 29 * 1500,
        "The final frame must survive asynchronous decode")
    for pair in zip(decoded, decoded.dropFirst()) {
        precondition(CMSampleBufferGetPresentationTimeStamp(pair.0) < CMSampleBufferGetPresentationTimeStamp(pair.1))
    }
    let pixel = CMSampleBufferGetImageBuffer(decoded.last!)!
    precondition(CVPixelBufferGetWidth(pixel) == 64 && CVPixelBufferGetHeight(pixel) == 96)
    // Compare the final decoded color rather than assuming successful callback
    // delivery proves correct pixels. The encoder is lossy, so allow 8 levels.
    var rgba = [UInt8](repeating: 0, count: 4)
    rgba.withUnsafeMutableBytes {
        CIContext().render(CIImage(cvPixelBuffer: pixel), toBitmap: $0.baseAddress!, rowBytes: 4,
            bounds: CGRect(x: 32, y: 48, width: 1, height: 1), format: .RGBA8,
            colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
    }
    precondition(abs(Int(rgba[0]) - 203) <= 8 && abs(Int(rgba[1]) - 80) <= 8 && abs(Int(rgba[2]) - 120) <= 8,
        "Native YUV decode must preserve color: \(rgba)")
    let rotator = NativeMediaRotation()
    for (orientation, width, height) in [
        ("PORTRAIT", 62, 94), ("LANDSCAPE", 94, 62),
        ("UIA_DEVICE_ORIENTATION_LANDSCAPERIGHT", 94, 62),
        ("UIA_DEVICE_ORIENTATION_PORTRAIT_UPSIDEDOWN", 62, 94),
    ] {
        rotator.setOrientation(orientation)
        let transformed = rotator.apply(pixel, aperture: CGRect(x: 0, y: 2, width: 62, height: 94))!
        precondition(CVPixelBufferGetWidth(transformed) == width && CVPixelBufferGetHeight(transformed) == height)
        var color = [UInt8](repeating: 0, count: 4)
        color.withUnsafeMutableBytes {
            CIContext().render(CIImage(cvPixelBuffer: transformed), toBitmap: $0.baseAddress!, rowBytes: 4,
                bounds: CGRect(x: width / 2, y: height / 2, width: 1, height: 1), format: .RGBA8,
                colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
        }
        precondition(zip(color, rgba).allSatisfy { abs(Int($0.0) - Int($0.1)) <= 2 },
            "YUV crop/rotation cannot alter colors: \(orientation), \(color), expected \(rgba)")
    }
    // This real codec run has drained. Pending/out-of-order cancellation is
    // exercised separately by the ownership barrier tests in the harness.
    lifetime.cancel()
    receiver.testRetireDecoder()
    receiver.stop()
    let count = frames.samples.count
    Thread.sleep(forTimeInterval: 0.03)
    precondition(frames.samples.count == count, "Cancelled decoder cannot deliver late output")
    print("Native media: 30-frame HEVC roundtrip preserved final pixels, YUV crop/rotation colors, callback order and drained teardown (pixel format \(CVPixelBufferGetPixelFormatType(pixel))).")
}

try nativeMediaCodecRoundtrip()

// An Android helper's stream: the same records over HTTP, with H.264 parameter
// sets (kind 10) where the phone has no hardware HEVC encoder, uncompressed
// sound (kind 9), and its own "screen unchanged" and capability records.
extension NativeMediaReceiver {
    func testIngest(_ data: Data) -> Bool { ingest(data) }
}

final class HelperStreamEvents: @unchecked Sendable {
    private let lock = NSLock()
    private var unchangedTimes: [UInt32] = []
    private var negotiated: [PairedCapabilities] = []
    func unchanged(_ time: UInt32) { lock.lock(); unchangedTimes.append(time); lock.unlock() }
    func capabilities(_ value: PairedCapabilities) { lock.lock(); negotiated.append(value); lock.unlock() }
    var times: [UInt32] { lock.lock(); defer { lock.unlock() }; return unchangedTimes }
    var audio: [String] { lock.lock(); defer { lock.unlock() }; return negotiated.map(\.audio) }
}

func helperMediaRecord(_ kind: UInt32, flags: UInt32 = 0, time: UInt32 = 0, _ body: Data = Data()) -> Data {
    var record = Data()
    for word in [kind, flags, time, UInt32(body.count)] {
        var value = word.bigEndian
        withUnsafeBytes(of: &value) { record.append(contentsOf: $0) }
    }
    record.append(body)
    return record
}

func helperMediaStreamRoundtrip() throws -> Data {
    var candidate: VTCompressionSession?
    precondition(VTCompressionSessionCreate(allocator: nil, width: 64, height: 96,
        codecType: kCMVideoCodecType_H264, encoderSpecification: nil,
        imageBufferAttributes: nil, compressedDataAllocator: nil, outputCallback: nil,
        refcon: nil, compressionSessionOut: &candidate) == noErr)
    let encoder = candidate!
    defer { VTCompressionSessionInvalidate(encoder) }
    precondition(VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue) == noErr)
    precondition(VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse) == noErr)
    let encoded = EncodedMediaSamples()
    for index in 0..<10 {
        var createdImage: CVPixelBuffer?
        precondition(CVPixelBufferCreate(nil, 64, 96, kCVPixelFormatType_32BGRA,
            [kCVPixelBufferIOSurfacePropertiesKey as String: [:]] as CFDictionary, &createdImage) == kCVReturnSuccess)
        let image = createdImage!
        CVPixelBufferLockBaseAddress(image, [])
        memset(CVPixelBufferGetBaseAddress(image)!, Int32(40 + index * 10), CVPixelBufferGetDataSize(image))
        CVPixelBufferUnlockBaseAddress(image, [])
        precondition(VTCompressionSessionEncodeFrame(encoder, imageBuffer: image,
            presentationTimeStamp: CMTime(value: Int64(index), timescale: 60),
            duration: CMTime(value: 1, timescale: 60), frameProperties: nil,
            infoFlagsOut: nil) { status, _, sample in encoded.add(status: status, sample: sample) } == noErr)
    }
    precondition(VTCompressionSessionCompleteFrames(encoder, untilPresentationTimeStamp: .invalid) == noErr)
    let samples = encoded.samples
    precondition(samples.count == 10)
    let description = CMSampleBufferGetFormatDescription(samples[0])!
    var parameters = Data()
    for index in 0..<2 {
        var pointer: UnsafePointer<UInt8>?, size = 0, count = 0, length: Int32 = 0
        precondition(CMVideoFormatDescriptionGetH264ParameterSetAtIndex(description,
            parameterSetIndex: index, parameterSetPointerOut: &pointer,
            parameterSetSizeOut: &size, parameterSetCountOut: &count,
            nalUnitHeaderLengthOut: &length) == noErr)
        precondition(count == 2 && length == 4)
        var sizeBytes = UInt32(size).bigEndian
        withUnsafeBytes(of: &sizeBytes) { parameters.append(contentsOf: $0) }
        parameters.append(pointer!, count: size)
    }
    var stream = helperMediaRecord(7, Data(#"{"control":"eligible","video":"supported","audio":"unavailable"}"#.utf8))
    stream.append(helperMediaRecord(10, parameters))
    for (index, sample) in samples.enumerated() {
        let block = CMSampleBufferGetDataBuffer(sample)!
        var bytes = Data(count: CMBlockBufferGetDataLength(block))
        precondition(bytes.withUnsafeMutableBytes {
            CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: $0.count, destination: $0.baseAddress!)
        } == noErr)
        stream.append(helperMediaRecord(1, flags: index == 0 ? 1 : 0, time: UInt32(index * 1500), bytes))
    }
    stream.append(helperMediaRecord(8, time: 9 * 1500))
    let lifetime = CaptureLifetime(), frames = FrameStore(), events = HelperStreamEvents()
    let failures = MediaTestEvents()
    let receiver = NativeMediaReceiver(lifetime: lifetime, frames: frames,
        capabilities: { events.capabilities($0) }, unchanged: { events.unchanged($0) },
        failed: { failures.record("failed") })
    // The network delivers records in arbitrary pieces.
    var offset = 0
    while offset < stream.count {
        let end = min(stream.count, offset + 7 + offset % 5)
        precondition(receiver.testIngest(stream.subdata(in: offset..<end)))
        offset = end
    }
    let deadline = Date(timeIntervalSinceNow: 5)
    while frames.samples.last.map({ CMSampleBufferGetPresentationTimeStamp($0).value }) != 9 * 1500, Date() < deadline {
        Thread.sleep(forTimeInterval: 0.005)
    }
    let decoded = frames.samples
    precondition(decoded.last.map { CMSampleBufferGetPresentationTimeStamp($0).value } == 9 * 1500,
        "The final H.264 frame must be decoded")
    let pixel = CMSampleBufferGetImageBuffer(decoded.last!)!
    precondition(CVPixelBufferGetWidth(pixel) == 64 && CVPixelBufferGetHeight(pixel) == 96)
    precondition(events.times == [9 * 1500], "The still-screen record names the frame it confirms")
    precondition(events.audio == ["unavailable"])
    precondition(failures.count("failed") == 0)
    precondition(!receiver.testIngest(helperMediaRecord(10, parameters.dropLast(1))), "Truncated parameter sets end the stream")
    precondition(failures.count("failed") == 1)
    precondition(!receiver.testIngest(helperMediaRecord(99)), "Unknown records end the stream")
    lifetime.cancel()
    receiver.testRetireDecoder()
    receiver.stop()
    print("Native media: a helper stream split across reads decodes H.264, confirms a still screen and reports capabilities.")
    return stream
}

// The same stream as the session server relays it: an HTTP response that
// never ends. Frames must reach the decoder while it is still open, and its
// end must be reported so the window can fall back.
func helperMediaOverHTTP(_ stream: Data) throws {
    let listener = try NWListener(using: .tcp, on: .any)
    let serving = DispatchQueue(label: "helper-media-test")
    let accepted = DispatchSemaphore(value: 0), ready = DispatchSemaphore(value: 0)
    final class Connection: @unchecked Sendable { var value: NWConnection? }
    let client = Connection()
    listener.stateUpdateHandler = { if case .ready = $0 { ready.signal() } }
    listener.newConnectionHandler = { connection in
        client.value = connection
        connection.start(queue: serving)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { _, _, _, _ in
            let head = "HTTP/1.1 200 OK\r\ncontent-type: application/octet-stream\r\nconnection: close\r\n\r\n"
            let cut = stream.count / 2
            connection.send(content: Data(head.utf8) + stream.prefix(cut), completion: .contentProcessed { _ in })
            serving.asyncAfter(deadline: .now() + 0.2) {
                connection.send(content: stream.suffix(from: cut), completion: .contentProcessed { _ in accepted.signal() })
            }
        }
    }
    listener.start(queue: serving)
    precondition(ready.wait(timeout: .now() + 3) == .success)
    let lifetime = CaptureLifetime(), frames = FrameStore(), events = HelperStreamEvents()
    let failures = MediaTestEvents()
    let receiver = NativeMediaReceiver(lifetime: lifetime, frames: frames,
        capabilities: { events.capabilities($0) }, unchanged: { events.unchanged($0) },
        failed: { failures.record("failed") })
    receiver.start(url: URL(string: "http://127.0.0.1:\(listener.port!.rawValue)/media")!, device: "synthetic-android")
    precondition(accepted.wait(timeout: .now() + 5) == .success)
    let deadline = Date(timeIntervalSinceNow: 5)
    while events.times.isEmpty || frames.samples.last.map({ CMSampleBufferGetPresentationTimeStamp($0).value }) != 9 * 1500, Date() < deadline {
        Thread.sleep(forTimeInterval: 0.005)
    }
    precondition(frames.samples.last.map { CMSampleBufferGetPresentationTimeStamp($0).value } == 9 * 1500,
        "Frames must be decoded while the response is still open")
    precondition(events.times == [9 * 1500] && failures.count("failed") == 0)
    // Android frames arrive as the phone shows them; the iPhone's rotation
    // must not be applied on top.
    receiver.setOrientation("LANDSCAPE")
    let landscape = Mirror(reflecting: receiver).children.first { $0.label == "rotation" }!.value as! NativeMediaRotation
    let unrotated = CMSampleBufferGetImageBuffer(frames.samples.last!)!
    precondition(landscape.apply(unrotated) === unrotated)
    client.value?.cancel()
    let ended = Date(timeIntervalSinceNow: 5)
    while failures.count("failed") == 0, Date() < ended { Thread.sleep(forTimeInterval: 0.005) }
    precondition(failures.count("failed") == 1, "The end of the helper's stream is a capture failure")
    listener.cancel()
    lifetime.cancel()
    receiver.stop()
    print("Native media: a helper stream over HTTP decodes while open, is not rotated again, and reports its end.")
}
try helperMediaOverHTTP(try helperMediaStreamRoundtrip())

let pcmFormat = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2)!
var pcmPacket = Data()
for frame in 0..<480 {
    // Left ramps up from silence, right holds full negative scale.
    for sample in [Int16(frame), Int16.min] {
        pcmPacket.append(UInt8(truncatingIfNeeded: sample)); pcmPacket.append(UInt8(truncatingIfNeeded: sample >> 8))
    }
}
let pcmBuffer = nativeAudioPCMBuffer(pcmPacket, format: pcmFormat)!
precondition(pcmBuffer.frameLength == 480)
precondition(pcmBuffer.floatChannelData![0][0] == 0 && pcmBuffer.floatChannelData![0][479] == 479.0 / 32768)
precondition(pcmBuffer.floatChannelData![1][0] == -1 && pcmBuffer.floatChannelData![1][479] == -1)
precondition(nativeAudioPCMBuffer(pcmPacket.dropLast(1), format: pcmFormat) == nil, "A torn sample frame is not audio")
precondition(nativeAudioPCMBuffer(Data(), format: pcmFormat) == nil)
precondition(nativeAudioPCMBuffer(Data(count: 4801 * 4), format: pcmFormat) == nil, "Oversized packets are refused")
print("Native audio: 16-bit little-endian stereo PCM packets convert exactly and malformed ones are refused.")
