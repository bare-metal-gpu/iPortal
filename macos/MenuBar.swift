import Cocoa
import SwiftUI

// Compact upper-half iPhone, with alpha shading for the rim and Dynamic Island.
// A template lets AppKit adapt the same tonal detail to any menu-bar appearance.
private func portalMenuIcon() -> NSImage {
    let image = NSImage(size: NSSize(width: 20, height: 20), flipped: true) { _ in
        guard let context = NSGraphicsContext.current?.cgContext else { return false }
        context.saveGState()
        defer { context.restoreGState() }
        context.setLineWidth(1.6)
        context.setLineCap(.round)
        let outline = CGMutablePath()
        outline.move(to: CGPoint(x: 1.7, y: 17))
        outline.addLine(to: CGPoint(x: 1.7, y: 6.1))
        outline.addCurve(to: CGPoint(x: 4.8, y: 3), control1: CGPoint(x: 1.7, y: 4.39), control2: CGPoint(x: 3.09, y: 3))
        outline.addLine(to: CGPoint(x: 15.2, y: 3))
        outline.addCurve(to: CGPoint(x: 18.3, y: 6.1), control1: CGPoint(x: 16.91, y: 3), control2: CGPoint(x: 18.3, y: 4.39))
        outline.addLine(to: CGPoint(x: 18.3, y: 17))
        context.saveGState()
        context.addPath(outline)
        context.replacePathWithStrokedPath()
        context.clip()
        let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
            colors: [NSColor.black.cgColor, NSColor.black.withAlphaComponent(0.88).cgColor,
                     NSColor.black.withAlphaComponent(0.58).cgColor] as CFArray,
            locations: [0, 0.48, 1])!
        context.drawLinearGradient(gradient, start: CGPoint(x: 1, y: 2.2), end: CGPoint(x: 4.6, y: 17.8),
                                   options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
        context.restoreGState()
        context.setFillColor(NSColor.black.withAlphaComponent(0.65).cgColor)
        context.addPath(CGPath(roundedRect: CGRect(x: 6.5, y: 5.5, width: 7, height: 1.8),
                               cornerWidth: 0.9, cornerHeight: 0.9, transform: nil))
        context.fillPath()
        return true
    }
    image.isTemplate = true
    return image
}

@MainActor
private final class MenuBarState: ObservableObject {
    @Published var devices: [IPortalDeviceRow] = []
    @Published var sessions: [String: IPortalMirrorSession] = [:]
    @Published var presentation = PopoverPresentation()
    var visible: Bool { presentation.visible }
    @Published var notchX: CGFloat = 150
    var height: CGFloat { CGFloat(max(1, devices.count) * 56 + 30) }
}

private final class NotchedMaterialView: NSVisualEffectView {
    var notchX: CGFloat = 150 { didSet { needsLayout = true } }
    override var isFlipped: Bool { true }
    override func layout() {
        super.layout()
        let size = bounds.size
        guard size.width > 0, size.height > 0 else { return }
        let path = NotchedOutline(notchX: notchX).path(in: CGRect(origin: .zero, size: size)).cgPath
        maskImage = NSImage(size: size, flipped: true) { _ in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            context.addPath(path)
            context.setFillColor(NSColor.black.cgColor)
            context.fillPath()
            return true
        }
    }
}

private struct NotchedBackdrop: NSViewRepresentable {
    let notchX: CGFloat
    func makeNSView(context: Context) -> NotchedMaterialView {
        let view = NotchedMaterialView()
        configureIPortalMaterial(view)
        return view
    }
    func updateNSView(_ view: NotchedMaterialView, context: Context) { view.notchX = notchX }
}

