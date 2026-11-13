// Captures the USB-connected iPhone's screen and audio the way QuickTime does: once "screen capture devices"
// are allowed, macOS exposes the iPhone as an AVCaptureDevice with a hardware-decoded 60 fps stream.
// That's much smoother and lower-latency than the helper's JPEG screenshots.
@preconcurrency import AVFoundation
import CoreMediaIO
import Cocoa
import CoreImage

// BEGIN TESTABLE CAPTURE EXECUTOR
// Cancellation is visible immediately, even while AVFoundation is blocked in
// startRunning(). Each capture source has a queue: replacement capture must not
// configure the same source until its predecessor stops, but other devices run independently.
final class CaptureLifetime: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false

    var isCancelled: Bool {
        lock.lock(); defer { lock.unlock() }
        return cancelled
    }

    func cancel() {
        lock.lock(); cancelled = true; lock.unlock()
    }
}

enum CaptureSessionExecutor {
    private static let lock = NSLock()
    private static var queues: [String: DispatchQueue] = [:]
    private static func queue(for key: String) -> DispatchQueue {
        lock.lock(); defer { lock.unlock() }
        if let queue = queues[key] { return queue }
        let queue = DispatchQueue(label: "iportal.capture-\(key)", qos: .userInitiated)
        queues[key] = queue
        return queue
    }

    static func start(_ lifetime: CaptureLifetime, key: String = "default", operation: @escaping @Sendable () -> Bool,
                      completion: @escaping @Sendable (Bool) -> Void) {
        queue(for: key).async {
            guard !lifetime.isCancelled else { return }
            let started = operation()
            guard !lifetime.isCancelled else { return }
            completion(started)
        }
    }

    static func update(_ lifetime: CaptureLifetime, key: String, operation: @escaping @Sendable () -> Void) {
        queue(for: key).async {
            guard !lifetime.isCancelled else { return }
            operation()
        }
    }

    static func stop(_ lifetime: CaptureLifetime, key: String = "default", teardown: @escaping @Sendable () -> Void) {
        lifetime.cancel()
        queue(for: key).async(execute: teardown)
    }
}
// END TESTABLE CAPTURE EXECUTOR

// BEGIN TESTABLE PRESENTATION POLICY
// FrameStore keeps the newest sample until this gate permits taking it. Waiting
// for renderer capacity must never consume the last update of an idle screen.
struct CapturePresentationGate {
    enum Action: Equatable { case present, wait(UInt64), flush(UInt64), fail, none }
    private var waiting: UInt64?
    private var readinessGeneration: UInt64 = 0
    private var stopped = false
    private var flushing: UInt64?
    private var generation: UInt64 = 0
    private var recoveries = 0

    mutating func next(ready: Bool, requiresFlush: Bool, failed: Bool, hasFrame: Bool) -> Action {
        guard !stopped, flushing == nil else { return .none }
        if requiresFlush || failed {
            waiting = nil
            // Repeated decoder failure needs a fresh capture, not an unbounded
            // flush loop. The owner already has bounded capture recovery.
            guard recoveries < 2 else { stopped = true; return .fail }
            recoveries += 1
            generation &+= 1
            flushing = generation
            return .flush(generation)
        }
        guard hasFrame else { waiting = nil; return .none }
        if ready { waiting = nil; return .present }
        guard waiting == nil else { return .none }
        readinessGeneration &+= 1
        waiting = readinessGeneration
        return .wait(readinessGeneration)
    }

    mutating func rendererCallback(_ token: UInt64) -> Bool {
        guard !stopped, flushing == nil, waiting == token else { return false }
        waiting = nil
        return true
    }

    mutating func flushed(_ token: UInt64) -> Bool {
        guard !stopped, flushing == token else { return false }
        flushing = nil
        return true
    }

    mutating func flushTimedOut(_ token: UInt64) -> Bool {
        guard !stopped, flushing == token else { return false }
        stop()
        return true
    }

    mutating func stop() {
        stopped = true; waiting = nil; flushing = nil; generation &+= 1
    }
}

