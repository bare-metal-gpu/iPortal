// Captures the USB-connected iPhone's screen and audio the way QuickTime does: once "screen capture devices"
// are allowed, macOS exposes the iPhone as an AVCaptureDevice with a hardware-decoded 60 fps stream.
// That's much smoother and lower-latency than WebDriverAgent's JPEG screenshots.
@preconcurrency import AVFoundation
import CoreMediaIO
import Cocoa
import CoreImage

// Opt-in developer trace. No screenshots, key contents, or typed text are saved.
// The serial writer keeps file I/O off the capture and UI queues; recording is bounded.
enum MirrorBenchmark {
    private static let destination = ProcessInfo.processInfo.environment["IPHONE_MIRROR_BENCHMARK_TRACE"]
    static let enabled = destination?.hasPrefix("/") == true
    private static let writer = DispatchQueue(label: "iphone-portal.benchmark")
    private static var bytes = 0
    private static var handle: FileHandle? = {
        guard enabled, let destination else { return nil }
        guard FileManager.default.createFile(atPath: destination, contents: nil,
            attributes: [.posixPermissions: 0o600]) else { return nil }
        return FileHandle(forWritingAtPath: destination)
    }()
    static func record(_ event: String, _ fields: [String: Any] = [:], at time: Double = ProcessInfo.processInfo.systemUptime * 1000) {
        guard enabled else { return }
        var row = fields
        row["event"] = event; row["hostMs"] = time
        guard let data = try? JSONSerialization.data(withJSONObject: row) else { return }
        writer.async {
            guard bytes + data.count < 16 * 1024 * 1024, let handle else { return }
            do { try handle.write(contentsOf: data + Data([10])); bytes += data.count + 1 }
            catch { self.handle = nil }
        }
    }

    // The recorder draws white/green sentinels followed by eight red/cyan bits.
    // Sample the existing BGRA USB buffer directly: no image conversion or extra capture session.
    static func marker(_ pixel: CVPixelBuffer) -> Int? {
        guard enabled, CVPixelBufferGetPixelFormatType(pixel) == kCVPixelFormatType_32BGRA else { return nil }
        CVPixelBufferLockBaseAddress(pixel, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixel, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(pixel) else { return nil }
        let width = CVPixelBufferGetWidth(pixel), height = CVPixelBufferGetHeight(pixel)
        guard height > width, width > 100 else { return nil }
        let rowBytes = CVPixelBufferGetBytesPerRow(pixel)
        let p = base.assumingMemoryBound(to: UInt8.self)
        // UIKit may inset/letterbox the runner view. Locate the strip rather than
        // assuming its vertical origin, and require three agreeing scanlines.
        var previous: Int?, agreeing = 0
        for fraction in stride(from: 0.2, through: 0.64, by: 0.02) {
            var code = 0, valid = true
            for i in 0..<10 {
                let x = Int(Double(width) * (0.1 + (Double(i) + 0.5) * 0.08))
                let offset = Int(Double(height) * fraction) * rowBytes + x * 4
                let b = p[offset], g = p[offset + 1], r = p[offset + 2]
                if i == 0 { valid = r > 180 && g > 180 && b > 180 }
                else if i == 1 { valid = r < 80 && g > 180 && b < 80 }
                else if r < 80 && g > 180 && b > 180 { code |= 1 << (i - 2) }
                else { valid = r > 180 && g < 80 && b < 80 }
                if !valid { break }
            }
            if valid {
                agreeing = previous == code ? agreeing + 1 : 1
                previous = code
                if agreeing >= 3 { return code }
            } else { previous = nil; agreeing = 0 }
        }
        return nil
    }
}

// BEGIN TESTABLE CAPTURE EXECUTOR
// Cancellation is visible immediately, even while AVFoundation is blocked in
// startRunning(). Every session shares this queue: replacement capture must not
// configure the same USB device until the preceding session has stopped.
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
    private static let queue = DispatchQueue(label: "iphone-portal.capture-sessions", qos: .userInitiated)

    static func start(_ lifetime: CaptureLifetime, operation: @escaping @Sendable () -> Bool,
                      completion: @escaping @Sendable (Bool) -> Void) {
        queue.async {
            guard !lifetime.isCancelled else { return }
            let started = operation()
            guard !lifetime.isCancelled else { return }
            completion(started)
        }
    }

    static func stop(_ lifetime: CaptureLifetime, teardown: @escaping @Sendable () -> Void) {
        lifetime.cancel()
        queue.async(execute: teardown)
    }
}
// END TESTABLE CAPTURE EXECUTOR

// Retain one pixel buffer, not a history of frames. The capture queue never
// performs image conversion; snapshots are made only on lifecycle transitions.
private final class FrameStore: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let lifetime: CaptureLifetime
    private var pixel: CVPixelBuffer?
    private var timestamp: TimeInterval = 0
    private var lastMarker: Int?

    init(lifetime: CaptureLifetime) { self.lifetime = lifetime }

    func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard !lifetime.isCancelled, CMSampleBufferIsValid(sample), CMSampleBufferDataIsReady(sample),
              let pixel = CMSampleBufferGetImageBuffer(sample) else { return }
        let received = ProcessInfo.processInfo.systemUptime
        if MirrorBenchmark.enabled, let code = MirrorBenchmark.marker(pixel), code != lastMarker {
            lastMarker = code
            MirrorBenchmark.record("usb-marker", ["sequence": code,
                "samplePTS": CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample))], at: received * 1000)
        }
        lock.lock()
        if !lifetime.isCancelled {
            self.pixel = pixel
            timestamp = received
        }
        lock.unlock()
    }

    func clear() {
        lock.lock(); pixel = nil; timestamp = 0; lock.unlock()
    }

    var lastFrameAt: TimeInterval {
        lock.lock(); defer { lock.unlock() }
        return timestamp
    }
    func snapshot() -> NSImage? {
        lock.lock(); let pixel = self.pixel; lock.unlock()
        guard let pixel else { return nil }
        let image = CIImage(cvPixelBuffer: pixel)
        guard let cg = CIContext().createCGImage(image, from: image.extent) else { return nil }
        return NSImage(cgImage: cg, size: .zero)
    }
}

