// Native Mac window for iPhone Portal, styled after Apple's iPhone Mirroring:
// a phone-shaped window with no chrome, and a slim bar above it that appears on hover.
// It starts mirror.mjs if it isn't already running. The screen comes from a direct USB capture of the iPhone
// (Capture.swift), with a transparent WKWebView on top that turns clicks and keys into touches. If the capture
// isn't available, the web view shows WebDriverAgent's MJPEG stream instead.
import Cocoa
import WebKit

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

    func updateLoadingBorder() {
        loadingBorderState.active = pageLoading || captureLoading
        capture?.layer.isHidden = waitingForVideo || captureLoading
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        ensureServer()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
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
        capture?.layer.frame = phone.bounds
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
        if let waiting = d["waitingForVideo"] as? Bool { waitingForVideo = waiting }
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
        let c = PhoneCapture()
        c.onSize = { [weak self] size in self?.setAspect(width: size.width, height: size.height) }
        phone.layer?.insertSublayer(c.layer, at: 0) // underneath the transparent web view
        c.layer.frame = phone.bounds
        capture = c
        c.start(udid: udid, singleUsbDevice: singleUsbDevice) { [weak self] ok in
            guard let self else { return }
            self.captureLoading = false
            self.updateLoadingBorder()
            guard !ok else { return }
            NSLog("iPhone Portal: no direct screen capture, falling back to the MJPEG stream")
            self.capture?.layer.removeFromSuperlayer()
            self.capture = nil
            self.captureFailed = true
            self.js("startStream()")
        }
    }

    // If the capture failed while the page was still loading, switch it to the stream once it's there.
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        pageLoading = true
        updateLoadingBorder()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        pageLoading = false
        updateLoadingBorder()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        pageLoading = false
        updateLoadingBorder()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if captureFailed { js("startStream()") }
        if webView.url?.host == nil {
            pageLoading = false
            updateLoadingBorder()
        }
    }

    // MARK: Server

    func ensureServer() {
        probe { up, _, _ in
            if !up { self.startServer() }
            self.waitForServer(tries: up ? 1 : 60)
        }
    }

    func probe(_ done: @escaping @MainActor (Bool, String?, Bool) -> Void) {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/status")!)
        req.timeoutInterval = 1
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            let status = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let up = (resp as? HTTPURLResponse)?.statusCode == 200 && status?["service"] as? String == "iphone-mirror" && status?["apiVersion"] as? Int == 2
            let udid = (status?["device"] as? [String: Any])?["udid"] as? String
            let singleUsbDevice = (status?["captureIdentity"] as? [String: Any])?["singleUsbDevice"] as? Bool ?? false
            DispatchQueue.main.async { done(up, udid, singleUsbDevice) }
        }.resume()
    }

    func waitForServer(tries: Int) {
        probe { up, udid, singleUsbDevice in
            if up {
                if let udid { self.startCapture(udid: udid, singleUsbDevice: singleUsbDevice) } else { self.captureFailed = true; self.captureLoading = false }
                let video = self.captureFailed ? "" : "&video=native"
                self.web.load(URLRequest(url: URL(string: "http://localhost:\(port)/?app=1\(video)")!))
                return
            }
            if tries <= 1 {
                self.captureLoading = false
                self.web.loadHTMLString("""
                <body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;box-sizing:border-box;background:transparent;color:#aaa;font:13px -apple-system">
                Couldn't start the mirror server.<br><br>Log: ~/Library/Logs/iPhoneMirror.log</body>
                """, baseURL: nil)
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.waitForServer(tries: tries - 1) }
        }
    }

    func startServer() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: nodePath)
        p.arguments = ["mirror.mjs", "--no-open", "--port", "\(port)"]
        p.currentDirectoryURL = URL(fileURLWithPath: repoPath)
        var env = ProcessInfo.processInfo.environment
        // Apps launched from Finder get a minimal PATH; WDA's launcher needs node and xcodebuild.
        env["PATH"] = "\((nodePath as NSString).deletingLastPathComponent):/usr/bin:/bin:/usr/sbin:/sbin:\(env["PATH"] ?? "")"
        p.environment = env
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        if let log = try? FileHandle(forWritingTo: logURL) { p.standardOutput = log; p.standardError = log }
        do { try p.run(); server = p } catch { NSLog("iPhone Portal: couldn't start node: \(error)") }
    }

    // MARK: Actions

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
        guard let audio = capture?.audio else { return }
        audio.volume = audio.volume > 0 ? 0 : 1
        item.state = audio.volume > 0 ? .on : .off
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
