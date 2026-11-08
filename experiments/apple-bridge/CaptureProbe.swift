import UIKit
#if canImport(ScreenCaptureKit)
import ScreenCaptureKit
import VideoToolbox

// This target is a manually started experiment. Nothing here is linked into the
// shipping helper. In particular, capture consent is never automated or inferred
// from an existing XCTest/USB pairing, and no captured media is written to disk.
@MainActor final class CaptureProbeController: UIViewController {
    private let summary = UITextView()
    private var experiment: AnyObject?
    private var stopCapture: (() -> Void)?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        summary.isEditable = false
        summary.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        summary.text = "Requires iOS 27. No capture is started automatically."
        let start = UIButton(type: .system), stop = UIButton(type: .system)
        start.setTitle("Choose display and start", for: .normal)
        stop.setTitle("Stop", for: .normal)
        let buttons = UIStackView(arrangedSubviews: [start, stop])
        buttons.distribution = .fillEqually
        let stack = UIStackView(arrangedSubviews: [buttons, summary])
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            stack.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -16),
        ])
        if #available(iOS 27.0, *) {
            let session = CaptureProbeSession { [weak self] text in self?.summary.text = text }
            experiment = session
            stopCapture = { [weak session] in session?.stop() }
            start.addAction(UIAction { [weak session] _ in session?.choose() }, for: .touchUpInside)
            stop.addAction(UIAction { [weak session] _ in session?.stop() }, for: .touchUpInside)
            summary.text = "Ready. Choose full-display capture in Apple's picker.\nSystem audio only; no microphone or camera.\nReports stay in memory; encoded frames are discarded."
        } else { start.isEnabled = false; stop.isEnabled = false }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        // Switching tabs or dismissing the probe ends this experiment. App
        // backgrounding itself does not call this and is deliberately testable.
        if isBeingDismissed || parent?.isBeingDismissed == true || tabBarController?.selectedViewController !== self {
            stopCapture?()
        }
    }
}

@available(iOS 27.0, *)
@MainActor private final class CaptureProbeSession: NSObject, SCStreamDelegate {
    private enum Phase { case idle, choosing, starting, running, stopping, retiring }
    private var phase = Phase.idle
    private var generation: UInt64 = 0
    private var stream: SCStream?
    private var samples: CaptureProbeSamples?
    private var observer: CaptureChoiceObserver?
    private var stopRequested = false
    private var watchdog: Task<Void, Never>?
    private let report: @MainActor (String) -> Void
    private let picker = SCContentSharingPicker.shared

    init(report: @escaping @MainActor (String) -> Void) { self.report = report }

    func choose() {
        guard phase == .idle else { return }
        guard picker.isAvailable else { report("Screen capture is unavailable or restricted on this device."); return }
        generation &+= 1
        stopRequested = false
        phase = .choosing
        let observer = CaptureChoiceObserver(owner: self, generation: generation)
        self.observer = observer
        picker.add(observer)
        var configuration = SCContentSharingPickerConfiguration()
        configuration.showsMicrophoneControl = false
        configuration.showsCameraControl = false
        picker.defaultConfiguration = configuration
        picker.isActive = true
        report("Waiting for system capture consent. Cancel leaves the phone unchanged.")
        picker.present()
    }

    fileprivate func selected(_ filter: SCContentFilter, generation token: UInt64) {
        guard token == generation, phase == .choosing else { return }
        removePickerObserver()
        phase = .starting
        report("Starting public ScreenCaptureKit capture…")
        let config = SCStreamConfiguration()
        // Native dimensions are iOS defaults. Unlike macOS, the installed SDK
        // marks pixelFormat, queueDepth, minimumFrameInterval and live updates
        // unavailable on iOS. Do not call them through ObjC/private workarounds.
        config.capturesAudio = true
        config.sampleRate = 48_000
        config.channelCount = 2
        let source = SCStream(filter: filter, configuration: config, delegate: self)
        let outputs = CaptureProbeSamples { [weak self] text in
            Task { @MainActor in
                guard let self, self.generation == token, self.phase == .running else { return }
                self.report(text)
            }
        }
        stream = source; samples = outputs
        do {
            try source.addStreamOutput(outputs, type: .screen, sampleHandlerQueue: outputs.queue)
            try source.addStreamOutput(outputs, type: .audio, sampleHandlerQueue: outputs.queue)
        } catch { finish(source, error: error); return }
        armWatchdog(token, operation: "Start")
        // The task retains this owner until Apple's callback, including while
        // the controller disappears. An unresolved start cannot become orphaned.
        Task { [self] in
            do {
                try await source.startCapture()
                guard generation == token, stream === source else { return }
                self.watchdog?.cancel(); self.watchdog = nil
                if self.stopRequested { await self.stopOwned(source, token: token); return }
                self.phase = .running
                outputs.setClock(source.synchronizationClock)
                self.report("Capture started. Waiting for video and system-audio samples…")
            } catch {
                guard generation == token, stream === source else { return }
                // A failed start may have partially established capture. Keep
                // ownership until an affirmative stop or terminal delegate event.
                self.report("Start failed: \(error.localizedDescription). Stopping the owned stream before another capture can start…")
                await self.stopOwned(source, token: token)
            }
        }
    }

