// Native Mac window for iPhone Mirroring EU, styled after Apple's iPhone Mirroring:
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
final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var window: MirrorWindow!
    var phone: NSView!
    var web: WKWebView!
    var bar: DragBar!
    var barButtons: [NSView] = []
    var server: Process?
    var ratio: CGFloat = 390 / 844
    var phoneHeight = defaultPhoneHeight
    var hideBar: DispatchWorkItem?
    var capture: PhoneCapture?
    var captureFailed = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        startCapture()
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

    var maxPhoneHeight: CGFloat { (window?.screen ?? NSScreen.main).map { $0.visibleFrame.height - barHeight - barGap - 20 } ?? 800 }

    func buildWindow() {
        phoneHeight = min(defaultPhoneHeight, maxPhoneHeight - 40)
        let size = windowSize()
        let vis = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        window = MirrorWindow(contentRect: NSRect(x: vis.midX - size.width / 2, y: vis.midY - size.height / 2, width: size.width, height: size.height),
                              styleMask: [.borderless, .miniaturizable], backing: .buffered, defer: false)
        window.title = "iPhone Mirroring EU"
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.isReleasedWhenClosed = false

        let root = HoverView(frame: NSRect(origin: .zero, size: size))
        root.onHover = { [weak self] inside in self?.hover(inside) }
        window.contentView = root

        phone = NSView()
        phone.wantsLayer = true
        phone.layer?.backgroundColor = NSColor.black.cgColor
        phone.layer?.masksToBounds = true
        phone.layer?.cornerCurve = .continuous
        root.addSubview(phone)

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "native")
        web = WKWebView(frame: .zero, configuration: config)
        web.setValue(false, forKey: "drawsBackground")
        web.navigationDelegate = self
        phone.addSubview(web)

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
        phone.frame = NSRect(x: 0, y: 0, width: w, height: phoneHeight)
        phone.layer?.cornerRadius = w * 0.14 // iPhone screen corner radius relative to its width
        web.frame = phone.bounds
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
        guard let d = message.body as? [String: Any], let w = d["w"] as? Double, let h = d["h"] as? Double else { return }
        setAspect(width: w, height: h)
    }

    // MARK: Video

    func startCapture() {
        let c = PhoneCapture()
        c.onSize = { [weak self] size in self?.setAspect(width: size.width, height: size.height) }
        phone.layer?.insertSublayer(c.layer, at: 0) // underneath the transparent web view
        c.layer.frame = phone.bounds
        capture = c
        c.start { [weak self] ok in
            guard let self, !ok else { return }
            NSLog("iPhone Mirroring EU: no direct screen capture, falling back to the MJPEG stream")
            self.capture?.layer.removeFromSuperlayer()
            self.capture = nil
            self.captureFailed = true
            self.js("startStream()")
        }
    }

    // If the capture failed while the page was still loading, switch it to the stream once it's there.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if captureFailed { js("startStream()") }
    }

    // MARK: Server

    func ensureServer() {
        probe { up in
            if !up { self.startServer() }
            self.waitForServer(tries: up ? 1 : 60)
        }
    }

    func probe(_ done: @escaping @MainActor (Bool) -> Void) {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/")!)
        req.timeoutInterval = 1
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            let up = (resp as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { done(up) }
        }.resume()
    }

    func waitForServer(tries: Int) {
        probe { up in
            if up {
                let video = self.captureFailed ? "" : "&video=native"
                self.web.load(URLRequest(url: URL(string: "http://localhost:\(port)/?app=1\(video)")!))
                return
            }
            if tries <= 1 {
                self.web.loadHTMLString("""
                <body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;box-sizing:border-box;background:#000;color:#999;font:13px -apple-system">
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
        do { try p.run(); server = p } catch { NSLog("iPhone Mirroring EU: couldn't start node: \(error)") }
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
        menu("iPhone Mirroring EU", [
            NSMenuItem(title: "About iPhone Mirroring EU", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: ""),
            .separator(),
            NSMenuItem(title: "Hide iPhone Mirroring EU", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"),
            NSMenuItem(title: "Quit iPhone Mirroring EU", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"),
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