// One path owns both the backdrop and the beam, including the arrow. Native
// NSPopover chrome cannot share its independently drawn notch with a view border.
private struct NotchedOutline: Shape {
    var notchX: CGFloat
    func path(in rect: CGRect) -> Path {
        let r: CGFloat = 14, top: CGFloat = 12
        let left = rect.minX + 2, right = rect.maxX - 2, bottom = rect.maxY - 2
        let tip = min(right - r - 14, max(left + r + 14, notchX))
        var p = Path()
        p.move(to: CGPoint(x: left + r, y: top))
        p.addLine(to: CGPoint(x: tip - 14, y: top))
        p.addQuadCurve(to: CGPoint(x: tip - 9, y: top - 3), control: CGPoint(x: tip - 11, y: top))
        p.addLine(to: CGPoint(x: tip - 2, y: 2))
        p.addQuadCurve(to: CGPoint(x: tip + 2, y: 2), control: CGPoint(x: tip, y: 0))
        p.addLine(to: CGPoint(x: tip + 9, y: top - 3))
        p.addQuadCurve(to: CGPoint(x: tip + 14, y: top), control: CGPoint(x: tip + 11, y: top))
        p.addLine(to: CGPoint(x: right - r, y: top))
        p.addQuadCurve(to: CGPoint(x: right, y: top + r), control: CGPoint(x: right, y: top))
        p.addLine(to: CGPoint(x: right, y: bottom - r))
        p.addQuadCurve(to: CGPoint(x: right - r, y: bottom), control: CGPoint(x: right, y: bottom))
        p.addLine(to: CGPoint(x: left + r, y: bottom))
        p.addQuadCurve(to: CGPoint(x: left, y: bottom - r), control: CGPoint(x: left, y: bottom))
        p.addLine(to: CGPoint(x: left, y: top + r))
        p.addQuadCurve(to: CGPoint(x: left + r, y: top), control: CGPoint(x: left, y: top))
        p.closeSubpath()
        return p
    }
}

private struct NotchedBeam: View {
    let outline: NotchedOutline
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        if active && !reduceMotion {
            TimelineView(.animation(minimumInterval: 1 / 30)) { context in
                let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 5) / 5
                let gradient = AngularGradient(colors: IPortalStyle.Palette.beam, center: .center, angle: .degrees(phase * 360))
                outline.stroke(gradient, lineWidth: 2.2).blur(radius: 3)
                    .overlay(outline.stroke(gradient, lineWidth: 1.2))
            }
            .allowsHitTesting(false).accessibilityHidden(true)
        } else {
            outline.stroke(IPortalStyle.Palette.border, lineWidth: 1).allowsHitTesting(false)
        }
    }
}

private struct MirrorPopover: View {
    @ObservedObject var state: MenuBarState
    var start: (String) -> Void
    var pause: (IPortalMirrorSession) -> Void
    private var outline: NotchedOutline { NotchedOutline(notchX: state.notchX) }

    var body: some View {
        VStack(spacing: 0) {
            if state.devices.isEmpty {
                Text("No device connected").font(IPortalStyle.Typography.body).foregroundStyle(IPortalStyle.Palette.secondary)
                    .frame(maxWidth: .infinity).frame(height: 56)
            } else {
                ForEach(state.devices) { device in
                    let session = state.sessions[deviceKey(device.serial)]
                    let enabled = session.map { $0.phase == .mirroring } ?? device.available
                    let label = session == nil ? "Mirror \(device.name)" : "Pause \(device.name)"
                    HStack(spacing: 12) {
                        Image(systemName: device.kind.symbol).font(.system(size: 23))
                            .foregroundStyle(IPortalStyle.Palette.secondary).accessibilityHidden(true)
                        Text(device.name).font(IPortalStyle.Typography.compactLabel)
                            .foregroundStyle(IPortalStyle.Palette.primary).lineLimit(1).help(device.name)
                        Spacer(minLength: 12)
                        IPortalWiFiIndicator(visible: state.visible && device.available && device.transport == .wifi)
                            .help(device.available && device.transport == .wifi ? "Available over Wi-Fi" : "")
                        Button {
                            if let session { pause(session) } else { start(device.serial) }
                        } label: {
                            Image(systemName: session == nil ? "play.fill" : "pause.fill").font(.system(size: 11, weight: .semibold))
                                .contentTransition(.symbolEffect(.replace))
                                .foregroundStyle(enabled ? IPortalStyle.Palette.primary : IPortalStyle.Palette.disabled)
                                .frame(width: 30, height: 30)
                                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 9))
                                .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(IPortalStyle.Palette.border, lineWidth: 0.5))
                        }
                        .buttonStyle(.plain).disabled(!enabled)
                        .help(label).accessibilityLabel(label)
                    }
                    .padding(.horizontal, 18).frame(height: 56)
                }
            }
        }
        .padding(.top, 20).padding(.bottom, 10)
        .frame(width: 300, height: state.height)
        .background { NotchedBackdrop(notchX: state.notchX).allowsHitTesting(false) }
        .overlay(outline.stroke(IPortalStyle.Palette.border, lineWidth: 0.7))
        .overlay(NotchedBeam(outline: outline, active: state.visible && !state.devices.isEmpty))
        .preferredColorScheme(.dark)
    }
}