    fileprivate func choiceEnded(_ token: UInt64, error: Error? = nil) {
        guard generation == token, phase == .choosing else { return }
        removePickerObserver(); picker.isActive = false; phase = .idle
        report(error.map { "Picker failed: \($0.localizedDescription)" } ?? "Capture cancelled. No stream started.")
    }

    func stop() {
        switch phase {
        case .idle, .stopping, .retiring: return
        case .choosing:
            choiceEnded(generation)
        case .starting:
            // Await the original start callback before stopping its stream.
            // A timeout never releases ownership or starts another capture.
            stopRequested = true
            report("Stop requested; waiting for the pending start callback.")
        case .running:
            guard let stream else { return }
            phase = .stopping
            let token = generation
            Task { await stopOwned(stream, token: token) }
        }
    }

    private func stopOwned(_ source: SCStream, token: UInt64) async {
        guard stream === source, token == generation else { return }
        phase = .stopping
        report("Stopping capture…")
        armWatchdog(token, operation: "Stop")
        do {
            try await source.stopCapture()
            guard stream === source, token == generation else { return }
            finish(source, error: nil)
        } catch {
            guard stream === source, token == generation else { return }
            watchdog?.cancel(); watchdog = nil
            // An error is not proof that capture stopped. A later terminal
            // delegate event can retire this stream; another start cannot.
            report("Stop failed: \(error.localizedDescription). Capture ownership remains unresolved; restart is blocked. Close the probe to reset.")
        }
    }

    private func armWatchdog(_ token: UInt64, operation: String) {
        watchdog?.cancel()
        watchdog = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(10)) } catch { return }
            guard let self, self.generation == token else { return }
            self.report("\(operation) callback has not arrived after 10 seconds. Ownership is retained; no replacement capture will start. Close the probe to reset if it remains stalled.")
        }
    }

    private func finish(_ source: SCStream, error: Error?) {
        guard stream === source, phase != .retiring else { return }
        watchdog?.cancel(); watchdog = nil
        generation &+= 1
        let token = generation
        phase = .retiring
        removePickerObserver(); picker.isActive = false
        let message = error.map { "Capture ended: \($0.localizedDescription)" } ?? "Capture stopped. No media was saved."
        guard let samples else { finishRetirement(source, token: token, message: message); return }
        try? source.removeStreamOutput(samples, type: .screen)
        try? source.removeStreamOutput(samples, type: .audio)
        report("Capture stopped. Retiring the owned encoder…")
        armWatchdog(token, operation: "Encoder teardown")
        // Invalidation is synchronous and can stall in VideoToolbox. Keep the
        // stream/samples owned, and prevent new sessions, until it has returned.
        samples.stop { [weak self] in
            Task { @MainActor in self?.finishRetirement(source, token: token, message: message) }
        }
    }

    private func finishRetirement(_ source: SCStream, token: UInt64, message: String) {
        guard stream === source, generation == token, phase == .retiring else { return }
        watchdog?.cancel(); watchdog = nil
        samples = nil; stream = nil; phase = .idle; stopRequested = false
        report(message)
    }

    private func removePickerObserver() {
        if let observer { picker.remove(observer) }
        observer = nil
    }

    nonisolated func stream(_ stream: SCStream, didStopWithError error: Error) {
        Task { @MainActor [weak self] in self?.finish(stream, error: error) }
    }
}

@available(iOS 27.0, *)
private final class CaptureChoiceObserver: NSObject, SCContentSharingPickerObserver {
    private weak var owner: CaptureProbeSession?
    private let generation: UInt64
    @MainActor init(owner: CaptureProbeSession, generation: UInt64) { self.owner = owner; self.generation = generation }
    func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) {
        Task { @MainActor [weak self] in guard let self else { return }; self.owner?.choiceEnded(self.generation) }
    }
    func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?) {
        Task { @MainActor [weak self] in guard let self else { return }; self.owner?.selected(filter, generation: self.generation) }
    }
    func contentSharingPickerStartDidFailWithError(_ error: Error) {
        Task { @MainActor [weak self] in guard let self else { return }; self.owner?.choiceEnded(self.generation, error: error) }
    }
}