enum CapturePixelFormat {
    // Advertised output support does not establish the source's color space.
    // Native YUV is opt-in for confirmed eight-bit SDR; unknown/deep/HDR input
    // retains the established BGRA path consistently with paired-media decode.
    static func preferred(available: [OSType], source: OSType,
                          bitsPerComponent: Int? = nil, transferFunction: String? = nil) -> OSType? {
        let yuv = [kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                   kCVPixelFormatType_420YpCbCr8BiPlanarFullRange]
        let bgra = kCVPixelFormatType_32BGRA
        if source == bgra, available.contains(bgra) { return bgra }
        let depth = bitsPerComponent ?? ((yuv + [bgra]).contains(source) ? 8 : nil)
        let sdr = transferFunction.map {
            [kCVImageBufferTransferFunction_ITU_R_709_2 as String,
             kCVImageBufferTransferFunction_sRGB as String].contains($0)
        } ?? false
        if depth == 8, sdr {
            if yuv.contains(source), available.contains(source) { return source }
            if let value = yuv.first(where: available.contains) { return value }
        }
        return available.contains(kCVPixelFormatType_32BGRA) ? kCVPixelFormatType_32BGRA : nil
    }
}
// END TESTABLE PRESENTATION POLICY

// Retain only the newest frame. Presentation and its geometry consume the same
// sample; a busy main queue drops superseded frames instead of adding latency.
// BEGIN TESTABLE FRAME STORE
struct CapturedFrame {
    let sample: CMSampleBuffer
    let size: CGSize
    let timestamp: TimeInterval

    func immediateSample() -> CMSampleBuffer? {
        var copy: CMSampleBuffer?
        guard CMSampleBufferCreateCopy(allocator: nil, sampleBuffer: sample, sampleBufferOut: &copy) == noErr,
              let copy, let attachments = CMSampleBufferGetSampleAttachmentsArray(copy, createIfNecessary: true) else { return nil }
        let values = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
        CFDictionarySetValue(values, Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
                             Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
        return copy
    }
}

final class FrameStore: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let lifetime: CaptureLifetime
    private var pixel: CVPixelBuffer?
    private var latest: CapturedFrame?
    private var pending = false
    private var notification: (@Sendable () -> Void)?

    init(lifetime: CaptureLifetime) { self.lifetime = lifetime }

    func observeFrames(_ callback: @escaping @Sendable () -> Void) {
        lock.lock(); notification = callback; lock.unlock()
    }

    func takeFrame() -> CapturedFrame? {
        lock.lock(); defer { lock.unlock() }
        pending = false
        defer { latest = nil }
        return lifetime.isCancelled ? nil : latest
    }

    var hasPendingFrame: Bool {
        lock.lock(); defer { lock.unlock() }
        return !lifetime.isCancelled && latest != nil
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer, from connection: AVCaptureConnection) {
        consume(sample)
    }

    func consume(_ sample: CMSampleBuffer) {
        guard !lifetime.isCancelled, CMSampleBufferIsValid(sample), CMSampleBufferDataIsReady(sample),
              let pixel = CMSampleBufferGetImageBuffer(sample) else { return }
        let dimensions: CGSize
        if let format = CMSampleBufferGetFormatDescription(sample) {
            dimensions = CMVideoFormatDescriptionGetPresentationDimensions(format, usePixelAspectRatio: true, useCleanAperture: true)
        } else {
            dimensions = CGSize(width: CVPixelBufferGetWidth(pixel), height: CVPixelBufferGetHeight(pixel))
        }
        guard dimensions.width > 0, dimensions.height > 0 else { return }
        lock.lock()
        var callback: (@Sendable () -> Void)?
        if !lifetime.isCancelled {
            self.pixel = pixel
            latest = CapturedFrame(sample: sample, size: dimensions, timestamp: ProcessInfo.processInfo.systemUptime)
            if !pending {
                pending = true
                callback = notification
            }
        }
        lock.unlock()
        callback?()
    }

    func clear() {
        lock.lock(); pixel = nil; latest = nil; pending = false; lock.unlock()
    }

    func snapshot() -> NSImage? {
        lock.lock(); let pixel = self.pixel; lock.unlock()
        guard let pixel else { return nil }
        let image = CIImage(cvPixelBuffer: pixel)
        guard let cg = CIContext().createCGImage(image, from: image.extent) else { return nil }
        return NSImage(cgImage: cg, size: .zero)
    }
}
// END TESTABLE FRAME STORE

