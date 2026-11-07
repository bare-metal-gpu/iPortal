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