@available(iOS 27.0, *)
private final class CaptureProbeSamples: NSObject, SCStreamOutput, @unchecked Sendable {
    let queue = DispatchQueue(label: "iportal.probe.capture", qos: .userInitiated)
    private let report: @Sendable (String) -> Void
    private var clock: CMClock?
    private var stopped = false
    private var started = ProcessInfo.processInfo.systemUptime
    private var lastReport = 0.0
    private var videoFrames = 0, audioBuffers = 0, audioSamples = 0
    private var geometry = "unknown", orientation = "unknown"
    private var videoStatus = "unknown"
    private var ages: [Double] = []
    private let encoder = CaptureProbeEncoder()

    init(report: @escaping @Sendable (String) -> Void) { self.report = report }
    func setClock(_ value: CMClock?) { queue.async { self.clock = value } }
    func stop(completion: @escaping @Sendable () -> Void = {}) {
        queue.async {
            self.stopped = true
            self.encoder.stop()
            completion()
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard !stopped, CMSampleBufferIsValid(sampleBuffer) else { return }
        let values = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]]
        let frameStatus = (values?.first?[.status] as? NSNumber).flatMap { SCFrameStatus(rawValue: $0.intValue) }
        if type == .screen { videoStatus = frameStatus.map { String(describing: $0) } ?? "not supplied" }
        let hasNewPixels = frameStatus == nil || frameStatus == .complete || frameStatus == .started
        if type == .screen, hasNewPixels, CMSampleBufferDataIsReady(sampleBuffer), let pixel = CMSampleBufferGetImageBuffer(sampleBuffer) {
            videoFrames += 1
            geometry = "\(CVPixelBufferGetWidth(pixel)) × \(CVPixelBufferGetHeight(pixel)), format \(CVPixelBufferGetPixelFormatType(pixel))"
            if let value = values?.first?[.videoOrientation] { orientation = String(describing: value) }
            if let clock {
                let age = CMTimeSubtract(CMClockGetTime(clock), CMSampleBufferGetPresentationTimeStamp(sampleBuffer)).seconds * 1000
                if age.isFinite, age >= 0, age < 10_000 { ages.append(age); if ages.count > 120 { ages.removeFirst() } }
            }
            encoder.consume(pixel, timestamp: CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
        } else if type == .audio, CMSampleBufferDataIsReady(sampleBuffer) {
            audioBuffers += 1; audioSamples += CMSampleBufferGetNumSamples(sampleBuffer)
        }
        let now = ProcessInfo.processInfo.systemUptime
        guard now - lastReport >= 1 else { return }
        lastReport = now
        let sorted = ages.sorted(), age = sorted.isEmpty ? "unknown" : String(format: "%.1f / %.1f", sorted[sorted.count / 2], sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.95))])
        report("Public ScreenCaptureKit — running\n\(geometry)\nOrientation metadata: \(orientation)\nVideo status: \(videoStatus)\nVideo: \(videoFrames) new frames, average \(String(format: "%.1f", Double(videoFrames) / max(0.001, now - started))) fps\nSystem audio: \(audioBuffers) buffers / \(audioSamples) samples\nCapture sample age median/p95: \(age) ms\n\(encoder.summary())\n\nThese are local capture/encoder timings, not network or display latency. Test backgrounding, rotation, audio and stop/restart separately. No media is saved.")
    }
}

// The output callback keeps only scalar metrics. At most two submitted frames
// are owned at once; old encoder callbacks cannot update a replacement encoder.
@available(iOS 27.0, *)
private final class CaptureProbeEncoder: @unchecked Sendable {
    private var session: VTCompressionSession?
    private var size = CGSize.zero
    private var unsupportedSize: CGSize?
    private let lock = NSLock()
    private var generation: UInt64 = 0
    private var nextID: UInt64 = 0
    private var pending: Set<UInt64> = []
    private var encoded = 0, skipped = 0, bytes = 0
    private var durations: [Double] = []
    private var errorText: String?

