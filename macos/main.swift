// Native device windows for iPortal: no chrome, with a slim hover toolbar.
// Each window owns a iportal.mjs process pinned to one iPhone or iPad. Video comes from direct USB capture
// (Capture.swift), with a transparent WKWebView on top that turns clicks and keys into touches. If the capture
// isn't available, the web view shows WebDriverAgent's MJPEG stream instead.
import Cocoa
import WebKit
import CoreText
import Carbon

let barHeight: CGFloat = 30
let barGap: CGFloat = 6
let defaultPhoneHeight: CGFloat = 844
let preferredPort = Int(ProcessInfo.processInfo.environment["IPORTAL_PORT"] ?? "") ?? 7100
let info = Bundle.main.infoDictionary ?? [:]
let repoPath = info["IPortalRepoPath"] as? String ?? FileManager.default.currentDirectoryPath
let nodePath = info["IPortalNodePath"] as? String ?? "/opt/homebrew/bin/node"
let logURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/iPortal.log")
// Opt-in, monotonic milestones; never log frames or input contents.
private let traceQueue = DispatchQueue(label: "iportal.reconnect-trace")
func iportalTrace(_ event: String, _ fields: [String: Any] = [:]) {
    guard FileManager.default.fileExists(atPath: repoPath + "/vendor/trace-reconnect") else { return }
    var record = fields
    record["event"] = event; record["uptime"] = ProcessInfo.processInfo.systemUptime
    record["wallMs"] = Date().timeIntervalSince1970 * 1000
    guard var data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) else { return }
    data.append(10)
    let payload = data
    traceQueue.async {
        let path = repoPath + "/vendor/reconnect-trace.jsonl"
        if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil) }
        guard let file = FileHandle(forWritingAtPath: path) else { return }
        defer { try? file.close() }
        _ = try? file.seekToEnd(); try? file.write(contentsOf: payload)
    }
}

final class MirrorWindow: NSWindow {
    // Borderless windows can't become key by default, which would block keyboard input.
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

final class DragBar: NSVisualEffectView {
    override func mouseDown(with event: NSEvent) { window?.performDrag(with: event) }
}

enum ResizeCorner: CaseIterable {
    case topLeft, topRight, bottomLeft, bottomRight
    var left: Bool { self == .topLeft || self == .bottomLeft }
    var bottom: Bool { self == .bottomLeft || self == .bottomRight }
}

final class CornerResizeHandle: NSView {
    let corner: ResizeCorner
    var onResize: ((ResizeCorner, NSRect, NSPoint) -> Void)?
    private var startFrame: NSRect?
    private var startMouse = NSPoint.zero

    init(corner: ResizeCorner) {
        self.corner = corner
        super.init(frame: .zero)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func resetCursorRects() {
        let cursor: NSCursor
        if #available(macOS 15, *) {
            let position: NSCursor.FrameResizePosition
            switch corner {
            case .topLeft: position = .topLeft
            case .topRight: position = .topRight
            case .bottomLeft: position = .bottomLeft
            case .bottomRight: position = .bottomRight
            }
            cursor = .frameResize(position: position, directions: .all)
        } else {
            cursor = .crosshair
        }
        addCursorRect(bounds, cursor: cursor)
    }

    private func screenLocation(_ event: NSEvent) -> NSPoint {
        // A left/top resize moves the window origin. Use the event's global
        // position so later drag events cannot accumulate that movement twice.
        if let point = event.cgEvent?.location, let primary = NSScreen.screens.first {
            return NSPoint(x: point.x, y: primary.frame.maxY - point.y)
        }
        return window?.convertPoint(toScreen: event.locationInWindow) ?? event.locationInWindow
    }

    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        startFrame = window.frame
        startMouse = screenLocation(event)
    }
    override func mouseDragged(with event: NSEvent) {
        guard let startFrame else { return }
        let mouse = screenLocation(event)
        onResize?(corner, startFrame, NSPoint(x: mouse.x - startMouse.x, y: mouse.y - startMouse.y))
    }
    override func mouseUp(with event: NSEvent) { startFrame = nil }
}

final class HoverView: NSView {
    var onHover: ((Bool) -> Void)?
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }
    override func mouseEntered(with event: NSEvent) { onHover?(true) }
    override func mouseExited(with event: NSEvent) { onHover?(false) }
}

@MainActor
final class MirrorSession: NSObject, WKScriptMessageHandler, WKNavigationDelegate, NSWindowDelegate {
    let sessionID = UUID()
    var mirroringActive = false
    var mirrorGeneration = 0
    var serverStopping = false
    var requestedDeviceUDID: String?
    var window: MirrorWindow!
    var phone: NSVisualEffectView!
    var videoHost: NSView!
    var web: WKWebView!
    var bar: DragBar!
    var barButtons: [NSView] = []
    var resizeHandles: [CornerResizeHandle] = []
    var server: Process?
    var ratio: CGFloat = 390 / 844
    var preferredPhoneLongEdge: CGFloat = defaultPhoneHeight
    var adjustingGeometry = false
    var phoneHeight = defaultPhoneHeight
    var hideBar: DispatchWorkItem?
    var capture: PhoneCapture?
    var captureFailed = false
    var nativeIdentityDeferred = false
    let loadingBorderState = LoadingBorderState()
    var loadingBorder: LoadingBorderHost!
    var pageLoading = true
    var captureLoading = true
    var waitingForVideo = true
    var videoGate = VideoReadinessGate()
    var deviceLifecycle: String { videoGate.lifecycle }
    var captureUdid: String? { videoGate.deviceID }
    var singleUsbDevice = false
    var lifecycleTimer: Timer?
    weak var owner: AppDelegate?
    var port: Int?
    var serverOwner = ""
    var serverOutput = Data()
    var serverPipe: Pipe?
    var kind: IPortalDeviceKind = .iPhone
    var deviceName = "iPhone"
    var usbRecovery = USBRecoveryWindow()
    var lastObservedLifecycle = "connecting"
    var lastStatusAt = ProcessInfo.processInfo.systemUptime
    var captureStartedAt: TimeInterval = 0
    var captureBudget = CaptureRetryBudget()
    var nextNativeAttemptAt: TimeInterval = 0
    var audioVolume: Float = 1
    var videoMode = "native"
    var serviceProbeInFlight = false
    var nextServiceProbeAt: TimeInterval = 0
    var nextConnectionPollAt: TimeInterval = 0
    var statusEventTask: Task<Void, Never>?
    var lastServerEventAt: TimeInterval = 0
    var latestServerStatus: String?
    var serverInstance: String?
    var serverFailures = 0
    var serverStartedAt: TimeInterval = 0
    var serverRetryAt: TimeInterval = 0
    var serverBackoff: TimeInterval = 1
    var webNeedsReload = true
    var webRetryAt: TimeInterval = 0
    var webBackoff: TimeInterval = 1
    var webHealthySince: TimeInterval = 0
    var terminating = false
    var retiredBridgeIDs: Set<String> = []
    var scrollMonitor: Any?
    var trackingScroll = false
    var trackingMagnify = false
    var settingsVisible = false
    var settingsBlocksInput: Bool { settingsVisible || settingsHost?.isHidden == false }
    var settingsGeneration = 0
    var settingsHost: SettingsOverlayHost!
    let settingsState = SettingsOverlayState()
    var permissionObserver: NSObjectProtocol?
    var permissionSnapshot = CapturePermissions.shared.snapshot

    func trace(_ event: String, _ fields: [String: Any] = [:]) {
        var fields = fields
        fields["device"] = requestedDeviceUDID ?? "unselected"
        iportalTrace(event, fields)
    }

