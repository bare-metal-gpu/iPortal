import Cocoa
import SwiftUI

@MainActor
private final class MenuBarState: ObservableObject {
    @Published var devices: [PortalDeviceRow] = []
    @Published var loginEnabled = false
    @Published var visible = false
    @Published var notchX: CGFloat = 150
    var height: CGFloat { CGFloat(max(1, devices.count) * 56 + 62) }
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
                let gradient = AngularGradient(colors: [.clear, .clear, .cyan.opacity(0.9), .purple,
                    .pink.opacity(0.9), .orange.opacity(0.65), .clear], center: .center, angle: .degrees(phase * 360))
                outline.stroke(gradient, lineWidth: 2.2).blur(radius: 3)
                    .overlay(outline.stroke(gradient, lineWidth: 1.2))
            }
            .allowsHitTesting(false).accessibilityHidden(true)
        } else {
            outline.stroke(.white.opacity(0.13), lineWidth: 1).allowsHitTesting(false)
        }
    }
}

private struct MirrorPopover: View {
    @ObservedObject var state: MenuBarState
    var start: (String) -> Void
    var setLogin: (Bool) -> Void
    var quit: () -> Void
    private var outline: NotchedOutline { NotchedOutline(notchX: state.notchX) }

    var body: some View {
        VStack(spacing: 0) {
            if state.devices.isEmpty {
                Text("No iPhone connected").font(.system(size: 13)).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity).frame(height: 56)
            } else {
                ForEach(state.devices) { device in
                    HStack(spacing: 12) {
                        Image(systemName: "iphone").font(.system(size: 23))
                            .foregroundStyle(.white.opacity(0.65)).accessibilityHidden(true)
                        Text(device.name).font(.system(size: 13, weight: .medium))
                            .foregroundStyle(.white.opacity(0.9)).lineLimit(1).help(device.name)
                        Spacer(minLength: 12)
                        Button { start(device.serial) } label: {
                            Image(systemName: "play.fill").font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(.white.opacity(device.available ? 0.85 : 0.3))
                                .frame(width: 30, height: 30)
                                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 9))
                                .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(.white.opacity(0.12), lineWidth: 0.5))
                        }
                        .buttonStyle(.plain).disabled(!device.available)
                        .help("Mirror \(device.name)").accessibilityLabel("Mirror \(device.name)")
                    }
                    .padding(.horizontal, 18).frame(height: 56)
                }
            }
            Divider().overlay(.white.opacity(0.04)).padding(.horizontal, 14)
            HStack {
                Spacer()
                Menu {
                    Toggle("Open at Login", isOn: Binding(get: { state.loginEnabled }, set: setLogin))
                    Divider()
                    Button("Quit iPhone Portal", action: quit)
                } label: { Image(systemName: "gearshape").frame(width: 24, height: 24) }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                .help("Settings").accessibilityLabel("Settings")
            }
            .padding(.horizontal, 12).frame(height: 34)
        }
        .padding(.top, 18).padding(.bottom, 10)
        .frame(width: 300, height: state.height)
        .background { outline.fill(.ultraThinMaterial).overlay(outline.fill(.black.opacity(0.68))) }
        .clipShape(outline)
        .overlay(outline.stroke(.white.opacity(0.12), lineWidth: 0.7))
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
    var onQuit: (() -> Void)?
    var onLogin: ((Bool) -> Void)?
    var isLoginEnabled: () -> Bool = { false }

    override init() {
        super.init()
        item.autosaveName = "iPhonePortal"
        item.button?.image = NSImage(systemSymbolName: "iphone", accessibilityDescription: "iPhone Portal")
        item.button?.image?.isTemplate = true
        item.button?.toolTip = "iPhone Portal"
        item.button?.target = self
        item.button?.action = #selector(clicked)
        item.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        panel.title = "Connected iPhones"
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
            setLogin: { [weak self] enabled in self?.setLoginEnabled(enabled) },
            quit: { [weak self] in self?.onQuit?() }))
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

    func update(devices: [PortalUSBDevice], mirroring: Bool) {
        deviceList.update(devices, at: ProcessInfo.processInfo.systemUptime)
        state.devices = deviceList.devices
        scheduleExpiry()
        item.button?.toolTip = mirroring ? "iPhone Portal — Mirroring" : "iPhone Portal"
        if state.visible { position() }
    }

    private func scheduleExpiry() {
        expiry?.cancel()
        guard let deadline = deviceList.nextExpiry else { expiry = nil; return }
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.deviceList.expire(at: ProcessInfo.processInfo.systemUptime)
            self.state.devices = self.deviceList.devices
            if self.state.visible { self.position() }
            self.scheduleExpiry()
        }
        expiry = work
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0, deadline - ProcessInfo.processInfo.systemUptime), execute: work)
    }

    private func position() {
        guard let button = item.button, let window = button.window, let screen = window.screen else { return }
        let anchor = window.convertToScreen(button.convert(button.bounds, to: nil))
        let width: CGFloat = 300, height = state.height
        let x = max(screen.frame.minX + 8, min(anchor.midX - width / 2, screen.frame.maxX - width - 8))
        state.notchX = anchor.midX - x
        panel.setFrame(NSRect(x: x, y: anchor.minY - height - 2, width: width, height: height), display: true)
        host.frame = NSRect(x: 0, y: 0, width: width, height: height)
        host.layoutSubtreeIfNeeded()
        panel.invalidateShadow()
    }

    func show(activate: Bool = false) {
        state.loginEnabled = isLoginEnabled()
        state.visible = true
        position()
        if activate { panel.makeKeyAndOrderFront(nil) } else { panel.orderFrontRegardless() }
        guard localMonitor == nil else { return }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .keyDown]) { [weak self] event in
            MainActor.assumeIsolated {
                guard let self else { return event }
                if self.menuTracking { return event }
                if event.type == .keyDown {
                    if event.keyCode == 53 { self.close(); return nil }
                } else if event.window !== self.panel && event.window !== self.item.button?.window && event.window?.level != .popUpMenu {
                    self.close()
                }
                return event
            }
        }
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            DispatchQueue.main.async { if self?.menuTracking == false { self?.close() } }
        }
    }

    func close() {
        state.visible = false
        panel.orderOut(nil)
        if let localMonitor { NSEvent.removeMonitor(localMonitor); self.localMonitor = nil }
        if let globalMonitor { NSEvent.removeMonitor(globalMonitor); self.globalMonitor = nil }
    }

    func stop() {
        close()
        expiry?.cancel()
        if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
        menuObservers.forEach(NotificationCenter.default.removeObserver)
        NSStatusBar.system.removeStatusItem(item)
    }

    @objc private func clicked() {
        if NSApp.currentEvent?.type == .rightMouseUp { showSettings() }
        else if panel.isVisible { close() }
        else { show(activate: true) }
    }

    private func showSettings() {
        close()
        let menu = NSMenu()
        let login = NSMenuItem(title: "Open at Login", action: #selector(toggleLogin), keyEquivalent: "")
        login.target = self
        login.state = isLoginEnabled() ? .on : .off
        menu.addItem(login)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit iPhone Portal", action: #selector(quitAll), keyEquivalent: "")
        quit.target = self
        menu.addItem(quit)
        item.menu = menu
        item.button?.performClick(nil)
        item.menu = nil
    }

    @objc private func toggleLogin() { setLoginEnabled(!isLoginEnabled()) }
    @objc private func quitAll() { onQuit?() }

    func refreshLoginStatus() { state.loginEnabled = isLoginEnabled() }

    private func setLoginEnabled(_ enabled: Bool) { onLogin?(enabled) }
}
