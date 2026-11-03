// Captures the USB-connected iPhone's screen and audio the way QuickTime does: once "screen capture devices"
// are allowed, macOS exposes the iPhone as an AVCaptureDevice with a hardware-decoded 60 fps stream.
// That's much smoother and lower-latency than WebDriverAgent's JPEG screenshots.
@preconcurrency import AVFoundation
import CoreMediaIO
import Cocoa
import CoreImage
import IOKit

// Hardware notifications arrive before the next status poll and before the
// replacement CoreMediaIO video device is discoverable.
@MainActor
final class PhoneUSBMonitor {
    private var port: IONotificationPortRef?
    private var added: io_iterator_t = 0
    private var removed: io_iterator_t = 0
    private var serials: [UInt64: String] = [:]
    private let changed: (String, Bool) -> Void

    init(changed: @escaping (String, Bool) -> Void) {
        self.changed = changed
        guard let port = IONotificationPortCreate(kIOMainPortDefault) else { return }
        self.port = port
        CFRunLoopAddSource(CFRunLoopGetMain(), IONotificationPortGetRunLoopSource(port).takeUnretainedValue(), .commonModes)
        let context = Unmanaged.passUnretained(self).toOpaque()
        func matching() -> CFDictionary {
            let match = IOServiceMatching("IOUSBHostDevice") as NSMutableDictionary
            match[kIOPropertyMatchKey] = ["idVendor": 0x05ac]
            return match
        }
        IOServiceAddMatchingNotification(port, kIOMatchedNotification, matching(), { context, iterator in
            MainActor.assumeIsolated {
                Unmanaged<PhoneUSBMonitor>.fromOpaque(context!).takeUnretainedValue().drain(iterator, attached: true)
            }
        }, context, &added)
        drain(added, attached: true, initial: true)
        IOServiceAddMatchingNotification(port, kIOTerminatedNotification, matching(), { context, iterator in
            MainActor.assumeIsolated {
                Unmanaged<PhoneUSBMonitor>.fromOpaque(context!).takeUnretainedValue().drain(iterator, attached: false)
            }
        }, context, &removed)
        drain(removed, attached: false, initial: true)
    }

    private func drain(_ iterator: io_iterator_t, attached: Bool, initial: Bool = false) {
        while case let service = IOIteratorNext(iterator), service != 0 {
            defer { IOObjectRelease(service) }
            var id: UInt64 = 0
            IORegistryEntryGetRegistryEntryID(service, &id)
            let serial = IORegistryEntryCreateCFProperty(service, "USB Serial Number" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? String
            guard let serial = serial ?? serials[id] else { continue }
            if attached { serials[id] = serial } else { serials.removeValue(forKey: id) }
            if !initial { changed(serial, attached) }
        }
    }

    func stop() {
        if added != 0 { IOObjectRelease(added); added = 0 }
        if removed != 0 { IOObjectRelease(removed); removed = 0 }
        if let port { IONotificationPortDestroy(port); self.port = nil }
        serials.removeAll()
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
    private var notification: (@Sendable () -> Void)?

    func arm(_ callback: @escaping @Sendable () -> Void) {
        lock.lock(); notification = callback; lock.unlock()
    }

    init(lifetime: CaptureLifetime) { self.lifetime = lifetime }

    func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard !lifetime.isCancelled, CMSampleBufferIsValid(sample), CMSampleBufferDataIsReady(sample),
              let pixel = CMSampleBufferGetImageBuffer(sample) else { return }
        lock.lock()
        var callback: (@Sendable () -> Void)?
        if !lifetime.isCancelled {
            self.pixel = pixel
            timestamp = ProcessInfo.processInfo.systemUptime
            callback = notification
            notification = nil
        }
        lock.unlock()
        callback?()
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
    var onFrame: (() -> Void)?
    private var discoveryRetry: DispatchWorkItem?
    private var observers: [NSObjectProtocol] = []
    private let lifetime = CaptureLifetime()
    private let frames: FrameStore
    private let video = AVCaptureVideoDataOutput()
    private let frameQueue = DispatchQueue(label: "iphone-portal.capture-frames", qos: .userInitiated)
    private var completion: (@MainActor (Bool) -> Void)?
    private var started = false
    private var configuring = false
    private var stopped = false
    private var failureReported = false
    private(set) var startupTimeoutAt: TimeInterval? = nil
    var lastFrameAt: TimeInterval { frames.lastFrameAt }
    func snapshot() -> NSImage? { frames.snapshot() }
    func awaitFreshFrame() {
        frames.arm { [weak self] in
            DispatchQueue.main.async {
                guard let self, !self.stopped else { return }
                self.onFrame?()
            }
        }
    }
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
        portalTrace("capture-start-entered")
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
        portalTrace("capture-devices-enabled")

        AVCaptureDevice.requestAccess(for: .video) { video in
            portalTrace("capture-video-permission", ["allowed": video])
            AVCaptureDevice.requestAccess(for: .audio) { audio in
                portalTrace("capture-audio-permission", ["allowed": audio])
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        guard !self.stopped else { return }
                        self.startupTimeoutAt = ProcessInfo.processInfo.systemUptime + 10
                        guard video else { return self.finish(false) }
                        let deadline = ProcessInfo.processInfo.systemUptime + timeout
                        self.observe(AVCaptureDevice.wasConnectedNotification, object: nil) { [weak self] in
                            self?.waitForDevice(until: deadline, withAudio: audio)
                        }
                        self.waitForDevice(until: deadline, withAudio: audio)
                    }
                }
            }
        }
    }

    func stop() {
        guard !stopped else { return }
        stopped = true
        discoveryRetry?.cancel()
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
            portalTrace("capture-stopped")
        }
    }

    private func finish(_ ok: Bool) {
        guard !stopped else { return }
        portalTrace("capture-completion", ["ok": ok])
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
        guard !stopped, !configuring else { return }
        discoveryRetry?.cancel()
        if let device = findDevice() {
            configuring = true
            portalTrace("capture-device-available")
            return run(device, withAudio: withAudio)
        }
        if ProcessInfo.processInfo.systemUptime > deadline { return finish(false) }
        let retry = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.waitForDevice(until: deadline, withAudio: withAudio) }
        }
        discoveryRetry = retry
        DispatchQueue.main.asyncAfter(deadline: .now() + 1, execute: retry)
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
            portalTrace("capture-configure")
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
            portalTrace("capture-start-returned")
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