    func updateLoadingBorder() {
        guard mirroringActive else { return }
        let phase: String
        if deviceLifecycle == "locked" || deviceLifecycle == "disconnected" { phase = deviceLifecycle }
        else if deviceLifecycle != "ready" || captureLoading || waitingForVideo { phase = usbRecovery.active ? "reconnecting" : "connecting" }
        else { phase = "live" }
        if videoMode == "native", phase != "live", loadingBorderState.phase == "live" {
            loadingBorderState.snapshot = capture?.snapshot() ?? loadingBorderState.snapshot
        }
        loadingBorderState.phase = phase
        loadingBorderState.showMessage = phase != "live"
        loadingBorderState.active = phase == "connecting" || phase == "reconnecting" || (phase == "live" && pageLoading)
        if phase == "locked" { loadingBorderState.detail = "Unlock your \(kind.rawValue) to continue" }
        if phase == "disconnected" { loadingBorderState.detail = "Connect your \(kind.rawValue)" }
        if phase == "reconnecting" { loadingBorderState.detail = "" }
        capture?.layer.isHidden = phase != "live"
    }

    func nativeCall(_ function: String, ready: Bool? = nil) {
        guard !videoGate.bridgeID.isEmpty else { return }
        var arguments: [Any] = []
        if let ready { arguments.append(ready) }
        arguments += [videoGate.epoch, videoGate.bridgeID]
        guard let data = try? JSONSerialization.data(withJSONObject: arguments),
              let json = String(data: data, encoding: .utf8) else { return }
        js("\(function)(...\(json))")
    }

    func freezeVideo() {
        trackingScroll = false
        trackingMagnify = false
        if videoMode == "native" {
            loadingBorderState.snapshot = capture?.snapshot() ?? loadingBorderState.snapshot
        }
        captureLoading = true
        waitingForVideo = true
        capture?.awaitFreshFrame()
        nativeCall("setNativeVideoReady", ready: false)
    }

    func stopCapture() {
        capture?.stop()
        capture?.layer.removeFromSuperlayer()
        capture = nil
    }

    func applyLifecycle(_ next: String, udid: String?, singleUsbDevice: Bool, usbDevicePresent: Bool,
                        epoch: Int, bridgeID: String, instance: String, statusRevision: Int, connectionID: String) -> Bool {
        let now = ProcessInfo.processInfo.systemUptime
        self.singleUsbDevice = singleUsbDevice
        capture?.updateIdentityPolicy(singleUSB: singleUsbDevice)
        // Either IOKit or usbmuxd may arrive first. Establish the same recovery
        // window from a fresh transport observation before interpreting state.
        if statusRevision > videoGate.statusRevision || bridgeID != videoGate.bridgeID {
            let samePhone = udid == videoGate.deviceID
            if next != "disconnected", samePhone,
               lastObservedLifecycle == "disconnected" || (!connectionID.isEmpty && !videoGate.connectionID.isEmpty && connectionID != videoGate.connectionID) {
                usbRecovery.attached(at: now)
            } else if next == "disconnected", lastObservedLifecycle != "disconnected", usbRecovery.active {
                _ = usbRecovery.detached(at: now)
            }
            lastObservedLifecycle = next
        }
        let observed = next == "disconnected" && usbRecovery.holdsDisconnect(at: now) ? "connecting" : next
        let change = videoGate.observe(observed, deviceID: udid, epoch: epoch,
                                       bridgeID: bridgeID, serverInstance: instance, statusRevision: statusRevision, now: now,
                                       connectionID: connectionID)
        guard change.accepted else { return false }
        if change.newStatus { lastStatusAt = now }
        guard change.invalidated else { return true }
        NSLog("iPortal lifecycle: %@, USB %@, reattached=%d", next, connectionID, change.reattached)
        trace("lifecycle", ["state": observed, "usb": connectionID])
        captureBudget.failed()
        freezeVideo()
        if change.deviceChanged || change.reattached {
            // Keep an in-flight capture through the USB mode switch it caused.
            // AVFoundation failure/fresh-frame checks still govern its lifetime.
            if change.deviceChanged || !usbRecovery.active { stopCapture() }
            // A new USB attachment gets a fresh capture budget, while the same
            // phone keeps its frozen frame. Never retain another phone's pixels.
            if change.deviceChanged { loadingBorderState.snapshot = nil }
            captureFailed = false
            captureBudget = CaptureRetryBudget()
            nextNativeAttemptAt = 0
        }
        if deviceLifecycle != "ready" {
            if deviceLifecycle == "disconnected" { usbRecovery.finish(); stopCapture() }
            else if deviceLifecycle == "connecting", usbDevicePresent, capture == nil, !captureFailed,
                    let captureUdid, !connectionID.isEmpty, now >= nextNativeAttemptAt {
                // Prepare video in parallel with control readiness, once the
                // USB service supplies current identity/multiplicity. IOKit
                // alone still carries the old attachment's selection policy.
                // Input requires a fresh frame AND a verified unlocked helper.
                startCapture(udid: captureUdid, singleUsbDevice: singleUsbDevice)
            }
        } else {
            captureStartedAt = now
            loadingBorderState.detail = ""
            if capture == nil {
                if let captureUdid, now >= nextNativeAttemptAt {
                    startCapture(udid: captureUdid, singleUsbDevice: singleUsbDevice)
                } else {
                    captureLoading = false
                    captureFailed = true
                    nativeCall("startStream")
                }
            } else {
                captureLoading = true
                capture?.awaitFreshFrame()
                nativeCall("useNativeVideo")
            }
        }
        updateLoadingBorder()
        return true
    }

    func suspendLifecycle() {
        captureBudget.failed()
        freezeVideo()
        videoGate.suspend(at: ProcessInfo.processInfo.systemUptime)
        updateLoadingBorder()
    }

    func checkVideoLifecycle() {
        guard mirroringActive, !terminating else { return }
        let now = ProcessInfo.processInfo.systemUptime
        if now - lastServerEventAt > 12, now >= nextConnectionPollAt {
            nextConnectionPollAt = now + (deviceLifecycle == "ready" ? 1 : 0.5)
            // WebKit suspends page timers when the window is fully occluded.
            // A native refresh wakes it; poll() coalesces concurrent callers.
            js("if (typeof poll === 'function') { void poll(); }")
        }
        if (webNeedsReload || now - lastServerEventAt > 12), now >= nextServiceProbeAt {
            nextServiceProbeAt = now + 2
            ensureServer()
        }
        if now - lastStatusAt > 5, deviceLifecycle == "ready" || deviceLifecycle == "locked" {
            suspendLifecycle()
        }
        guard deviceLifecycle == "ready" else { return }
        guard let capture else {
            // Prefer native capture again after a bounded cooldown. Keep the
            // working fallback while the retry budget is exhausted.
            if captureFailed, let captureUdid, now >= nextNativeAttemptAt {
                startCapture(udid: captureUdid, singleUsbDevice: singleUsbDevice)
            }
            return
        }
        let frameAt = capture.lastFrameAt
        let fresh = videoGate.acceptsFrame(at: frameAt, now: ProcessInfo.processInfo.systemUptime)
        if fresh {
            captureBudget.healthy(at: now)
            usbRecovery.finish()
            if captureLoading {
                captureLoading = false
                trace("video-ready", ["sampleAt": frameAt])
                NSLog("iPortal native video ready")
                nativeCall("setNativeVideoReady", ready: true)
                updateLoadingBorder()
            }
        } else {
            captureBudget.failed()
            if !captureLoading {
                freezeVideo()
                videoGate.requireFreshFrame(at: now)
                captureStartedAt = now
                updateLoadingBorder()
            }
            if let startupTimeoutAt = capture.startupTimeoutAt,
               now > max(captureStartedAt + 10, startupTimeoutAt) { recoverCapture() }
        }
    }

    func recoverCapture() {
        CapturePermissions.shared.refresh()
        if CapturePermissions.shared.snapshot.blocksNativeCapture { fallbackToStream(); return }
        freezeVideo()
        captureBudget.failed()
        stopCapture()
        captureFailed = true
        // An AVFoundation disconnect can precede the USB status poll. Wait for
        // a fresh control-plane observation instead of spending retries on the
        // device that has just disappeared.
        videoGate.suspend(at: ProcessInfo.processInfo.systemUptime)
        NSLog("iPortal capture interrupted; waiting for fresh USB status")
        updateLoadingBorder()
    }