@MainActor
final class PhoneCapture {
    let session = AVCaptureSession()
    let layer: AVCaptureVideoPreviewLayer
    let audio = AVCaptureAudioPreviewOutput()
    var onSize: ((CGSize) -> Void)?
    var onFailure: (() -> Void)?
    private var observers: [NSObjectProtocol] = []
    private let lifetime = CaptureLifetime()
    private let frames: FrameStore
    private let video = AVCaptureVideoDataOutput()
    private let frameQueue = DispatchQueue(label: "iphone-portal.capture-frames", qos: .userInitiated)
    private var completion: (@MainActor (Bool) -> Void)?
    private var started = false
    private var stopped = false
    private var failureReported = false
    private(set) var startupTimeoutAt: TimeInterval? = nil
    var lastFrameAt: TimeInterval { frames.lastFrameAt }
    func snapshot() -> NSImage? { frames.snapshot() }
    private var deviceUDID = ""
    private var allowSingleDeviceFallback = false

    init(audioVolume: Float = 1) {
        frames = FrameStore(lifetime: lifetime)
        layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resize // the window already has the screen's aspect ratio
        audio.volume = min(1, max(0, audioVolume))
    }

    /// Calls done(true) once video is running, or done(false) if access is denied or no iPhone shows up.
    func start(udid: String, singleUsbDevice: Bool, timeout: TimeInterval = 8, _ done: @escaping @MainActor (Bool) -> Void) {
        guard !started, !stopped else { return done(false) }
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

        AVCaptureDevice.requestAccess(for: .video) { video in
            AVCaptureDevice.requestAccess(for: .audio) { audio in
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        guard !self.stopped else { return }
                        self.startupTimeoutAt = ProcessInfo.processInfo.systemUptime + 10
                        guard video else { return self.finish(false) }
                        self.waitForDevice(until: ProcessInfo.processInfo.systemUptime + timeout, withAudio: audio)
                    }
                }
            }
        }
    }

    func stop() {
        guard !stopped else { return }
        stopped = true
        completion = nil
        observers.forEach(NotificationCenter.default.removeObserver)
        observers.removeAll()
        let session = self.session
        let video = self.video
        let frames = self.frames
        CaptureSessionExecutor.stop(lifetime) {
            video.setSampleBufferDelegate(nil, queue: nil)
            session.stopRunning()
            session.beginConfiguration()
            session.inputs.forEach(session.removeInput)
            session.outputs.forEach(session.removeOutput)
            session.commitConfiguration()
            frames.clear()
        }
    }

    private func finish(_ ok: Bool) {
        guard !stopped else { return }
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
        let type: AVCaptureDevice.DeviceType
        if #available(macOS 14, *) { type = .external } else { type = .externalUnknown }
        let devices = AVCaptureDevice.DiscoverySession(deviceTypes: [type], mediaType: .muxed, position: .unspecified).devices
        let normalize: (String) -> String = { $0.lowercased().filter { $0.isLetter || $0.isNumber } }
        let expected = normalize(deviceUDID)
        if let exact = devices.first(where: { normalize($0.uniqueID) == expected }) { return exact }
        // CoreMediaIO may expose a video UUID instead of the USB UDID. Single-source
        // correspondence is unambiguous only with one USB phone and one iOS capture source.
        let ios = devices.filter { $0.modelID == "iOS Device" }
        return allowSingleDeviceFallback && ios.count == 1 ? ios[0] : nil
    }

    // The device appears a second or two after screen capture devices are allowed.
    private func waitForDevice(until deadline: TimeInterval, withAudio: Bool) {
        guard !stopped else { return }
        if let device = findDevice() { return run(device, withAudio: withAudio) }
        if ProcessInfo.processInfo.systemUptime > deadline { return finish(false) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            MainActor.assumeIsolated { self?.waitForDevice(until: deadline, withAudio: withAudio) }
        }
    }

    private func run(_ device: AVCaptureDevice, withAudio: Bool) {
        observe(AVCaptureInput.Port.formatDescriptionDidChangeNotification, object: nil) { [weak self] in
            self?.reportSize(device)
        }
        observe(AVCaptureSession.runtimeErrorNotification, object: session) { [weak self] in self?.failed() }
        observe(AVCaptureSession.wasInterruptedNotification, object: session) { [weak self] in self?.failed() }
        observe(AVCaptureDevice.wasDisconnectedNotification, object: device) { [weak self] in self?.failed() }
        let session = self.session
        let video = self.video
        let audio = self.audio
        let frames = self.frames
        let frameQueue = self.frameQueue
        CaptureSessionExecutor.start(lifetime, operation: {
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
            return session.isRunning
        }, completion: { [weak self] ok in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self, !self.stopped else { return }
                    self.reportSize(device)
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

    private func reportSize(_ device: AVCaptureDevice) {
        let d = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
        if d.width > 0, d.height > 0 { onSize?(CGSize(width: Int(d.width), height: Int(d.height))) }
    }
}
