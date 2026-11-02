// Captures the USB-connected iPhone's screen and audio the way QuickTime does: once "screen capture devices"
// are allowed, macOS exposes the iPhone as an AVCaptureDevice with a hardware-decoded 60 fps stream.
// That's much smoother and lower-latency than WebDriverAgent's JPEG screenshots.
@preconcurrency import AVFoundation
import CoreMediaIO
import Cocoa
import CoreImage

// Retain one pixel buffer, not a history of frames. The capture queue never
// performs image conversion; snapshots are made only on lifecycle transitions.
private final class FrameStore: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var pixel: CVPixelBuffer?
    private var timestamp: TimeInterval = 0
    func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pixel = CMSampleBufferGetImageBuffer(sample) else { return }
        lock.lock()
        self.pixel = pixel
        timestamp = ProcessInfo.processInfo.systemUptime
        lock.unlock()
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
    private var observer: NSObjectProtocol?
    private let frames = FrameStore()
    private let video = AVCaptureVideoDataOutput()
    private let sessionQueue = DispatchQueue(label: "iphone-portal.capture-session", qos: .userInitiated)
    private let frameQueue = DispatchQueue(label: "iphone-portal.capture-frames", qos: .userInitiated)
    private var stopped = false
    var lastFrameAt: TimeInterval { frames.lastFrameAt }
    func snapshot() -> NSImage? { frames.snapshot() }
    private var deviceUDID = ""
    private var allowSingleDeviceFallback = false

    init() {
        layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resize // the window already has the screen's aspect ratio
        audio.volume = 1
    }

    /// Calls done(true) once video is running, or done(false) if access is denied or no iPhone shows up.
    func start(udid: String, singleUsbDevice: Bool, timeout: TimeInterval = 8, _ done: @escaping @MainActor (Bool) -> Void) {
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
                        guard video else { return done(false) }
                        self.waitForDevice(until: Date().addingTimeInterval(timeout), withAudio: audio, done)
                    }
                }
            }
        }
    }

    func stop() {
        stopped = true
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        let session = self.session
        sessionQueue.async { session.stopRunning() }
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
    private func waitForDevice(until deadline: Date, withAudio: Bool, _ done: @escaping @MainActor (Bool) -> Void) {
        guard !stopped else { return }
        if let device = findDevice() { return run(device, withAudio: withAudio, done) }
        if Date() > deadline { return done(false) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            MainActor.assumeIsolated { self.waitForDevice(until: deadline, withAudio: withAudio, done) }
        }
    }

    private func run(_ device: AVCaptureDevice, withAudio: Bool, _ done: @escaping @MainActor (Bool) -> Void) {
        guard let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else { return done(false) }
        session.beginConfiguration()
        session.addInput(input)
        video.alwaysDiscardsLateVideoFrames = true
        video.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        guard session.canAddOutput(video) else { session.commitConfiguration(); return done(false) }
        video.setSampleBufferDelegate(frames, queue: frameQueue)
        session.addOutput(video)
        // Capturing reroutes the iPhone's sound to the Mac, so play it here (like Apple's mirroring does).
        if withAudio, session.canAddOutput(audio) { session.addOutput(audio) }
        session.commitConfiguration()
        observer = NotificationCenter.default.addObserver(forName: AVCaptureInput.Port.formatDescriptionDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.reportSize(device) }
        }
        let session = self.session
        sessionQueue.async {
            session.startRunning() // blocks until the stream is up
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard !self.stopped else { return }
                    self.reportSize(device)
                    done(session.isRunning)
                }
            }
        }
    }

    private func reportSize(_ device: AVCaptureDevice) {
        let d = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
        if d.width > 0, d.height > 0 { onSize?(CGSize(width: Int(d.width), height: Int(d.height))) }
    }
}