    private func normalizeSerial(_ value: String) -> String {
        value.lowercased().filter { $0.isLetter || $0.isNumber }
    }

    init(owner: AppDelegate) { self.owner = owner; super.init() }

    func bind(_ device: IPortalUSBDevice) {
        guard requestedDeviceUDID == nil else { return }
        requestedDeviceUDID = phoneUDID(fromUSBSerial: device.serial)
        kind = device.kind
        deviceName = device.name
        ratio = kind.initialRatio
        if mirroringActive {
            videoGate.suspend(at: ProcessInfo.processInfo.systemUptime)
            window.title = deviceName
            resize(); updateLoadingBorder(); ensureServer()
            if window.isKeyWindow { UserDefaults.standard.set(requestedDeviceUDID, forKey: "MirrorDeviceUDID") }
        }
    }

    func wake() {
        guard mirroringActive else { return }
        suspendLifecycle()
        stopCapture()
        webNeedsReload = true
        webRetryAt = 0
        ensureServer()
    }

    func captureInventoryChanged() {
        guard nativeIdentityDeferred else { return }
        nativeIdentityDeferred = false
        nextNativeAttemptAt = 0
        captureBudget = CaptureRetryBudget()
    }

    func usbChanged(_ serial: String, attached: Bool) {
        let now = ProcessInfo.processInfo.systemUptime
        guard mirroringActive else { return }
        guard let udid = requestedDeviceUDID else {
            js("if (typeof poll === 'function') { void poll(); }")
            return
        }
        guard normalizeSerial(serial) == normalizeSerial(udid) else { return }
        trace(attached ? "usb-attached" : "usb-detached")
        if attached { usbRecovery.attached(at: now) }
        if !attached {
            freezeVideo()
            if usbRecovery.detached(at: now) { videoGate.suspend(at: now) }
            else { stopCapture(); videoGate.disconnect(at: now) }
            updateLoadingBorder()
        }
        nativeCall("usbConnectionChanged", ready: attached)
        nextConnectionPollAt = 0
    }