    func consume(_ pixel: CVPixelBuffer, timestamp: CMTime) {
        let dimensions = CGSize(width: CVPixelBufferGetWidth(pixel), height: CVPixelBufferGetHeight(pixel))
        guard unsupportedSize != dimensions else { return }
        lock.lock(); let inFlight = pending.count; lock.unlock()
        guard inFlight < 2 else { lock.lock(); skipped += 1; lock.unlock(); return }
        if session == nil || dimensions != size {
            guard inFlight == 0 else { lock.lock(); skipped += 1; lock.unlock(); return }
            if let session { VTCompressionSessionInvalidate(session) }
            session = nil; size = dimensions
            lock.lock(); generation &+= 1; lock.unlock()
            let specification: [String: Any] = [kVTVideoEncoderSpecification_EnableLowLatencyRateControl as String: true,
                kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder as String: true]
            let attributes = [kCVPixelBufferPixelFormatTypeKey as String: CVPixelBufferGetPixelFormatType(pixel)]
            let status = VTCompressionSessionCreate(allocator: nil, width: Int32(dimensions.width), height: Int32(dimensions.height),
                codecType: kCMVideoCodecType_H264, encoderSpecification: specification as CFDictionary,
                imageBufferAttributes: attributes as CFDictionary, compressedDataAllocator: nil,
                outputCallback: nil, refcon: nil, compressionSessionOut: &session)
            guard status == noErr, let session else {
                unsupportedSize = dimensions
                setError("Encoder unavailable (\(status)); capture metrics continue.")
                return
            }
            let properties: [String: Any] = [kVTCompressionPropertyKey_RealTime as String: true,
                kVTCompressionPropertyKey_AllowFrameReordering as String: false,
                kVTCompressionPropertyKey_ExpectedFrameRate as String: 60,
                kVTCompressionPropertyKey_AverageBitRate as String: 12_000_000]
            let configured = VTSessionSetProperties(session, propertyDictionary: properties as CFDictionary)
            guard configured == noErr else {
                VTCompressionSessionInvalidate(session); self.session = nil
                unsupportedSize = dimensions
                setError("Low-latency encoder configuration rejected (\(configured)); capture metrics continue.")
                return
            }
            setError(nil)
        }
        guard let session else { return }
        lock.lock(); nextID &+= 1; let id = nextID, token = generation; pending.insert(id); lock.unlock()
        let began = ProcessInfo.processInfo.systemUptime
        let status = VTCompressionSessionEncodeFrame(session, imageBuffer: pixel, presentationTimeStamp: timestamp,
            duration: .invalid, frameProperties: nil, infoFlagsOut: nil) { [weak self] status, _, sample in
                self?.completed(id, generation: token, began: began, status: status, sample: sample)
            }
        if status != noErr { completed(id, generation: token, began: began, status: status, sample: nil) }
    }

    private func setError(_ value: String?) {
        lock.lock(); errorText = value; lock.unlock()
    }

    private func completed(_ id: UInt64, generation token: UInt64, began: TimeInterval, status: OSStatus, sample: CMSampleBuffer?) {
        lock.lock(); defer { lock.unlock() }
        guard generation == token, pending.remove(id) != nil else { return }
        guard status == noErr, let sample else { errorText = "Encode callback failed (\(status))"; return }
        encoded += 1; bytes += CMSampleBufferGetTotalSampleSize(sample)
        durations.append((ProcessInfo.processInfo.systemUptime - began) * 1000)
        if durations.count > 120 { durations.removeFirst() }
    }

    func summary() -> String {
        lock.lock(); defer { lock.unlock() }
        if let errorText { return errorText }
        let sorted = durations.sorted()
        let timing = sorted.isEmpty ? "unknown" : String(format: "%.1f / %.1f", sorted[sorted.count / 2], sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.95))])
        return "H.264 hardware encode: \(encoded) frames / \(bytes) bytes\nEncode median/p95: \(timing) ms; capacity drops: \(skipped); in flight: \(pending.count)"
    }

    func stop() {
        lock.lock(); generation &+= 1; pending.removeAll(); lock.unlock()
        if let session { VTCompressionSessionInvalidate(session) }
        session = nil
    }
}
#else
// Current simulator SDKs do not expose the iOS ScreenCaptureKit module. Keep
// the independent input recorder runnable there without pretending capture was
// tested. Older SDKs take the same explicit unsupported path.
@MainActor final class CaptureProbeController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let message = UILabel()
        message.text = "ScreenCaptureKit capture requires a physical iOS 27 device and a supporting SDK. Input probes remain available in this simulator."
        message.numberOfLines = 0
        message.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(message)
        NSLayoutConstraint.activate([
            message.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            message.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            message.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
    }
}
#endif
