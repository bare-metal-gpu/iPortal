import Cocoa
import Darwin

@MainActor
final class WatcherDelegate: NSObject, NSApplicationDelegate {
    private var menuBar: MirrorMenuBar?
    private var usbMonitor: PhoneUSBMonitor?
    private let names = PhoneDeviceNames(defaults: PortalWatcher.preferences)
    private var invitations = USBInvitationGate()
    private var workspaceObservers: [NSObjectProtocol] = []
    private var settingsObserver: NSObjectProtocol?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Keep the user's status-item position during the one-time migration.
        for (key, value) in PortalWatcher.preferences.dictionaryRepresentation()
            where key.hasPrefix("NSStatusItem") && UserDefaults.standard.object(forKey: key) == nil {
            UserDefaults.standard.set(value, forKey: key)
        }
        menuBar = MirrorMenuBar()
        menuBar?.isLoginEnabled = { PortalWatcher.loginEnabled }
        menuBar?.onStart = { PortalWatcher.request(.mirror($0)) }
        menuBar?.onLogin = { PortalWatcher.request(.login($0)) }
        menuBar?.onQuit = {
            PortalWatcher.mainApplications.forEach { _ = $0.terminate() }
            NSApp.terminate(nil)
        }
        names.onUpdate = { [weak self] in self?.updateMenu() }
        usbMonitor = PhoneUSBMonitor { [weak self] serial, attached in self?.usbChanged(serial, attached: attached) }
        let now = ProcessInfo.processInfo.systemUptime
        for serial in usbMonitor?.connectedSerials ?? [] { _ = invitations.attached(serial, at: now) }
        updateMenu()
        names.refresh(usbMonitor?.connectedSerials ?? [])
        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification] {
            workspaceObservers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.updateMenu() }
            })
        }
        settingsObserver = DistributedNotificationCenter.default().addObserver(forName: PortalWatcher.settingsChanged,
            object: PortalWatcher.appURL.path, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.menuBar?.refreshLoginStatus() }
            }
        if ProcessInfo.processInfo.arguments.contains("--show-devices") ||
            (PortalWatcher.mainApplications.isEmpty && usbMonitor?.connectedDevices.isEmpty == false) {
            menuBar?.show()
        }
        NSLog("Portal watcher started: %d", ProcessInfo.processInfo.processIdentifier)
    }

    private func updateMenu() {
        let devices = (usbMonitor?.connectedDevices ?? []).map {
            PortalUSBDevice(serial: $0.serial, name: names.name(for: $0.serial, fallback: $0.name))
        }
        menuBar?.update(devices: devices, mirroring: !PortalWatcher.mainApplications.isEmpty)
    }

    private func usbChanged(_ serial: String, attached: Bool) {
        let now = ProcessInfo.processInfo.systemUptime
        let invite: Bool
        if attached { invite = invitations.attached(serial, at: now) }
        else { invitations.detached(serial, at: now); invite = false }
        updateMenu()
        if attached { names.refresh(usbMonitor?.connectedSerials ?? []) }
        if invite && PortalWatcher.mainApplications.isEmpty { menuBar?.show() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // Background launches from the main app must not flash the device list.
        if PortalWatcher.mainApplications.isEmpty { menuBar?.show(activate: true) }
        return true
    }
    func applicationWillTerminate(_ notification: Notification) {
        usbMonitor?.stop()
        names.stop()
        menuBar?.stop()
        workspaceObservers.forEach(NSWorkspace.shared.notificationCenter.removeObserver)
        if let settingsObserver { DistributedNotificationCenter.default().removeObserver(settingsObserver) }
    }
}

@main
struct PortalWatcherApp {
    @MainActor static func main() {
        // ServiceManagement and a foreground launch can arrive concurrently.
        // An atomic, process-lifetime lock prevents duplicate status items.
        let manager = FileManager.default
        guard let support = try? manager.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                            appropriateFor: nil, create: true) else { return }
        let directory = support.appendingPathComponent("iPhone Portal", isDirectory: true)
        do { try manager.createDirectory(at: directory, withIntermediateDirectories: true,
                                         attributes: [.posixPermissions: 0o700]) }
        catch { NSLog("Portal watcher cannot create its session lock: %@", error.localizedDescription); return }
        let descriptor = open(directory.appendingPathComponent("watcher.lock").path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { return }
        defer { close(descriptor) }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else { return }
        let app = NSApplication.shared
        let delegate = WatcherDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }
}