    func startMirroring() {
        if mirroringActive {
            window.deminiaturize(nil)
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        mirroringActive = true
        mirrorGeneration += 1
        videoGate = VideoReadinessGate()
        if requestedDeviceUDID == nil { videoGate.disconnect(at: ProcessInfo.processInfo.systemUptime) }
        usbRecovery = USBRecoveryWindow()
        lastObservedLifecycle = "connecting"
        retiredBridgeIDs.removeAll()
        captureBudget = CaptureRetryBudget()
        captureFailed = false
        captureLoading = true
        waitingForVideo = true
        pageLoading = true
        videoMode = "native"
        webNeedsReload = true
        webRetryAt = 0
        webBackoff = 1
        lastServerEventAt = 0
        latestServerStatus = nil
        serverInstance = nil
        serverRetryAt = 0
        serverBackoff = 1
        serverFailures = 0
        webHealthySince = 0
        lastStatusAt = ProcessInfo.processInfo.systemUptime
        serviceProbeInFlight = false
        nextServiceProbeAt = 0
        nextConnectionPollAt = 0
        nextNativeAttemptAt = 0
        NSApp.setActivationPolicy(.regular)
        buildWindow()
        CapturePermissions.shared.refresh()
        permissionSnapshot = CapturePermissions.shared.snapshot
        permissionObserver = NotificationCenter.default.addObserver(forName: CapturePermissions.didChange,
            object: CapturePermissions.shared, queue: .main) { [weak self] _ in
                Task { @MainActor [weak self] in self?.permissionsChanged() }
            }
        installScrollMonitor()
        updateLoadingBorder()
        ensureServer()
        lifecycleTimer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.checkVideoLifecycle() }
        }
        if let lifecycleTimer { RunLoop.main.add(lifecycleTimer, forMode: .common) }
        NSApp.activate(ignoringOtherApps: true)
    }

    func stopMirroring() {
        guard mirroringActive else { return }
        mirroringActive = false
        mirrorGeneration += 1
        statusEventTask?.cancel(); statusEventTask = nil
        lifecycleTimer?.invalidate(); lifecycleTimer = nil
        hideBar?.cancel(); hideBar = nil
        if let permissionObserver { NotificationCenter.default.removeObserver(permissionObserver) }
        permissionObserver = nil
        CapturePermissions.shared.inspect(sessionID, visible: false)
        settingsVisible = false; settingsGeneration += 1
        settingsState.snapshot = nil; settingsHost = nil
        if let scrollMonitor { NSEvent.removeMonitor(scrollMonitor); self.scrollMonitor = nil }
        stopCapture()
        web?.stopLoading()
        web?.navigationDelegate = nil
        web?.configuration.userContentController.removeScriptMessageHandler(forName: "native")
        window?.delegate = nil
        window?.orderOut(nil)
        window?.contentView = nil
        web = nil; phone = nil; videoHost = nil; bar = nil; loadingBorder = nil; window = nil
        barButtons.removeAll(); resizeHandles.removeAll()
        loadingBorderState.snapshot = nil
        latestServerStatus = nil
        if let process = server, process.isRunning {
            serverStopping = true
            process.terminate()
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            }
        }

    }

    func windowWillClose(_ notification: Notification) {
        guard let closing = notification.object as? NSWindow, closing === window else { return }
        stopMirroring()
        owner?.closed(self)
    }

    func windowDidBecomeKey(_ notification: Notification) {
        if let requestedDeviceUDID { UserDefaults.standard.set(requestedDeviceUDID, forKey: "MirrorDeviceUDID") }
    }

    // MARK: Window

    var maxPhoneHeight: CGFloat {
        guard let screen = window?.screen ?? NSScreen.main else { return 800 }
        return min(screen.visibleFrame.height - barHeight - barGap - 20,
                   (screen.visibleFrame.width - 20) / ratio)
    }

    func buildWindow() {
        phoneHeight = min(defaultPhoneHeight, maxPhoneHeight - 40)
        preferredPhoneLongEdge = phoneHeight * max(1, ratio)
        let size = windowSize()
        let vis = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        window = MirrorWindow(contentRect: NSRect(x: vis.midX - size.width / 2, y: vis.midY - size.height / 2, width: size.width, height: size.height),
                              styleMask: [.borderless, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = deviceName
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.isReleasedWhenClosed = false
        window.delegate = self

        let root = HoverView(frame: NSRect(origin: .zero, size: size))
        root.onHover = { [weak self] inside in self?.hover(inside) }
        window.contentView = root

        phone = NSVisualEffectView()
        configureIPortalMaterial(phone)
        phone.wantsLayer = true
        phone.layer?.masksToBounds = true
        phone.layer?.cornerCurve = .continuous
        root.addSubview(phone)

        // NSVisualEffectView owns internal backdrop layers. Keep video in a
        // regular subview above those layers so the blur cannot cover it.
        videoHost = NSView()
        videoHost.wantsLayer = true
        phone.addSubview(videoHost)

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "native")
        web = WKWebView(frame: .zero, configuration: config)
        web.setValue(false, forKey: "drawsBackground")
        web.navigationDelegate = self
        phone.addSubview(web)
        loadingBorder = LoadingBorderHost(rootView: LoadingBorder(state: loadingBorderState))
        phone.addSubview(loadingBorder)
        resizeHandles = ResizeCorner.allCases.map { corner in
            let handle = CornerResizeHandle(corner: corner)
            handle.onResize = { [weak self] corner, frame, delta in
                self?.resizeFromCorner(corner, initial: frame, delta: delta)
            }
            phone.addSubview(handle)
            return handle
        }

        bar = DragBar()
        configureIPortalMaterial(bar)
        bar.maskImage = roundedMask(radius: 9)
        bar.alphaValue = 0
        bar.isHidden = true
        root.addSubview(bar)

        let close = NSWindow.standardWindowButton(.closeButton, for: [.titled])!
        close.target = self
        close.action = #selector(closeWindow)
        let minimize = NSWindow.standardWindowButton(.miniaturizeButton, for: [.titled])!
        minimize.target = window
        minimize.action = #selector(NSWindow.miniaturize(_:))
        barButtons = [close, minimize,
                      symbolButton("gearshape", "Settings", #selector(toggleSettings)),
                      symbolButton("square.on.square", "App Switcher", #selector(appSwitcher)),
                      symbolButton("house", "Home", #selector(home))]
        barButtons.forEach(bar.addSubview)
        settingsHost = SettingsOverlayHost(rootView: SettingsOverlay(state: settingsState, permissions: .shared,
            close: { [weak self] in self?.setSettingsVisible(false) }))
        settingsHost.isHidden = true
        settingsHost.alphaValue = 0
        phone.addSubview(settingsHost)

        layout()
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(web)
    }

    func symbolButton(_ symbol: String, _ label: String, _ action: Selector) -> NSButton {
        let b = NSButton(image: NSImage(systemSymbolName: symbol, accessibilityDescription: label)!, target: self, action: action)
        b.isBordered = false
        b.contentTintColor = .secondaryLabelColor
        b.toolTip = label
        return b
    }

    func roundedMask(radius r: CGFloat) -> NSImage {
        let img = NSImage(size: NSSize(width: r * 2 + 1, height: r * 2 + 1), flipped: false) { rect in
            NSColor.black.setFill()
            NSBezierPath(roundedRect: rect, xRadius: r, yRadius: r).fill()
            return true
        }
        img.capInsets = NSEdgeInsets(top: r, left: r, bottom: r, right: r)
        img.resizingMode = .stretch
        return img
    }

    func windowSize() -> NSSize { NSSize(width: (phoneHeight * ratio).rounded(), height: phoneHeight + barGap + barHeight) }

    func layout() {
        let w = (phoneHeight * ratio).rounded()
        let minimum = min(400 / max(1, ratio), maxPhoneHeight)
        window.minSize = NSSize(width: (minimum * ratio).rounded(), height: minimum + barGap + barHeight)
        window.maxSize = NSSize(width: (maxPhoneHeight * ratio).rounded(), height: maxPhoneHeight + barGap + barHeight)
        phone.frame = NSRect(x: 0, y: 0, width: w, height: phoneHeight)
        phone.layer?.cornerRadius = kind.radius(width: w, height: phoneHeight)
        web.frame = phone.bounds
        loadingBorder.frame = phone.bounds
        settingsHost?.frame = phone.bounds
        loadingBorderState.radius = max(0, kind.radius(width: w, height: phoneHeight) - 2)
        // Generous grab areas extend inward from every rounded phone corner.
        // They sit above the input web view, so a resize cannot send a phone gesture.
        let grabSize: CGFloat = 56
        for handle in resizeHandles {
            handle.frame = NSRect(x: handle.corner.left ? 0 : w - grabSize,
                                  y: handle.corner.bottom ? 0 : phoneHeight - grabSize,
                                  width: grabSize, height: grabSize)
            window.invalidateCursorRects(for: handle)
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        videoHost.frame = phone.bounds
        capture?.layer.frame = videoHost.bounds
        CATransaction.commit()
        bar.frame = NSRect(x: 0, y: phoneHeight + barGap, width: w, height: barHeight)
        // Traffic lights on the left; Settings, App Switcher and Home on the right.
        let y = (barHeight - 16) / 2
        barButtons[0].frame = NSRect(x: 10, y: y + 1, width: 14, height: 14)
        barButtons[1].frame = NSRect(x: 30, y: y + 1, width: 14, height: 14)
        barButtons[2].frame = NSRect(x: w - 92, y: y, width: 22, height: 16)
        barButtons[3].frame = NSRect(x: w - 62, y: y, width: 22, height: 16)
        barButtons[4].frame = NSRect(x: w - 32, y: y, width: 22, height: 16)
        window.invalidateShadow()
    }

    // Preserve the phone's aspect ratio, excluding the fixed-height toolbar.
    func windowWillResize(_ sender: NSWindow, to frameSize: NSSize) -> NSSize {
        constrainedWindowSize(frameSize, relativeTo: sender.frame.size)
    }

    func constrainedWindowSize(_ frameSize: NSSize, relativeTo current: NSSize) -> NSSize {
        let widthChange = abs(frameSize.width - current.width) / max(1, current.width)
        let heightChange = abs(frameSize.height - current.height) / max(1, current.height)
        let proposedHeight = widthChange > heightChange
            ? frameSize.width / ratio
            : frameSize.height - barGap - barHeight
        let height = min(maxPhoneHeight, max(min(400 / max(1, ratio), maxPhoneHeight), proposedHeight))
        return NSSize(width: (height * ratio).rounded(), height: height + barGap + barHeight)
    }

    func resizeFromCorner(_ corner: ResizeCorner, initial: NSRect, delta: NSPoint) {
        let proposed = NSSize(width: initial.width + (corner.left ? -delta.x : delta.x),
                              height: initial.height + (corner.bottom ? -delta.y : delta.y))
        let size = constrainedWindowSize(proposed, relativeTo: initial.size)
        let origin = NSPoint(x: corner.left ? initial.maxX - size.width : initial.minX,
                             y: corner.bottom ? initial.maxY - size.height : initial.minY)
        window.setFrame(NSRect(origin: origin, size: size), display: true)
    }

    func windowDidResize(_ notification: Notification) {
        guard phone != nil, loadingBorder != nil, barButtons.count == 5 else { return }
        phoneHeight = window.frame.height - barGap - barHeight
        if !adjustingGeometry { preferredPhoneLongEdge = phoneHeight * max(1, ratio) }
        layout()
    }

    func resize() {
        guard mirroringActive, window != nil else { return }
        phoneHeight = min(maxPhoneHeight, max(min(400 / max(1, ratio), maxPhoneHeight), phoneHeight))
        preferredPhoneLongEdge = phoneHeight * max(1, ratio)
        let size = windowSize()
        var frame = window.frame
        frame.origin.y += frame.height - size.height // keep the top edge in place
        frame.origin.x += (frame.width - size.width) / 2
        frame.size = size
        window.setFrame(frame, display: true)
        layout()
    }

    func hover(_ inside: Bool) {
        guard mirroringActive else { return }
        hideBar?.cancel()
        if inside || settingsVisible { return fadeBar(to: 1) }
        let work = DispatchWorkItem { [weak self] in self?.fadeBar(to: 0) }
        hideBar = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: work)
    }

    func fadeBar(to alpha: CGFloat) {
        guard mirroringActive, let bar, let window else { return }
        let generation = mirrorGeneration
        if alpha > 0 { bar.isHidden = false }
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.18
            bar.animator().alphaValue = alpha
        }, completionHandler: { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.mirroringActive, self.mirrorGeneration == generation else { return }
                if alpha == 0 { bar.isHidden = true }
                window.invalidateShadow()
            }
        })
    }

    func setAspect(width w: CGFloat, height h: CGFloat) {
        guard mirroringActive, let window, w.isFinite, h.isFinite, w > 0, h > 0,
              let visible = window.screen?.visibleFrame ?? NSScreen.main?.visibleFrame else { return }
        if abs(w / h - ratio) > 0.002 {
            trackingScroll = false; trackingMagnify = false
            nativeCall("nativeGeometryChanged")
            let center = CGPoint(x: window.frame.midX, y: window.frame.midY)
            ratio = w / h
            phoneHeight = MirrorGeometry.fittedHeight(aspect: ratio, preferredLongEdge: preferredPhoneLongEdge,
                available: visible.size, toolbar: barGap + barHeight)
            adjustingGeometry = true
            defer { adjustingGeometry = false }
            window.setFrame(MirrorGeometry.frame(center: center, height: phoneHeight, aspect: ratio,
                visible: visible, toolbar: barGap + barHeight), display: true)
            layout()
            trace("window-geometry", ["aspect": ratio, "width": window.frame.width,
                "height": phoneHeight, "preferredLongEdge": preferredPhoneLongEdge])
        }
        window.invalidateShadow()
    }

    // In MJPEG mode the page reports the stream's real size once the first frame arrives.
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard mirroringActive, message.webView === web, message.frameInfo.isMainFrame, let d = message.body as? [String: Any] else { return }
        let priorBridge = videoGate.bridgeID
        if let lifecycle = d["lifecycle"] as? String, let udid = d["deviceUdid"] as? String,
           let epoch = d["videoEpoch"] as? Int, let bridgeID = d["bridgeId"] as? String,
           let instance = d["serverInstance"] as? String, let revision = d["statusRevision"] as? Int {
            guard !retiredBridgeIDs.contains(bridgeID), serverInstance == nil || serverInstance == instance else { return }
            // An independently running server may be pinned to another phone.
            // Never show or enable input on it after a different row was chosen.
            if let requestedDeviceUDID, !udid.isEmpty, normalizeSerial(udid) != normalizeSerial(requestedDeviceUDID) {
                suspendLifecycle()
                loadingBorderState.detail = "This device is unavailable"
                return
            }
            guard applyLifecycle(lifecycle, udid: udid, singleUsbDevice: d["singleUsbDevice"] as? Bool ?? false,
                                 usbDevicePresent: d["usbDevicePresent"] as? Bool ?? false,
                                 epoch: epoch, bridgeID: bridgeID, instance: instance, statusRevision: revision,
                                 connectionID: d["usbConnectionID"] as? String ?? "") else { return }
            videoMode = d["videoMode"] as? String ?? "native"
        }
        guard d["bridgeId"] as? String == videoGate.bridgeID,
              d["videoEpoch"] as? Int == videoGate.epoch else { return }
        if priorBridge != videoGate.bridgeID { nativeCall("setNativeSettingsVisible", ready: settingsBlocksInput) }
        if let waiting = d["waitingForVideo"] as? Bool { waitingForVideo = waiting }
        if !waitingForVideo, captureLoading == false, loadingBorderState.phase != "live", deviceLifecycle == "ready" {
            trace("input-ready")
        }
        // Keep the native snapshot until the fallback has actually presented a
        // fresh frame, not merely announced that it is trying to connect.
        if videoMode == "stream", !waitingForVideo, deviceLifecycle == "ready" {
            usbRecovery.finish()
            loadingBorderState.snapshot = nil
        }
        if let detail = d["loadingDetail"] as? String { loadingBorderState.detail = detail }
        if let loading = d["loading"] as? Bool {
            pageLoading = loading
            updateLoadingBorder()
        }
        if videoMode == "stream", let w = d["w"] as? Double, let h = d["h"] as? Double {
            setAspect(width: w, height: h)
        }
    }

    // Settings is local UI: never let its clicks, scrolls or keyboard shortcuts
    // become phone input. Each window owns its overlay; permissions are shared.
    @objc func toggleSettings() { setSettingsVisible(!settingsVisible) }

    func setSettingsVisible(_ visible: Bool) {
        guard mirroringActive, settingsVisible != visible, let settingsHost else { return }
        settingsVisible = visible; settingsGeneration += 1
        let generation = settingsGeneration
        CapturePermissions.shared.inspect(sessionID, visible: visible)
        if visible { nativeCall("setNativeSettingsVisible", ready: true) }
        trackingScroll = false; trackingMagnify = false
        if visible { for index in [3, 4] { (barButtons[index] as? NSButton)?.isEnabled = false } }
        (barButtons[2] as? NSButton)?.contentTintColor = visible ? .labelColor : .secondaryLabelColor
        if visible {
            settingsState.snapshot = videoMode == "native" ? capture?.snapshot() : loadingBorderState.snapshot
            if videoMode == "stream" {
                web.takeSnapshot(with: nil) { [weak self] image, _ in
                    guard let self, self.mirroringActive, self.settingsVisible, self.settingsGeneration == generation else { return }
                    self.settingsState.snapshot = image ?? self.settingsState.snapshot
                }
            }
            settingsHost.isHidden = false
            loadingBorder.isHidden = true
            hideBar?.cancel(); fadeBar(to: 1)
            window.makeFirstResponder(settingsHost)
        }
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0 : 0.18
            settingsHost.animator().alphaValue = visible ? 1 : 0
        }, completionHandler: { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.mirroringActive, self.settingsGeneration == generation else { return }
                if !visible {
                    settingsHost.isHidden = true
                    self.loadingBorder.isHidden = false
                    self.nativeCall("setNativeSettingsVisible", ready: false)
                    for index in [3, 4] { (self.barButtons[index] as? NSButton)?.isEnabled = true }
                    self.settingsState.snapshot = nil
                    self.window.makeFirstResponder(self.web)
                }
            }
        })
    }

    func permissionsChanged() {
        guard mirroringActive else { return }
        let next = CapturePermissions.shared.snapshot, previous = permissionSnapshot
        permissionSnapshot = next
        capture?.setAudioEnabled(next.canPlayAudio)
        guard previous.camera != next.camera else { return }
        if !next.canCaptureVideo {
            if capture != nil || videoMode != "stream" { fallbackToStream() }
        } else {
            captureBudget = CaptureRetryBudget()
            nextNativeAttemptAt = 0
            if capture == nil, let captureUdid, deviceLifecycle == "ready" || deviceLifecycle == "connecting" {
                startCapture(udid: captureUdid, singleUsbDevice: singleUsbDevice)
            }
        }
    }

    // MARK: Video

    func startCapture(udid: String, singleUsbDevice: Bool) {
        guard mirroringActive else { return }
        CapturePermissions.shared.refresh()
        if CapturePermissions.shared.snapshot.blocksNativeCapture { fallbackToStream(); return }
        let now = ProcessInfo.processInfo.systemUptime
        guard captureBudget.beginAttempt(at: now) else {
            nextNativeAttemptAt = now + 30
            if capture != nil || videoMode != "stream" || captureLoading { fallbackToStream() }
            return
        }
        freezeVideo()
        stopCapture()
        captureLoading = true
        captureFailed = false
        captureStartedAt = now
        videoGate.requireFreshFrame(at: now)
        let c = PhoneCapture(audioVolume: audioVolume)
        c.connectedDevices = { [weak self] in self?.owner?.devices ?? [] }
        trace("capture-requested")
        c.onSize = { [weak self, weak c] size in
            guard let self, self.capture === c else { return }
            self.setAspect(width: size.width, height: size.height)
        }
        c.onFailure = { [weak self, weak c] in
            guard let self, self.capture === c else { return }
            self.recoverCapture()
        }
        c.onFrame = { [weak self, weak c] in
            guard let self, let c, self.capture === c else { return }
            trace("fresh-frame", ["sampleAt": c.lastFrameAt])
            self.checkVideoLifecycle()
        }
        c.awaitFreshFrame()
        videoHost.layer?.addSublayer(c.layer)
        c.layer.frame = videoHost.bounds
        capture = c
        nativeCall("useNativeVideo")
        updateLoadingBorder()
        c.start(udid: udid, singleUsbDevice: singleUsbDevice) { [weak self, weak c] ok in
            guard let self, self.capture === c else { return }
            if !ok {
                if CapturePermissions.shared.snapshot.blocksNativeCapture {
                    self.fallbackToStream()
                } else if c?.identityAmbiguous == true {
                    self.nativeIdentityDeferred = true
                    self.fallbackToStream()
                } else { self.recoverCapture() }
            }
            // A running session is not proof of video. The frame watchdog marks ready.
        }
    }

    func fallbackToStream() {
        freezeVideo()
        stopCapture()
        captureFailed = true
        captureLoading = false
        waitingForVideo = true
        nextNativeAttemptAt = nativeIdentityDeferred || CapturePermissions.shared.snapshot.blocksNativeCapture ? .infinity : ProcessInfo.processInfo.systemUptime + 30
        NSLog("iPortal video fallback; preserving last frame")
        nativeCall("startStream")
        updateLoadingBorder()
    }

    // A new document must establish its own observation epoch before input can
    // resume. Old evaluateJavaScript calls cannot bless the replacement page.
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        guard mirroringActive, webView === web else { return }
        if !videoGate.bridgeID.isEmpty { retiredBridgeIDs.insert(videoGate.bridgeID) }
        suspendLifecycle()
        pageLoading = true
        updateLoadingBorder()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard mirroringActive, webView === web else { return }
        navigationFailed(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard mirroringActive, webView === web else { return }
        navigationFailed(error)
    }

    func navigationFailed(_ error: Error) {
        guard mirroringActive else { return }
        guard (error as NSError).code != NSURLErrorCancelled, !terminating else { return }
        suspendLifecycle()
        webNeedsReload = true
        webRetryAt = ProcessInfo.processInfo.systemUptime + webBackoff
        webBackoff = min(30, webBackoff * 2)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard mirroringActive, webView === web else { return }
        suspendLifecycle()
        webNeedsReload = true
        webRetryAt = ProcessInfo.processInfo.systemUptime + webBackoff
        webBackoff = min(30, webBackoff * 2)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard mirroringActive, webView === web else { return }
        webHealthySince = ProcessInfo.processInfo.systemUptime
        if let latestServerStatus { deliverServerStatus(latestServerStatus) }
        // poll() reports the document token and either starts capture or requests
        // a fresh frame from the existing session. Do not bypass that handshake.
    }

    // MARK: Server

    func deliverServerStatus(_ json: String) {
        guard let token = try? JSONSerialization.data(withJSONObject: [videoGate.bridgeID]),
              let argument = String(data: token, encoding: .utf8), !videoGate.bridgeID.isEmpty else { return }
        js("if (typeof receiveServerStatus === 'function') { receiveServerStatus(\(json), ...\(argument)); }")
    }

    func subscribeToStatus() {
        guard mirroringActive, let port, statusEventTask == nil, !terminating else { return }
        let generation = mirrorGeneration
        statusEventTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled && !self.terminating && self.mirroringActive && self.mirrorGeneration == generation {
                do {
                    var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/events")!)
                    request.timeoutInterval = 15
                    let (bytes, response) = try await URLSession.shared.bytes(for: request)
                    guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
                    for try await line in bytes.lines {
                        try Task.checkCancellation()
                        guard self.mirroringActive, self.mirrorGeneration == generation else { break }
                        guard line.hasPrefix("data: ") else { continue }
                        let json = String(line.dropFirst(6))
                        guard let data = json.data(using: .utf8),
                              let status = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                              status["service"] as? String == "iportal", status["apiVersion"] as? Int == 2 else { continue }
                        self.lastServerEventAt = ProcessInfo.processInfo.systemUptime
                        if let instance = status["instanceId"] as? String, instance != self.serverInstance { self.ensureServer(); continue }
                        self.latestServerStatus = json
                        self.deliverServerStatus(json)
                    }
                } catch { /* Native watchdog probes and reloads a replaced server. */ }
                if Task.isCancelled || self.terminating || !self.mirroringActive || self.mirrorGeneration != generation { break }
                self.lastServerEventAt = 0
                self.ensureServer()
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    func ensureServer() {
        guard mirroringActive, !terminating, !serverStopping, !serviceProbeInFlight else { return }
        guard port != nil else {
            if ProcessInfo.processInfo.systemUptime >= serverRetryAt { startServer() }
            return
        }
        let generation = mirrorGeneration
        let owner = serverOwner
        serviceProbeInFlight = true
        probe { [weak self] up, instance in
            guard let self, self.mirroringActive, self.mirrorGeneration == generation else { return }
            self.serviceProbeInFlight = false
            guard self.serverOwner == owner else { self.ensureServer(); return }
            guard !self.terminating else { return }
            let now = ProcessInfo.processInfo.systemUptime
            if up {
                self.serverFailures = 0
                self.serverBackoff = 1
                let newInstance = self.serverInstance != instance
                self.serverInstance = instance
                self.subscribeToStatus()
                if self.webHealthySince > 0, now - self.webHealthySince > 30 { self.webBackoff = 1 }
                if (newInstance || self.webNeedsReload), now >= self.webRetryAt {
                    self.suspendLifecycle()
                    self.webNeedsReload = false
                    if let port = self.port { self.web.load(URLRequest(url: URL(string: "http://localhost:\(port)/?app=1&video=native&kind=\(self.kind.rawValue)")!)) }
                }
            } else {
                self.serverFailures += 1
                self.suspendLifecycle()
                self.webNeedsReload = true
                if let process = self.server, process.isRunning {
                    // Only terminate a process this app owns, after repeated
                    // failed lightweight health checks and a startup grace period.
                    if self.serverFailures >= 3, now - self.serverStartedAt > 8 {
                        process.terminate()
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
                        }
                    }
                } else if now >= self.serverRetryAt { self.startServer() }
            }
        }
    }

    func probe(_ done: @escaping @MainActor (Bool, String?) -> Void) {
        guard let port else { return done(false, nil) }
        let expectedOwner = serverOwner
        let expectedDevice = requestedDeviceUDID
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/health")!)
        req.timeoutInterval = 1
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            let health = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let up = (resp as? HTTPURLResponse)?.statusCode == 200 && health?["service"] as? String == "iportal" && health?["apiVersion"] as? Int == 2
                && health?["owner"] as? String == expectedOwner && health?["pinnedUdid"] as? String == expectedDevice
            let instance = health?["instanceId"] as? String
            DispatchQueue.main.async { done(up && instance != nil, instance) }
        }.resume()
    }

    func startServer() {
        guard mirroringActive, !terminating, !serverStopping, server?.isRunning != true else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: nodePath)
        guard let target = requestedDeviceUDID else { return }
        serverOwner = UUID().uuidString
        p.arguments = ["iportal.mjs", "--no-open", "--managed", "--owner", serverOwner,
                       "--port", "\(preferredPort)", "--wda-port", "0", "--mjpeg-port", "0",
                       "--udid", target, "--device-kind", kind.rawValue]
        p.currentDirectoryURL = URL(fileURLWithPath: repoPath)
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "\((nodePath as NSString).deletingLastPathComponent):/usr/bin:/bin:/usr/sbin:/sbin:\(env["PATH"] ?? "")"
        p.environment = env
        let sessionLog = logURL.deletingLastPathComponent().appendingPathComponent("iPortal-\(target).log")
        if !FileManager.default.fileExists(atPath: sessionLog.path) {
            FileManager.default.createFile(atPath: sessionLog.path, contents: nil)
        }
        let output = Pipe()
        serverPipe = output
        serverOutput = Data()
        p.standardOutput = output
        if let log = try? FileHandle(forWritingTo: sessionLog) {
            _ = try? log.seekToEnd()
            p.standardError = log
        }
        output.fileHandleForReading.readabilityHandler = { [weak self, weak p] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async {
                guard let self, let p, self.server === p, self.mirroringActive else { return }
                self.serverOutput.append(data)
                while let end = self.serverOutput.firstIndex(of: 10) {
                    let line = self.serverOutput.prefix(upTo: end)
                    self.serverOutput.removeSubrange(...end)
                    guard let ready = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                          ready["event"] as? String == "iportal-listening",
                          ready["owner"] as? String == self.serverOwner,
                          ready["udid"] as? String == self.requestedDeviceUDID,
                          let port = ready["port"] as? Int, (1...65535).contains(port) else { continue }
                    self.port = port
                    self.ensureServer()
                }
                if self.serverOutput.count > 65536 { self.serverOutput.removeAll() }
            }
        }
        p.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard let self, self.server === process, !self.terminating else { return }
                self.server = nil
                self.port = nil
                self.serverPipe?.fileHandleForReading.readabilityHandler = nil
                self.serverPipe = nil
                self.statusEventTask?.cancel(); self.statusEventTask = nil
                self.owner?.serverStopped(self)
                self.serverStopping = false
                guard self.mirroringActive else { return }
                self.serverRetryAt = ProcessInfo.processInfo.systemUptime + self.serverBackoff
                self.serverBackoff = min(30, self.serverBackoff * 2)
                self.suspendLifecycle()
                self.webNeedsReload = true
                self.ensureServer()
            }
        }
        do {
            try p.run()
            server = p
            serverStartedAt = ProcessInfo.processInfo.systemUptime
        } catch {
            serverRetryAt = ProcessInfo.processInfo.systemUptime + serverBackoff
            serverBackoff = min(30, serverBackoff * 2)
            NSLog("iPortal: couldn't start node: \(error)")
        }
    }

    // MARK: Actions

    func installScrollMonitor() {
        scrollMonitor = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel, .magnify]) { [weak self] event in
            MainActor.assumeIsolated {
                guard let self, self.mirroringActive, event.window === self.window else { return event }
                let point = self.web.convert(event.locationInWindow, from: nil)
                guard !self.settingsBlocksInput else { return event }
                guard self.web.bounds.contains(point) || self.trackingScroll || self.trackingMagnify else { return event }
                // Never also pass this event to WKWebView: its DOM wheel handler
                // would turn the same physical gesture into a second swipe.
                let magnifying = event.type == .magnify
                guard !event.phase.contains(.mayBegin) else { return nil }
                if !magnifying && (!event.momentumPhase.isEmpty || self.trackingMagnify) { return nil }
                let phase: String
                if event.phase.contains(.cancelled) { phase = "cancelled" }
                else if event.phase.contains(.ended) { phase = "ended" }
                else if event.phase.contains(.began) { phase = "began" }
                else if event.phase.isEmpty { phase = "none" }
                else { phase = "changed" }
                if magnifying {
                    if phase == "began" { self.trackingMagnify = true; self.trackingScroll = false }
                    if phase == "ended" || phase == "cancelled" { self.trackingMagnify = false }
                } else {
                    if phase == "began" { self.trackingScroll = true }
                    if phase == "ended" || phase == "cancelled" { self.trackingScroll = false }
                }
                guard self.deviceLifecycle == "ready", !self.videoGate.bridgeID.isEmpty,
                      self.web.bounds.width > 0, self.web.bounds.height > 0 else { return nil }
                let width = self.web.bounds.width, height = self.web.bounds.height
                let y = self.web.isFlipped ? point.y : height - point.y
                var payload: [String: Any] = ["x": min(1, max(0, point.x / width)),
                    "y": min(1, max(0, y / height)), "phase": phase]
                if magnifying {
                    payload["delta"] = event.magnification
                } else {
                    // AppKit deltas point up/left; DOM deltas point down/right.
                    // Non-precise mouse events are lines rather than pixels.
                    let hasPixelDelta = event.hasPreciseScrollingDeltas && (event.scrollingDeltaX != 0 || event.scrollingDeltaY != 0)
                    let scale: CGFloat = hasPixelDelta ? 1 : 16
                    let deltaX = hasPixelDelta ? event.scrollingDeltaX : event.deltaX
                    let deltaY = hasPixelDelta ? event.scrollingDeltaY : event.deltaY
                    payload["dx"] = -deltaX * scale / width
                    payload["dy"] = -deltaY * scale / height
                    payload["zoom"] = event.modifierFlags.contains(.command)
                }
                let args: [Any] = [payload, self.videoGate.epoch, self.videoGate.bridgeID]
                if let data = try? JSONSerialization.data(withJSONObject: args),
                   let json = String(data: data, encoding: .utf8) {
                    self.js("\(magnifying ? "nativePinch" : "nativeScroll")(...\(json))")
                }
                return nil
            }
        }
    }

    func js(_ code: String) { guard mirroringActive else { return }; web?.evaluateJavaScript(code, completionHandler: nil) }

    @objc func home() { guard !settingsBlocksInput else { return }; js("api('home')") }
    @objc func appSwitcher() { guard !settingsBlocksInput else { return }; js("api('shortcut', { name: 'switcher' })") }
    @objc func spotlight() { guard !settingsBlocksInput else { return }; js("api('shortcut', { name: 'spotlight' })") }
    @objc func notifications() { guard !settingsBlocksInput else { return }; js("api('shortcut', { name: 'notifications' })") }
    @objc func controlCenter() { guard !settingsBlocksInput else { return }; js("api('shortcut', { name: 'control' })") }
    @objc func closeWindow() { window?.close() }
    @objc func larger() { phoneHeight *= 1.1; resize() }
    @objc func smaller() { phoneHeight /= 1.1; resize() }
    @objc func actualSize() { phoneHeight = defaultPhoneHeight / max(1, ratio); resize() }

    @objc func pasteToPhone() {
        guard !settingsBlocksInput, let text = NSPasteboard.general.string(forType: .string), !text.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: ["text": text]),
              let json = String(data: data, encoding: .utf8) else { return }
        js("typed += (\(json)).text; flush()")
    }

    @objc func toggleAudio(_ item: NSMenuItem) {
        audioVolume = audioVolume > 0 ? 0 : 1
        capture?.setVolume(audioVolume)
        if audioVolume > 0, CapturePermissions.shared.snapshot.canCaptureVideo {
            Task { await CapturePermissions.shared.request(.microphone) }
        }
        item.state = audioVolume > 0 ? .on : .off
    }

    @objc func toggleOnTop(_ item: NSMenuItem) {
        guard let window else { return }
        window.level = window.level == .floating ? .normal : .floating
        item.state = window.level == .floating ? .on : .off
    }

}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {
    var sessions = DeviceSessionRegistry<MirrorSession>()
    var pending: MirrorSession?
    var retiring: [MirrorSession] = []
    var usbMonitor: PhoneUSBMonitor?
    var didLaunch = false
    var pendingRequests: [IPortalWatcherRequest] = []
    var wakeObserver: NSObjectProtocol?
    var allSessions: [MirrorSession] { sessions.values + (pending.map { [$0] } ?? []) }
    var activeSession: MirrorSession? {
        allSessions.first { $0.window === NSApp.keyWindow } ?? allSessions.first { $0.window === NSApp.mainWindow }
    }

    var devices: [IPortalUSBDevice] {
        let names = UserDefaults.standard.dictionary(forKey: "PhoneDeviceNames") as? [String: String] ?? [:]
        return (usbMonitor?.connectedDevices ?? []).map {
            IPortalUSBDevice(serial: $0.serial, name: names[deviceKey($0.serial)] ?? $0.name, kind: $0.kind)
        }
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Launch Services may retain the previous icon after an in-place update.
        // Read the bundled artwork directly so the running Dock tile stays current.
        if let iconURL = Bundle.main.url(forResource: "AppIcon", withExtension: "icns"),
           let icon = NSImage(contentsOf: iconURL) {
            NSApp.applicationIconImage = icon
        }
        if let fontURL = Bundle.main.url(forResource: "InterVariable", withExtension: "ttf", subdirectory: "Fonts") {
            CTFontManagerRegisterFontsForURL(fontURL as CFURL, .process, nil)
        }
        buildMenu()
        usbMonitor = PhoneUSBMonitor { [weak self] serial, attached in
            guard let self else { return }
            if attached, let pending = self.pending, let device = self.devices.first(where: { deviceKey($0.serial) == deviceKey(serial) }) {
                self.pending = nil
                self.sessions.insert(pending, for: serial)
                pending.bind(device)
                self.publishSessions()
            }
            self.sessions.session(for: serial)?.usbChanged(serial, attached: attached)
            self.allSessions.forEach { $0.captureInventoryChanged() }
        }
        didLaunch = true
        let requests = pendingRequests
        pendingRequests.removeAll()
        let event = NSAppleEventManager.shared().currentAppleEvent
        let login = event?.eventID == kAEOpenApplication && event?.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
        if !requests.isEmpty { requests.forEach(handleWatcherRequest) }
        else if ProcessInfo.processInfo.arguments.contains("--watcher-request") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
                if self?.allSessions.isEmpty == true { NSApp.terminate(nil) }
            }
        } else {
            if login || ProcessInfo.processInfo.arguments.contains("--background") {
                // Replacing the watcher waits for its previous process to exit.
                // Keep this headless owner alive until registration completes.
                IPortalWatcherService.prepare { [weak self] in
                    if self?.allSessions.isEmpty == true { NSApp.terminate(nil) }
                }
            } else { IPortalWatcherService.prepare(); startMirroring() }
        }
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.allSessions.forEach { $0.wake() } }
        }
    }
    func startMirroring(serial: String? = nil) {
        defer { publishSessions() }
        if serial == nil, let existing = activeSession ?? allSessions.first { existing.startMirroring(); return }
        let preferred = UserDefaults.standard.string(forKey: "MirrorDeviceUDID") ?? ""
        let device: IPortalUSBDevice?
        if let serial {
            if let existing = sessions.session(for: serial) { existing.startMirroring(); return }
            // Wait for the previous server to relinquish its device lease.
            guard !retiring.contains(where: { $0.requestedDeviceUDID.map(deviceKey) == deviceKey(serial) }) else { return }
            // A stale Play event must not start mirroring a different device.
            device = devices.first { deviceKey($0.serial) == deviceKey(serial) }
            guard device != nil else { return }
        } else { device = devices.first { deviceKey($0.serial) == deviceKey(preferred) } ?? devices.first }
        let session = pending ?? MirrorSession(owner: self)
        if let device {
            pending = nil
            sessions.insert(session, for: device.serial)
            session.bind(device)
        } else { pending = session }
        session.startMirroring()
        if allSessions.count > 1, let window = session.window {
            _ = window.cascadeTopLeft(from: NSPoint(x: window.frame.minX + 28 * CGFloat(allSessions.count - 1), y: window.frame.maxY - 28 * CGFloat(allSessions.count - 1)))
        }
    }
    func closed(_ session: MirrorSession) {
        if let target = session.requestedDeviceUDID { sessions.remove(session, for: target) }
        if pending === session { pending = nil }
        if session.server?.isRunning == true { retiring.append(session) }
        publishSessions()
    }
    func serverStopped(_ session: MirrorSession) {
        retiring.removeAll { $0 === session }
        publishSessions()
    }

    func publishSessions() {
        let states = (allSessions + retiring).compactMap { session -> IPortalMirrorSession? in
            guard let serial = session.requestedDeviceUDID else { return nil }
            guard session.mirroringActive || session.server?.isRunning == true else { return nil }
            return IPortalMirrorSession(serial: serial, name: session.deviceName, kind: session.kind,
                id: session.sessionID, phase: session.mirroringActive ? .mirroring : .stopping)
        }
        IPortalWatcher.publishSessions(states)
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { startMirroring(); return true }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func application(_ application: NSApplication, open urls: [URL]) {
        for request in urls.compactMap(IPortalWatcherRequest.init(url:)) {
            if didLaunch { handleWatcherRequest(request) } else { pendingRequests.append(request) }
        }
    }
    private func handleWatcherRequest(_ request: IPortalWatcherRequest) {
        switch request {
        case .mirror(let serial): IPortalWatcherService.prepare(); startMirroring(serial: serial)
        case .pause(let serial, let token):
            // An old button event must never close a replacement window.
            if let session = sessions.session(for: serial), session.sessionID == token { session.closeWindow() }
            publishSessions()
            if allSessions.isEmpty { NSApp.terminate(nil) }
        case .login(let enabled):
            IPortalWatcherService.setLoginEnabled(enabled) { [weak self] in
                if self?.allSessions.isEmpty == true { NSApp.terminate(nil) }
            }
        }
    }
    func applicationWillTerminate(_ notification: Notification) {
        let closing = allSessions + retiring
        for session in closing { session.terminating = true; session.stopMirroring() }
        publishSessions()
        usbMonitor?.stop()
        if let wakeObserver { NSWorkspace.shared.notificationCenter.removeObserver(wakeObserver) }
        let deadline = Date().addingTimeInterval(3)
        while closing.contains(where: { $0.server?.isRunning == true }) && Date() < deadline { usleep(50_000) }
        for session in closing { if let p = session.server, p.isRunning { kill(p.processIdentifier, SIGKILL) } }
    }
    @objc func toggleSettings() { activeSession?.toggleSettings() }
    @objc func home() { activeSession?.home() }
    @objc func appSwitcher() { activeSession?.appSwitcher() }
    @objc func spotlight() { activeSession?.spotlight() }
    @objc func notifications() { activeSession?.notifications() }
    @objc func controlCenter() { activeSession?.controlCenter() }
    @objc func closeWindow() { activeSession?.closeWindow() }
    @objc func larger() { activeSession?.larger() }
    @objc func smaller() { activeSession?.smaller() }
    @objc func actualSize() { activeSession?.actualSize() }
    @objc func pasteToPhone() { activeSession?.pasteToPhone() }
    @objc func toggleAudio(_ item: NSMenuItem) { activeSession?.toggleAudio(item) }
    @objc func toggleOnTop(_ item: NSMenuItem) { activeSession?.toggleOnTop(item) }
    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        let kind = activeSession?.kind.rawValue ?? "iPhone"
        if item.action == #selector(pasteToPhone) { item.title = "Paste to \(kind)" }
        if item.action == #selector(toggleAudio(_:)) { item.title = "Play \(kind) Audio" }
        if item.action == #selector(toggleAudio(_:)) { item.state = activeSession?.audioVolume ?? 0 > 0 ? .on : .off }
        if item.action == #selector(toggleOnTop(_:)) { item.state = activeSession?.window?.level == .floating ? .on : .off }
        return activeSession != nil
    }

    // MARK: Menu

    func buildMenu() {
        let main = NSMenu()
        func menu(_ title: String, _ items: [NSMenuItem]) {
            let m = NSMenu(title: title)
            items.forEach(m.addItem)
            let holder = NSMenuItem()
            holder.submenu = m
            main.addItem(holder)
        }
        func item(_ title: String, _ action: Selector, _ key: String = "", target: AnyObject? = nil) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
            i.target = target ?? self
            return i
        }
        menu("iPortal", [
            NSMenuItem(title: "About iPortal", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: ""),
            .separator(),
            item("Settings…", #selector(toggleSettings), ","),
            .separator(),
            NSMenuItem(title: "Hide iPortal", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"),
            NSMenuItem(title: "Quit iPortal", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"),
        ])
        menu("Edit", [item("Paste to iPhone", #selector(pasteToPhone), "v")])
        menu("View", [
            item("Home Screen", #selector(home), "1"),
            item("App Switcher", #selector(appSwitcher), "2"),
            item("Spotlight", #selector(spotlight), "3"),
            item("Notification Center", #selector(notifications)),
            item("Control Center", #selector(controlCenter)),
            .separator(),
            item("Larger", #selector(larger), "="),
            item("Smaller", #selector(smaller), "-"),
            item("Actual Size", #selector(actualSize), "0"),
            .separator(),
            { let i = item("Play iPhone Audio", #selector(toggleAudio(_:))); i.state = .on; return i }(),
        ])
        menu("Window", [
            NSMenuItem(title: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m"),
            item("Close", #selector(closeWindow), "w"),
            item("Keep on Top", #selector(toggleOnTop(_:))),
        ])
        NSApp.mainMenu = main
    }
}

@main
struct IPortalApp {
    @MainActor static func main() {
        if ProcessInfo.processInfo.arguments.contains("--watcher-status") {
            IPortalWatcherService.printStatus()
            return
        }
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }
}
