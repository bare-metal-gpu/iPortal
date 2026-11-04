// Captures the USB-connected iPhone's screen and audio the way QuickTime does: once "screen capture devices"
// are allowed, macOS exposes the iPhone as an AVCaptureDevice with a hardware-decoded 60 fps stream.
// That's much smoother and lower-latency than WebDriverAgent's JPEG screenshots.
@preconcurrency import AVFoundation
import CoreMediaIO

@MainActor
final class PhoneCapture {
    let session = AVCaptureSession()
    let layer: AVCaptureVideoPreviewLayer
    let audio = AVCaptureAudioPreviewOutput()
    var onSize: ((CGSize) -> Void)?
    private var observer: NSObjectProtocol?

    init() {
        layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resize // the window already has the screen's aspect ratio
        audio.volume = 1
    }

    /// Calls done(true) once video is running, or done(false) if access is denied or no iPhone shows up.
    func start(timeout: TimeInterval = 8, _ done: @escaping @MainActor (Bool) -> Void) {
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
                        guard video else { return done(false) }
                        self.waitForDevice(until: Date().addingTimeInterval(timeout), withAudio: audio, done)
                    }
                }
            }
        }
    }

    func stop() { session.stopRunning() }

    private func findDevice() -> AVCaptureDevice? {
        let type: AVCaptureDevice.DeviceType
        if #available(macOS 14, *) { type = .external } else { type = .externalUnknown }
        let devices = AVCaptureDevice.DiscoverySession(deviceTypes: [type], mediaType: .muxed, position: .unspecified).devices
        return devices.first { $0.modelID.contains("iOS") } ?? devices.first
    }

    // The device appears a second or two after screen capture devices are allowed.
    private func waitForDevice(until deadline: Date, withAudio: Bool, _ done: @escaping @MainActor (Bool) -> Void) {
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
        // Capturing reroutes the iPhone's sound to the Mac, so play it here (like Apple's mirroring does).
        if withAudio, session.canAddOutput(audio) { session.addOutput(audio) }
        session.commitConfiguration()
        observer = NotificationCenter.default.addObserver(forName: AVCaptureInput.Port.formatDescriptionDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.reportSize(device) }
        }
        let session = self.session
        DispatchQueue.global(qos: .userInitiated).async {
            session.startRunning() // blocks until the stream is up
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
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
