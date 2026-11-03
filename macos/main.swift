// Native Mac window for iPhone Portal, styled after Apple's iPhone Mirroring:
// a phone-shaped window with no chrome, and a slim bar above it that appears on hover.
// It starts mirror.mjs if it isn't already running. The screen comes from a direct USB capture of the iPhone
// (Capture.swift), with a transparent WKWebView on top that turns clicks and keys into touches. If the capture
// isn't available, the web view shows WebDriverAgent's MJPEG stream instead.
import Cocoa
import WebKit
import CoreText

let barHeight: CGFloat = 30
let barGap: CGFloat = 6
let defaultPhoneHeight: CGFloat = 844
let port = Int(ProcessInfo.processInfo.environment["IPHONE_MIRROR_PORT"] ?? "") ?? 7100
let info = Bundle.main.infoDictionary ?? [:]
let repoPath = info["IMRepoPath"] as? String ?? FileManager.default.currentDirectoryPath
let nodePath = info["IMNodePath"] as? String ?? "/opt/homebrew/bin/node"
let logURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/iPhoneMirror.log")

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
final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, NSWindowDelegate {
    var window: MirrorWindow!
    var phone: NSVisualEffectView!
    var videoHost: NSView!
    var web: WKWebView!
    var bar: DragBar!
    var barButtons: [NSView] = []
    var resizeHandles: [CornerResizeHandle] = []
    var server: Process?
    var ratio: CGFloat = 390 / 844
    var phoneHeight = defaultPhoneHeight
    var hideBar: DispatchWorkItem?
    var capture: PhoneCapture?
    var captureFailed = false
    let loadingBorderState = LoadingBorderState()
    var loadingBorder: LoadingBorderHost!
    var pageLoading = true
    var captureLoading = true
    var waitingForVideo = true
    var videoGate = VideoReadinessGate()
    var deviceLifecycle: String { videoGate.lifecycle }
    var captureUdid: String? { videoGate.deviceID }
    var activeCaptureUdid: String?
    var singleUsbDevice = false
    var lifecycleTimer: Timer?
    var lastStatusAt = ProcessInfo.processInfo.systemUptime
    var captureStartedAt: TimeInterval = 0
    var captureBudget = CaptureRetryBudget()
    var nextNativeAttemptAt: TimeInterval = 0
    var audioVolume: Float = 1
    var videoMode = "native"
    var serviceProbeInFlight = false
    var nextServiceProbeAt: TimeInterval = 0
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
    var wakeObserver: NSObjectProtocol?
    var retiredBridgeIDs: Set<String> = []
    var scrollMonitor: Any?
    var trackingScroll = false
    var trackingMagnify = false

    func updateLoadingBorder() {
        let phase: String
        if deviceLifecycle == "locked" || deviceLifecycle == "disconnected" { phase = deviceLifecycle }
        else if deviceLifecycle != "ready" || captureLoading || waitingForVideo { phase = "connecting" }
        else { phase = "live" }
        if videoMode == "native", phase != "live", loadingBorderState.phase == "live" {
            loadingBorderState.snapshot = capture?.snapshot() ?? loadingBorderState.snapshot
        }
        loadingBorderState.phase = phase
        loadingBorderState.showMessage = phase != "live"
        loadingBorderState.active = phase == "connecting" || (phase == "live" && pageLoading)
        if phase == "locked" { loadingBorderState.detail = "Unlock your iPhone to continue" }
        if phase == "disconnected" { loadingBorderState.detail = "Connect your iPhone" }
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
        nativeCall("setNativeVideoReady", ready: false)
    }

    func stopCapture() {
        capture?.stop()
        capture?.layer.removeFromSuperlayer()
        capture = nil
        activeCaptureUdid = nil
    }

    func applyLifecycle(_ next: String, udid: String?, singleUsbDevice: Bool,
                        epoch: Int, bridgeID: String, instance: String, statusRevision: Int) -> Bool {
        let now = ProcessInfo.processInfo.systemUptime
        self.singleUsbDevice = singleUsbDevice
        let change = videoGate.observe(next, deviceID: udid, epoch: epoch,
                                       bridgeID: bridgeID, serverInstance: instance, statusRevision: statusRevision, now: now)
        guard change.accepted else { return false }
        if change.newStatus { lastStatusAt = now }
        guard change.invalidated else { return true }
        captureBudget.failed()
        freezeVideo()
        if change.deviceChanged {
            // Never show the old device's pixels while control targets a new one.
            stopCapture()
            loadingBorderState.snapshot = nil
            captureFailed = false
            captureBudget = CaptureRetryBudget()
            nextNativeAttemptAt = 0
        }
        if deviceLifecycle != "ready" {
            if deviceLifecycle == "disconnected" { stopCapture() }
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
        guard !terminating else { return }
        let now = ProcessInfo.processInfo.systemUptime
        if now >= nextServiceProbeAt {
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
            if captureLoading {
                captureLoading = false
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
        freezeVideo()
        captureBudget.failed()
        stopCapture()
        if deviceLifecycle == "ready", let captureUdid {
            startCapture(udid: captureUdid, singleUsbDevice: singleUsbDevice)
        } else { updateLoadingBorder() }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let fontURL = Bundle.main.url(forResource: "InterVariable", withExtension: "ttf", subdirectory: "Fonts") {
            CTFontManagerRegisterFontsForURL(fontURL as CFURL, .process, nil)
        }
        buildMenu()
        buildWindow()
        installScrollMonitor()
        ensureServer()
        lifecycleTimer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.checkVideoLifecycle() }
        }
        if let lifecycleTimer { RunLoop.main.add(lifecycleTimer, forMode: .common) }
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.suspendLifecycle()
                self.stopCapture()
                self.webNeedsReload = true
                self.webRetryAt = 0
                self.ensureServer()
            }
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        terminating = true
        lifecycleTimer?.invalidate()
        if let scrollMonitor { NSEvent.removeMonitor(scrollMonitor) }
        if let wakeObserver { NSWorkspace.shared.notificationCenter.removeObserver(wakeObserver) }
        capture?.stop()
        guard let p = server, p.isRunning else { return }
        p.terminate()
        let deadline = Date().addingTimeInterval(3)
        while p.isRunning && Date() < deadline { usleep(50_000) }
    }

    // MARK: Window

    var maxPhoneHeight: CGFloat {
        guard let screen = window?.screen ?? NSScreen.main else { return 800 }
        return min(screen.visibleFrame.height - barHeight - barGap - 20,
                   (screen.visibleFrame.width - 20) / ratio)
    }

    func buildWindow() {
        phoneHeight = min(defaultPhoneHeight, maxPhoneHeight - 40)
        let size = windowSize()
        let vis = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        window = MirrorWindow(contentRect: NSRect(x: vis.midX - size.width / 2, y: vis.midY - size.height / 2, width: size.width, height: size.height),
                              styleMask: [.borderless, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "iPhone Portal"
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.isReleasedWhenClosed = false
        window.delegate = self

        let root = HoverView(frame: NSRect(origin: .zero, size: size))
        root.onHover = { [weak self] inside in self?.hover(inside) }
        window.contentView = root

        phone = NSVisualEffectView()
        phone.material = .hudWindow
        phone.blendingMode = .behindWindow
        phone.state = .active
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
        bar.material = .hudWindow
        bar.blendingMode = .behindWindow
        bar.state = .active
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
                      symbolButton("square.on.square", "App Switcher", #selector(appSwitcher)),
                      symbolButton("house", "Home", #selector(home))]
        barButtons.forEach(bar.addSubview)

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
        window.minSize = NSSize(width: (400 * ratio).rounded(), height: 400 + barGap + barHeight)
        window.maxSize = NSSize(width: (maxPhoneHeight * ratio).rounded(), height: maxPhoneHeight + barGap + barHeight)
        phone.frame = NSRect(x: 0, y: 0, width: w, height: phoneHeight)
        phone.layer?.cornerRadius = w * 0.14 // iPhone screen corner radius relative to its width
        web.frame = phone.bounds
        loadingBorder.frame = phone.bounds
        loadingBorderState.radius = max(0, w * 0.14 - 2)
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
        // Traffic lights on the left, Home and App Switcher on the right.
        let y = (barHeight - 16) / 2
        barButtons[0].frame = NSRect(x: 10, y: y + 1, width: 14, height: 14)
        barButtons[1].frame = NSRect(x: 30, y: y + 1, width: 14, height: 14)
        barButtons[2].frame = NSRect(x: w - 62, y: y, width: 22, height: 16)
        barButtons[3].frame = NSRect(x: w - 32, y: y, width: 22, height: 16)
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
        let height = max(400, min(proposedHeight, maxPhoneHeight))
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
        guard phone != nil, loadingBorder != nil, barButtons.count == 4 else { return }
        phoneHeight = window.frame.height - barGap - barHeight
        layout()
    }

    func resize() {
        phoneHeight = max(400, min(phoneHeight, maxPhoneHeight))
        let size = windowSize()
        var frame = window.frame
        frame.origin.y += frame.height - size.height // keep the top edge in place
        frame.origin.x += (frame.width - size.width) / 2
        frame.size = size
        window.setFrame(frame, display: true)
        layout()
    }

    func hover(_ inside: Bool) {
        hideBar?.cancel()
        if inside { return fadeBar(to: 1) }
        let work = DispatchWorkItem { [weak self] in self?.fadeBar(to: 0) }
        hideBar = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: work)
    }

    func fadeBar(to alpha: CGFloat) {
        if alpha > 0 { bar.isHidden = false }
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.18
            bar.animator().alphaValue = alpha
        }, completionHandler: { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                if alpha == 0 { self.bar.isHidden = true }
                self.window.invalidateShadow()
            }
        })
    }

    func setAspect(width w: CGFloat, height h: CGFloat) {
        guard w > 0, h > 0 else { return }
        if abs(w / h - ratio) > 0.002 { ratio = w / h; resize() }
        window.invalidateShadow()
    }

    // In MJPEG mode the page reports the stream's real size once the first frame arrives.
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let d = message.body as? [String: Any] else { return }
        if let lifecycle = d["lifecycle"] as? String, let udid = d["deviceUdid"] as? String,
           let epoch = d["videoEpoch"] as? Int, let bridgeID = d["bridgeId"] as? String,
           let instance = d["serverInstance"] as? String, let revision = d["statusRevision"] as? Int {
            guard !retiredBridgeIDs.contains(bridgeID), serverInstance == nil || serverInstance == instance else { return }
            videoMode = d["videoMode"] as? String ?? "native"
            if videoMode == "stream" { loadingBorderState.snapshot = nil }
            guard applyLifecycle(lifecycle, udid: udid, singleUsbDevice: d["singleUsbDevice"] as? Bool ?? false,
                                 epoch: epoch, bridgeID: bridgeID, instance: instance, statusRevision: revision) else { return }
        }
        guard d["bridgeId"] as? String == videoGate.bridgeID,
              d["videoEpoch"] as? Int == videoGate.epoch else { return }
        if let waiting = d["waitingForVideo"] as? Bool { waitingForVideo = waiting }
        if let detail = d["loadingDetail"] as? String { loadingBorderState.detail = detail }
        if let loading = d["loading"] as? Bool {
            pageLoading = loading
            updateLoadingBorder()
        }
        if let w = d["w"] as? Double, let h = d["h"] as? Double {
            setAspect(width: w, height: h)
        }
    }

    // MARK: Video

    func startCapture(udid: String, singleUsbDevice: Bool) {
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
        activeCaptureUdid = udid
        c.onSize = { [weak self, weak c] size in
            guard let self, self.capture === c else { return }
            self.setAspect(width: size.width, height: size.height)
        }
        c.onFailure = { [weak self, weak c] in
            guard let self, self.capture === c else { return }
            self.recoverCapture()
        }
        videoHost.layer?.addSublayer(c.layer)
        c.layer.frame = videoHost.bounds
        capture = c
        nativeCall("useNativeVideo")
        updateLoadingBorder()
        c.start(udid: udid, singleUsbDevice: singleUsbDevice) { [weak self, weak c] ok in
            guard let self, self.capture === c else { return }
            if !ok { self.recoverCapture() }
            // A running session is not proof of video. The frame watchdog marks ready.
        }
    }

    func fallbackToStream() {
        stopCapture()
        captureFailed = true
        captureLoading = false
        waitingForVideo = true
        nextNativeAttemptAt = ProcessInfo.processInfo.systemUptime + 30
        loadingBorderState.snapshot = nil
        nativeCall("startStream")
        updateLoadingBorder()
    }

    // A new document must establish its own observation epoch before input can
    // resume. Old evaluateJavaScript calls cannot bless the replacement page.
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        if !videoGate.bridgeID.isEmpty { retiredBridgeIDs.insert(videoGate.bridgeID) }
        suspendLifecycle()
        pageLoading = true
        updateLoadingBorder()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        navigationFailed(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        navigationFailed(error)
    }

    func navigationFailed(_ error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled, !terminating else { return }
        suspendLifecycle()
        webNeedsReload = true
        webRetryAt = ProcessInfo.processInfo.systemUptime + webBackoff
        webBackoff = min(30, webBackoff * 2)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        suspendLifecycle()
        webNeedsReload = true
        webRetryAt = ProcessInfo.processInfo.systemUptime + webBackoff
        webBackoff = min(30, webBackoff * 2)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webHealthySince = ProcessInfo.processInfo.systemUptime
        // poll() reports the document token and either starts capture or requests
        // a fresh frame from the existing session. Do not bypass that handshake.
    }

    // MARK: Server

    func ensureServer() {
        guard !terminating, !serviceProbeInFlight else { return }
        serviceProbeInFlight = true
        probe { [weak self] up, instance in
            guard let self else { return }
            self.serviceProbeInFlight = false
            guard !self.terminating else { return }
            let now = ProcessInfo.processInfo.systemUptime
            if up {
                self.serverFailures = 0
                self.serverBackoff = 1
                let newInstance = self.serverInstance != instance
                self.serverInstance = instance
                if self.webHealthySince > 0, now - self.webHealthySince > 30 { self.webBackoff = 1 }
                if (newInstance || self.webNeedsReload), now >= self.webRetryAt {
                    self.suspendLifecycle()
                    self.webNeedsReload = false
                    self.web.load(URLRequest(url: URL(string: "http://localhost:\(port)/?app=1&video=native")!))
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
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/health")!)
        req.timeoutInterval = 1
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            let health = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let up = (resp as? HTTPURLResponse)?.statusCode == 200 && health?["service"] as? String == "iphone-mirror" && health?["apiVersion"] as? Int == 2
            let instance = health?["instanceId"] as? String
            DispatchQueue.main.async { done(up && instance != nil, instance) }
        }.resume()
    }

    func startServer() {
        guard !terminating, server?.isRunning != true else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: nodePath)
        var arguments = ["mirror.mjs", "--no-open", "--port", "\(port)"]
        if let captureUdid { arguments += ["--udid", captureUdid] }
        p.arguments = arguments
        p.currentDirectoryURL = URL(fileURLWithPath: repoPath)
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "\((nodePath as NSString).deletingLastPathComponent):/usr/bin:/bin:/usr/sbin:/sbin:\(env["PATH"] ?? "")"
        p.environment = env
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        if let log = try? FileHandle(forWritingTo: logURL) {
            _ = try? log.seekToEnd()
            p.standardOutput = log
            p.standardError = log
        }
        p.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard let self, self.server === process, !self.terminating else { return }
                self.server = nil
                self.serverRetryAt = ProcessInfo.processInfo.systemUptime + self.serverBackoff
                self.serverBackoff = min(30, self.serverBackoff * 2)
                self.suspendLifecycle()
                self.webNeedsReload = true
            }
        }
        do {
            try p.run()
            server = p
            serverStartedAt = ProcessInfo.processInfo.systemUptime
        } catch {
            serverRetryAt = ProcessInfo.processInfo.systemUptime + serverBackoff
            serverBackoff = min(30, serverBackoff * 2)
            NSLog("iPhone Portal: couldn't start node: \(error)")
        }
    }

    // MARK: Actions

    func installScrollMonitor() {
        scrollMonitor = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel, .magnify]) { [weak self] event in
            MainActor.assumeIsolated {
                guard let self, event.window === self.window else { return event }
                let point = self.web.convert(event.locationInWindow, from: nil)
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

    func js(_ code: String) { web.evaluateJavaScript(code, completionHandler: nil) }

    @objc func home() { js("api('home')") }
    @objc func appSwitcher() { js("api('shortcut', { name: 'switcher' })") }
    @objc func spotlight() { js("api('shortcut', { name: 'spotlight' })") }
    @objc func notifications() { js("api('shortcut', { name: 'notifications' })") }
    @objc func controlCenter() { js("api('shortcut', { name: 'control' })") }
    @objc func closeWindow() { window.close() }
    @objc func larger() { phoneHeight *= 1.1; resize() }
    @objc func smaller() { phoneHeight /= 1.1; resize() }
    @objc func actualSize() { phoneHeight = defaultPhoneHeight; resize() }

    @objc func pasteToPhone() {
        guard let text = NSPasteboard.general.string(forType: .string), !text.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: ["text": text]),
              let json = String(data: data, encoding: .utf8) else { return }
        js("typed += (\(json)).text; flush()")
    }

    @objc func toggleAudio(_ item: NSMenuItem) {
        audioVolume = audioVolume > 0 ? 0 : 1
        capture?.audio.volume = audioVolume
        item.state = audioVolume > 0 ? .on : .off
    }

    @objc func toggleOnTop(_ item: NSMenuItem) {
        window.level = window.level == .floating ? .normal : .floating
        item.state = window.level == .floating ? .on : .off
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
        menu("iPhone Portal", [
            NSMenuItem(title: "About iPhone Portal", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: ""),
            .separator(),
            NSMenuItem(title: "Hide iPhone Portal", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"),
            NSMenuItem(title: "Quit iPhone Portal", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"),
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
struct IPhoneMirrorApp {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }
}