private final class DevicePanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class MirrorMenuBar: NSObject {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private let panel = DevicePanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    private let state = MenuBarState()
    private var host: NSHostingView<MirrorPopover>!
    private var deviceList = USBDeviceListState()
    private var expiry: DispatchWorkItem?
    private var localMonitor: Any?
    private var globalMonitor: Any?
    private var screenObserver: NSObjectProtocol?
    private var menuObservers: [NSObjectProtocol] = []
    private var menuTracking = false
    var onStart: ((String) -> Void)?
    var onPause: ((IPortalMirrorSession) -> Void)?
    var onShow: (() -> Void)?
    var onQuit: (() -> Void)?
    var onLogin: ((Bool) -> Void)?
    var isLoginEnabled: () -> Bool = { false }

    override init() {
        super.init()
        item.autosaveName = "iPortal"
        item.button?.image = portalMenuIcon()
        item.button?.setAccessibilityLabel("iPortal")
        item.button?.toolTip = "iPortal"
        item.button?.target = self
        item.button?.action = #selector(clicked)
        item.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        panel.title = "Connected Devices"
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.level = .popUpMenu
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        panel.appearance = NSAppearance(named: .darkAqua)
        host = NSHostingView(rootView: MirrorPopover(state: state,
            start: { [weak self] serial in self?.close(); self?.onStart?(serial) },
            pause: { [weak self] session in self?.onPause?(session) }))
        host.sizingOptions = []
        panel.contentView = host
        screenObserver = NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
            object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { if self?.state.visible == true { self?.position() } }
            }
        for (notification, tracking) in [(NSMenu.didBeginTrackingNotification, true), (NSMenu.didEndTrackingNotification, false)] {
            menuObservers.append(NotificationCenter.default.addObserver(forName: notification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.menuTracking = tracking }
            })
        }
    }

    func update(devices: [IPortalUSBDevice], sessions: [IPortalMirrorSession]) {
        deviceList.update(devices, at: ProcessInfo.processInfo.systemUptime)
        state.sessions = Dictionary(sessions.map { (deviceKey($0.serial), $0) }, uniquingKeysWith: { _, latest in latest })
        refreshRows()
        scheduleExpiry()
        item.button?.toolTip = sessions.isEmpty ? "iPortal" : "iPortal — Mirroring"
        if state.visible { position() }
    }

    private func refreshRows() {
        var rows = deviceList.devices
        // An unplugged device still has a window that the user can pause.
        let listed = Set(rows.map { deviceKey($0.serial) })
        for session in state.sessions.values where !listed.contains(deviceKey(session.serial)) {
            rows.append(IPortalDeviceRow(serial: session.serial, name: session.name, available: false, kind: session.kind))
        }
        state.devices = rows.sorted { deviceKey($0.serial) < deviceKey($1.serial) }
    }

    private func scheduleExpiry() {
        expiry?.cancel()
        guard let deadline = deviceList.nextExpiry else { expiry = nil; return }
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.deviceList.expire(at: ProcessInfo.processInfo.systemUptime)
            self.refreshRows()
            if self.state.visible { self.position() }
            self.scheduleExpiry()
        }
        expiry = work
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0, deadline - ProcessInfo.processInfo.systemUptime), execute: work)
    }

    private var statusItemFrame: NSRect? {
        guard let button = item.button, let window = button.window else { return nil }
        return window.convertToScreen(button.convert(button.bounds, to: nil))
    }

    private func position() {
        guard let anchor = statusItemFrame, let screen = item.button?.window?.screen else { return }
        let width: CGFloat = 300, height = state.height
        let x = max(screen.frame.minX + 8, min(anchor.midX - width / 2, screen.frame.maxX - width - 8))
        state.notchX = anchor.midX - x
        panel.setFrame(NSRect(x: x, y: anchor.minY - height - 2, width: width, height: height), display: true)
        host.frame = NSRect(x: 0, y: 0, width: width, height: height)
        host.layoutSubtreeIfNeeded()
        panel.invalidateShadow()
    }

    func show(activate: Bool = false) {
        onShow?()
        _ = state.presentation.setVisible(true)
        panel.ignoresMouseEvents = false
        if !panel.isVisible { panel.alphaValue = 0 }
        position()
        if activate { panel.makeKeyAndOrderFront(nil) } else { panel.orderFrontRegardless() }
        animateAlpha(to: 1)
        guard localMonitor == nil else { return }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .keyDown]) { [weak self] event in
            MainActor.assumeIsolated {
                guard let self else { return event }
                if self.menuTracking { return event }
                if event.type == .keyDown {
                    if event.keyCode == 53 { self.close(); return nil }
                } else if event.window?.level != .popUpMenu {
                    self.dismissForOutsideClick()
                }
                return event
            }
        }
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            // AppKit invokes both event monitors on the main thread. Handle the
            // original mouse-down now; queuing it can race the button's mouse-up.
            MainActor.assumeIsolated { self?.dismissForOutsideClick() }
        }
    }

    private func dismissForOutsideClick() {
        // Menu-extra events may arrive through the global monitor, even though
        // the button belongs to this helper. Its own action owns the toggle.
        if dismissesPopoverMouseDown(at: NSEvent.mouseLocation, panel: panel.frame,
                                    statusItem: statusItemFrame, menuTracking: menuTracking) { close() }
    }

    private func animateAlpha(to alpha: CGFloat, completion: @escaping @MainActor () -> Void = {}) {
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0 : 0.16
            context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            panel.animator().alphaValue = alpha
        }, completionHandler: { MainActor.assumeIsolated { completion() } })
    }

    func close(animated: Bool = true) {
        guard state.visible || !animated else { return }
        let revision = state.presentation.setVisible(false)
        panel.ignoresMouseEvents = true
        if let localMonitor { NSEvent.removeMonitor(localMonitor); self.localMonitor = nil }
        if let globalMonitor { NSEvent.removeMonitor(globalMonitor); self.globalMonitor = nil }
        if animated {
            animateAlpha(to: 0) { [weak self] in
                guard let self, self.state.presentation.canFinishClosing(revision) else { return }
                self.panel.orderOut(nil)
            }
        } else { panel.alphaValue = 0; panel.orderOut(nil) }
    }

    func stop() {
        close(animated: false)
        expiry?.cancel()
        if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
        menuObservers.forEach(NotificationCenter.default.removeObserver)
        NSStatusBar.system.removeStatusItem(item)
    }

    @objc private func clicked() {
        if NSApp.currentEvent?.type == .rightMouseUp { showSettings() }
        else if state.visible { close() }
        else { show(activate: true) }
    }

    private func showSettings() {
        close(animated: false)
        let menu = NSMenu()
        let login = NSMenuItem(title: "Open at Login", action: #selector(toggleLogin), keyEquivalent: "")
        login.target = self
        login.state = isLoginEnabled() ? .on : .off
        menu.addItem(login)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit iPortal", action: #selector(quitAll), keyEquivalent: "")
        quit.target = self
        menu.addItem(quit)
        item.menu = menu
        item.button?.performClick(nil)
        item.menu = nil
    }

    @objc private func toggleLogin() { setLoginEnabled(!isLoginEnabled()) }
    @objc private func quitAll() { onQuit?() }

    private func setLoginEnabled(_ enabled: Bool) { onLogin?(enabled) }
}