@MainActor
final class PhoneCapture {
    private static var claims: [String: UUID] = [:]
    private let claimID = UUID()
    private var sourceID: String?
    var connectedDevices: () -> [IPortalUSBDevice] = { [] }
    let session = AVCaptureSession()
    let layer: AVSampleBufferDisplayLayer
    private let audio = AVCaptureAudioPreviewOutput()
    private var nativeMedia: NativeMediaReceiver?
    var usesPairedMedia: Bool { nativeMedia != nil }
    var onMediaCapabilities: ((PairedCapabilities) -> Void)?
    private var audioEnabled = false
    private var preferredVolume: Float = 1
    var onSize: ((CGSize) -> Void)?
    var onFailure: (() -> Void)?
    var onFrame: (() -> Void)?
    var onPresented: ((CVPixelBuffer) -> Void)?
    private var discoveryRetry: DispatchWorkItem?
    private var observers: [NSObjectProtocol] = []
    private let lifetime = CaptureLifetime()
    private let frames: FrameStore
    private let video = AVCaptureVideoDataOutput()
    private let frameQueue = DispatchQueue(label: "iportal.capture-frames", qos: .userInitiated)
    private var completion: (@MainActor (Bool) -> Void)?
    private var started = false
    private var configuring = false
    private var stopped = false
    private var failureReported = false
    private(set) var startupTimeoutAt: TimeInterval? = nil
    private(set) var lastFrameAt: TimeInterval = 0
    private(set) var idleConfirmedAt: TimeInterval = 0
    private var presentedRTPTime: UInt32?
    private var presentedSize = CGSize.zero
    private var enqueuedFrames = 0
    private var presentation = CapturePresentationGate()
    private var rendererRecoveryDeadline: DispatchWorkItem?
    private var metricsPending = false
    private var nextMetricsAt: TimeInterval = 0
    private var waitingForFreshFrame = false
    func snapshot() -> NSImage? { frames.snapshot() }
    func setOrientation(_ value: String) { nativeMedia?.setOrientation(value) }
    func setDisplayPixels(_ value: CGSize) { nativeMedia?.setDisplayPixels(value) }
    func awaitFreshFrame() { waitingForFreshFrame = true }
    private var deviceUDID = ""
    private var allowSingleDeviceFallback = false
    private(set) var identityAmbiguous = false
    func updateIdentityPolicy(singleUSB: Bool) { allowSingleDeviceFallback = singleUSB }

    init(audioVolume: Float = 1) {
        frames = FrameStore(lifetime: lifetime)
        layer = AVSampleBufferDisplayLayer()
        layer.videoGravity = .resizeAspect
        preferredVolume = min(1, max(0, audioVolume))
        audio.volume = 0
        frames.observeFrames { [weak self] in
            DispatchQueue.main.async {
                self?.drainPresentation()
            }
        }
        let renderer = layer.sampleBufferRenderer
        observe(AVSampleBufferVideoRenderer.requiresFlushToResumeDecodingDidChangeNotification, object: renderer) { [weak self] in
            self?.drainPresentation()
        }
        observe(AVSampleBufferVideoRenderer.didFailToDecodeNotification, object: renderer) { [weak self] in
            self?.drainPresentation()
        }
    }

