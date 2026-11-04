// Captures the USB-connected iPhone's screen and audio the way QuickTime does: once "screen capture devices"
// are allowed, macOS exposes the iPhone as an AVCaptureDevice with a hardware-decoded 60 fps stream.
// That's much smoother and lower-latency than WebDriverAgent's JPEG screenshots.
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
    private var audioEnabled = false
    private var preferredVolume: Float = 1
    var onSize: ((CGSize) -> Void)?
    var onFailure: (() -> Void)?
    var onFrame: (() -> Void)?
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
    private var presentedSize = CGSize.zero
    private var waitingForFreshFrame = false
    func snapshot() -> NSImage? { frames.snapshot() }
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
                guard let self, !self.stopped, let frame = self.frames.takeFrame() else { return }
                self.present(frame)
            }
        }
    }

    private func present(_ frame: CapturedFrame) {
        let renderer = layer.sampleBufferRenderer
        guard renderer.status != .failed else { failed(); return }
        guard renderer.isReadyForMoreMediaData, let sample = frame.immediateSample() else { return }
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
        CATransaction.commit()
        lastFrameAt = frame.timestamp
        if waitingForFreshFrame {
            waitingForFreshFrame = false
            onFrame?()
        }
    }

    /// Calls done(true) once video is running, or done(false) if access is denied or no iPhone shows up.
    func start(udid: String, singleUsbDevice: Bool, timeout: TimeInterval = 8, _ done: @escaping @MainActor (Bool) -> Void) {
        guard !started, !stopped else { return done(false) }
        iportalTrace("capture-start-entered")
        started = true
        completion = done
        deviceUDID = udid
        allowSingleDeviceFallback = singleUsbDevice
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
            video.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
            guard session.canAddOutput(video) else { session.commitConfiguration(); return false }
            video.setSampleBufferDelegate(frames, queue: frameQueue)
            session.addOutput(video)
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