    private func drainPresentation() {
        guard !stopped else { return }
        let renderer = layer.sampleBufferRenderer
        let action = presentation.next(ready: renderer.isReadyForMoreMediaData,
            requiresFlush: renderer.requiresFlushToResumeDecoding, failed: renderer.status == .failed,
            hasFrame: frames.hasPendingFrame)
        switch action {
        case .none: return
        case .fail: renderer.stopRequestingMediaData(); failed(); return
        case .flush(let token):
            renderer.stopRequestingMediaData()
            iportalTrace("capture-renderer-flush", ["generation": token])
            let deadline = DispatchWorkItem { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, !self.stopped, self.presentation.flushTimedOut(token) else { return }
                    self.failed()
                }
            }
            rendererRecoveryDeadline = deadline
            DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: deadline)
            // Both capture paths deliver decoded pixel buffers, so recovery
            // needs no remote keyframe. Keep the previous image visible while
            // resetting local renderer state and retain pending fresh pixels.
            renderer.flush(removingDisplayedImage: false) { [weak self] in
                DispatchQueue.main.async {
                    guard let self, !self.stopped, self.presentation.flushed(token) else { return }
                    self.rendererRecoveryDeadline?.cancel(); self.rendererRecoveryDeadline = nil
                    self.drainPresentation()
                }
            }
            return
        case .wait(let token):
            renderer.requestMediaDataWhenReady(on: .main) { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, !self.stopped, self.presentation.rendererCallback(token) else { return }
                    self.layer.sampleBufferRenderer.stopRequestingMediaData()
                    self.drainPresentation()
                }
            }
            return
        case .present:
            renderer.stopRequestingMediaData()
        }
        guard let frame = frames.takeFrame(), let sample = frame.immediateSample() else { return }
        // Frame dimensions and pixels advance in one transaction. A separate
        // AVCaptureVideoPreviewLayer can apply the new format to its old image.
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if frame.size != presentedSize {
            presentedSize = frame.size
            iportalTrace("capture-geometry", ["width": frame.size.width, "height": frame.size.height])
            onSize?(frame.size)
        }
        renderer.enqueue(sample)
        enqueuedFrames += 1
        CATransaction.commit()
        recordRendererMetrics(frame: frame)
        lastFrameAt = frame.timestamp
        if let pixel = CMSampleBufferGetImageBuffer(frame.sample) { onPresented?(pixel) }
        idleConfirmedAt = 0
        presentedRTPTime = usesPairedMedia ? UInt32(truncatingIfNeeded: CMSampleBufferGetPresentationTimeStamp(frame.sample).value) : nil
        if waitingForFreshFrame {
            waitingForFreshFrame = false
            onFrame?()
        }
    }

    private func recordRendererMetrics(frame: CapturedFrame) {
        let now = ProcessInfo.processInfo.systemUptime
        guard now >= nextMetricsAt, !metricsPending else { return }
        nextMetricsAt = now + 2
        iportalTrace("capture-enqueue", ["enqueuedFrames": enqueuedFrames,
            "queueAgeMs": max(0, now - frame.timestamp) * 1000,
            "pixelFormat": CVPixelBufferGetPixelFormatType(CMSampleBufferGetImageBuffer(frame.sample)!)])
        guard #available(macOS 14.4, *) else { return }
        metricsPending = true
        layer.sampleBufferRenderer.loadVideoPerformanceMetrics { [weak self] metrics in
            DispatchQueue.main.async {
                guard let self, !self.stopped else { return }
                self.metricsPending = false
                guard let metrics else { return }
                // These are renderer-reported cumulative counters, not an
                // end-to-end interaction measurement or an enqueue receipt.
                iportalTrace("capture-renderer-metrics", ["totalFrames": metrics.totalNumberOfFrames,
                    "droppedFrames": metrics.numberOfDroppedFrames,
                    "corruptedFrames": metrics.numberOfCorruptedFrames,
                    "accumulatedFrameDelayMs": metrics.totalAccumulatedFrameDelay * 1000])
            }
        }
    }

    /// Calls done(true) once video is running, or done(false) if access is denied or no iPhone shows up.
    /// `media` is a session server's framed media stream (Android); it takes the paired path without the transport.
    func start(udid: String, singleUsbDevice: Bool, timeout: TimeInterval = 8, paired: Bool = false, media: URL? = nil,
               _ done: @escaping @MainActor (Bool) -> Void) {
        guard !started, !stopped else { return done(false) }
        iportalTrace("capture-start-entered")
        started = true
        completion = done
        deviceUDID = udid
        allowSingleDeviceFallback = singleUsbDevice
        if paired, media != nil || NativeMediaReceiver.available {
            startupTimeoutAt = ProcessInfo.processInfo.systemUptime + timeout
            // Resolve this public macOS 26 getter at runtime so builds using
            // older SDKs retain the renderer's recommendations on newer Macs.
            let renderer = layer.sampleBufferRenderer
            let recommendation = NSSelectorFromString("recommendedPixelBufferAttributes")
            let attributes = renderer.responds(to: recommendation)
                ? renderer.perform(recommendation)?.takeUnretainedValue() as? [String: Any] ?? [:]
                : [:]
            let receiver = NativeMediaReceiver(lifetime: lifetime, frames: frames, pixelBufferAttributes: attributes, capabilities: { [weak self] capabilities in
                DispatchQueue.main.async { guard let self, !self.stopped else { return }; self.onMediaCapabilities?(capabilities) }
            }, unchanged: { [weak self] time in
                DispatchQueue.main.async {
                    guard let self, !self.stopped, self.presentedRTPTime == time else { return }
                    self.idleConfirmedAt = ProcessInfo.processInfo.systemUptime
                }
            }) { [weak self] in
                DispatchQueue.main.async { self?.failed() }
            }
            nativeMedia = receiver
            receiver.setVolume(preferredVolume)
            if let media { receiver.start(url: media, device: udid); finish(true) }
            else { do { try receiver.start(udid: udid); finish(true) } catch { finish(false) } }
            return
        }
        var prop = CMIOObjectPropertyAddress(
            mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices),
            mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
            mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
        var allow: UInt32 = 1
        CMIOObjectSetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &prop, 0, nil, UInt32(MemoryLayout<UInt32>.size), &allow)
        iportalTrace("capture-devices-enabled")

        Task { @MainActor [weak self] in
            let authorization = await CapturePermissions.shared.request(.camera)
            guard let self, !self.stopped else { return }
            self.startupTimeoutAt = ProcessInfo.processInfo.systemUptime + 10
            guard authorization == .authorized else { return self.finish(false) }
            self.setAudioEnabled(CapturePermissions.shared.snapshot.canPlayAudio)
            let deadline = ProcessInfo.processInfo.systemUptime + timeout
            self.observe(AVCaptureDevice.wasConnectedNotification, object: nil) { [weak self] in
                self?.waitForDevice(until: deadline)
            }
            self.waitForDevice(until: deadline)
            // Audio is optional. Its prompt must not hold up video, and closing
            // the window while camera permission was pending must not ask again.
            if self.preferredVolume > 0, CapturePermissions.shared.snapshot.microphone == .notDetermined {
                Task { @MainActor [weak self] in
                    guard let self, !self.stopped else { return }
                    await CapturePermissions.shared.request(.microphone)
                }
            }
        }
    }

    func setVolume(_ volume: Float) {
        preferredVolume = min(1, max(0, volume))
        audio.volume = audioEnabled ? preferredVolume : 0
        nativeMedia?.setVolume(preferredVolume)
    }

    func setAudioEnabled(_ enabled: Bool) {
        guard enabled != audioEnabled else { return }
        audioEnabled = enabled
        audio.volume = enabled ? preferredVolume : 0
        guard configuring, let sourceID else { return }
        let session = self.session, audio = self.audio
        CaptureSessionExecutor.update(lifetime, key: sourceID) {
            session.beginConfiguration()
            if enabled {
                if !session.outputs.contains(where: { $0 === audio }), session.canAddOutput(audio) { session.addOutput(audio) }
            } else if session.outputs.contains(where: { $0 === audio }) { session.removeOutput(audio) }
            session.commitConfiguration()
        }
    }

    func stop() {
        guard !stopped else { return }
        stopped = true
        presentation.stop()
        rendererRecoveryDeadline?.cancel(); rendererRecoveryDeadline = nil
        lifetime.cancel()
        nativeMedia?.stop()
        nativeMedia = nil
        layer.sampleBufferRenderer.stopRequestingMediaData()
        layer.sampleBufferRenderer.flush()
        discoveryRetry?.cancel()
        completion = nil
        observers.forEach(NotificationCenter.default.removeObserver)
        observers.removeAll()
        let session = self.session
        let video = self.video
        let frames = self.frames
        if let sourceID, Self.claims[sourceID] == claimID { Self.claims.removeValue(forKey: sourceID) }
        CaptureSessionExecutor.stop(lifetime, key: sourceID ?? deviceUDID) {
            video.setSampleBufferDelegate(nil, queue: nil)
            session.stopRunning()
            session.beginConfiguration()
            session.inputs.forEach(session.removeInput)
            session.outputs.forEach(session.removeOutput)
            session.commitConfiguration()
            frames.clear()
            iportalTrace("capture-stopped")
        }
    }

    private func finish(_ ok: Bool) {
        guard !stopped else { return }
        iportalTrace("capture-completion", ["ok": ok])
        let callback = completion
        completion = nil
        callback?(ok)
    }

    private func failed() {
        guard !stopped, !failureReported else { return }
        failureReported = true
        if completion != nil { finish(false) }
        else { onFailure?() }
    }

    private func findDevice() -> AVCaptureDevice? {
        let devices = AVCaptureDevice.DiscoverySession(deviceTypes: [.external], mediaType: .muxed, position: .unspecified).devices
        let connected = connectedDevices()
        let identity = captureSourceID(for: deviceUDID, devices: connected, sources: devices.map {
            CaptureSourceIdentity(id: $0.uniqueID, isIOS: $0.modelID == "iOS Device")
        }, singleUSB: allowSingleDeviceFallback)
        identityAmbiguous = identity == nil && connected.count > 1 && devices.contains { $0.modelID == "iOS Device" }
        guard let identity, Self.claims[identity] == nil || Self.claims[identity] == claimID else { return nil }
        return devices.first { $0.uniqueID == identity }
    }

    // The device appears a second or two after screen capture devices are allowed.
    private func waitForDevice(until deadline: TimeInterval) {
        guard !stopped, !configuring else { return }
        discoveryRetry?.cancel()
        if let device = findDevice() {
            sourceID = device.uniqueID
            Self.claims[device.uniqueID] = claimID
            configuring = true
            iportalTrace("capture-device-available")
            return run(device)
        }
        if identityAmbiguous { return finish(false) }
        if ProcessInfo.processInfo.systemUptime > deadline { return finish(false) }
        let retry = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.waitForDevice(until: deadline) }
        }
        discoveryRetry = retry
        DispatchQueue.main.asyncAfter(deadline: .now() + 1, execute: retry)
    }

    private func run(_ device: AVCaptureDevice) {
        observe(AVCaptureSession.runtimeErrorNotification, object: session) { [weak self] in self?.failed() }
        observe(AVCaptureSession.wasInterruptedNotification, object: session) { [weak self] in self?.failed() }
        observe(AVCaptureDevice.wasDisconnectedNotification, object: device) { [weak self] in self?.failed() }
        let session = self.session
        let video = self.video
        let audio = self.audio
        let frames = self.frames
        let frameQueue = self.frameQueue
        let withAudio = audioEnabled
        CaptureSessionExecutor.start(lifetime, key: device.uniqueID, operation: {
            iportalTrace("capture-configure")
            guard let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else { return false }
            session.beginConfiguration()
            session.addInput(input)
            video.alwaysDiscardsLateVideoFrames = true
            guard session.canAddOutput(video) else { session.commitConfiguration(); return false }
            video.setSampleBufferDelegate(frames, queue: frameQueue)
            session.addOutput(video)
            // The available formats depend on the connected input's active
            // format, so negotiate after adding the output to this session.
            let description = device.activeFormat.formatDescription
            let source = CMFormatDescriptionGetMediaSubType(description)
            let depth = (CMFormatDescriptionGetExtension(description, extensionKey: kCMFormatDescriptionExtension_BitsPerComponent) as? NSNumber)?.intValue
            let transfer = CMFormatDescriptionGetExtension(description, extensionKey: kCMFormatDescriptionExtension_TransferFunction) as? String
            if let pixelFormat = CapturePixelFormat.preferred(available: video.availableVideoPixelFormatTypes,
                source: source, bitsPerComponent: depth, transferFunction: transfer) {
                video.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: pixelFormat]
                iportalTrace("capture-pixel-format", ["source": source, "output": pixelFormat,
                    "sourceBits": depth ?? 0, "sourceTransfer": transfer ?? "unknown"])
            } else {
                // nil requests the supported uncompressed default. An empty
                // dictionary requests native samples, which may be compressed
                // and cannot enter FrameStore's decoded-image contract.
                video.videoSettings = nil
            }
            if withAudio, session.canAddOutput(audio) { session.addOutput(audio) }
            session.commitConfiguration()
            session.startRunning() // blocks until the stream is up
            iportalTrace("capture-start-returned")
            return session.isRunning
        }, completion: { [weak self] ok in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self, !self.stopped else { return }
                    self.finish(ok)
                }
            }
        })
    }

    private func observe(_ name: Notification.Name, object: Any?, action: @escaping @MainActor () -> Void) {
        observers.append(NotificationCenter.default.addObserver(forName: name, object: object, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, !self.stopped else { return }
                action()
            }
        })
    }

}
