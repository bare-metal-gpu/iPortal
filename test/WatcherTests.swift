import Cocoa

// Compile the real WatcherDelegate with inert UI/discovery dependencies. No
// status item, phone process, login registration or application launch is used.
@MainActor enum IPortalStyle {
    static func registerFonts(in bundle: Bundle) {}
}

@MainActor enum IPortalWatcher {
    static let domain = "iportal-watcher-test-\(UUID().uuidString)"
    static let preferences = UserDefaults(suiteName: domain)!
    static let appURL = URL(fileURLWithPath: "/nonexistent-iportal-test")
    static let sessionsChanged = Notification.Name(domain + ".sessionsChanged")
    static var mainApplications: [NSRunningApplication] = []
    static var loginEnabled = true
    static func request(_ request: IPortalWatcherRequest) {}
    static func currentSessions() -> [IPortalMirrorSession] { [] }
}

@MainActor final class MirrorMenuBar {
    static var latest: MirrorMenuBar!
    var isLoginEnabled: (() -> Bool)?
    var onStart: ((String) -> Void)?
    var onPause: ((IPortalMirrorSession) -> Void)?
    var onShow: (() -> Void)?
    var onLogin: ((Bool) -> Void)?
    var onQuit: (() -> Void)?
    var shown: [Bool] = []
    var devices: [IPortalUSBDevice] = []
    var visible = false
    init() { Self.latest = self }
    func update(devices: [IPortalUSBDevice], sessions: [IPortalMirrorSession]) { self.devices = devices }
    func show(activate: Bool = false) { shown.append(activate); visible = true; onShow?() }
    func close() { visible = false }
    func stop() {}
}

@MainActor final class PhoneDeviceNames {
    static var latest: PhoneDeviceNames!
    var onUpdate: (() -> Void)?
    var refreshes = 0
    init(defaults: UserDefaults) { Self.latest = self }
    func name(for serial: String, fallback: String) -> String { fallback }
    func refresh(_ serials: Set<String>) { refreshes += 1 }
    func stop() {}
}

@MainActor final class PhoneUSBMonitor {
    static var latest: PhoneUSBMonitor!
    static var initialDevices: [IPortalUSBDevice] = []
    static var initialUSB: Set<String> = []
    var connectedDevices = PhoneUSBMonitor.initialDevices
    var usbSerials = PhoneUSBMonitor.initialUSB
    var connectedSerials: Set<String> { Set(connectedDevices.map(\.serial)) }
    let usbChanged: (String, Bool) -> Void
    let metadataChanged: () -> Void
    let changed: (String, Bool) -> Void
    init(usbChanged: @escaping (String, Bool) -> Void, metadataChanged: @escaping () -> Void,
         changed: @escaping (String, Bool) -> Void) {
        self.usbChanged = usbChanged; self.metadataChanged = metadataChanged; self.changed = changed
        Self.latest = self
    }
    func isUSBConnected(_ serial: String) -> Bool { usbSerials.contains(serial) }
    func stop() {}
}

@main struct WatcherTests {
    @MainActor static func main() {
        defer { IPortalWatcher.preferences.removePersistentDomain(forName: IPortalWatcher.domain) }
        let phone = IPortalUSBDevice(serial: "00008140-00000000000000A1", name: "Test Phone", transport: .wifi)
        let existingUSB = IPortalUSBDevice(serial: "00008140-00000000000000B2", name: "Existing Phone")
        PhoneUSBMonitor.initialDevices = [phone, existingUSB]
        PhoneUSBMonitor.initialUSB = [existingUSB.serial]
        let delegate = WatcherDelegate()
        delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        defer { delegate.applicationWillTerminate(Notification(name: NSApplication.willTerminateNotification)) }
        let menu = MirrorMenuBar.latest!, monitor = PhoneUSBMonitor.latest!

        if CommandLine.arguments.contains("--show-devices") {
            assert(menu.shown == [false], "explicit startup requests must still open the list")
            print("Explicit watcher device-list request passed.")
            return
        }
        assert(menu.shown.isEmpty, "login/restart with existing USB or Wi-Fi devices must stay silent")
        assert(menu.devices == [phone, existingUSB], "silent startup still populates the list")
        monitor.usbChanged(existingUSB.serial, true)
        assert(menu.shown.isEmpty, "initial USB inventory must not become a fresh plug-in")

        monitor.connectedDevices = [phone]
        monitor.usbSerials = []
        let names = PhoneDeviceNames.latest!
        let refreshes = names.refreshes
        // A locked phone's availability has no lock-state field. Both first
        // discovery and repeated loss/recovery must be silent unconditionally.
        for _ in 0..<4 {
            monitor.connectedDevices = []
            monitor.changed(phone.serial, false)
            assert(menu.devices.isEmpty)
            monitor.connectedDevices = [phone]
            monitor.changed(phone.serial, true)
            monitor.metadataChanged()
            names.onUpdate?()
            assert(menu.devices == [phone])
            assert(menu.shown.isEmpty, "Wi-Fi discovery, recovery and name updates must not open the list")
        }
        assert(names.refreshes > refreshes, "silent rediscovery must still refresh names")

        // USB is an independent invitation even when Wi-Fi already sees it.
        monitor.usbSerials = [phone.serial]
        monitor.usbChanged(phone.serial, true)
        assert(menu.shown == [false])
        menu.close()
        monitor.usbChanged(phone.serial, true)
        monitor.changed(phone.serial, false)
        monitor.changed(phone.serial, true)
        monitor.metadataChanged()
        assert(menu.shown == [false] && !menu.visible, "dismissal survives duplicate USB and discovery callbacks")

        // An attachment while the main app is open remains consumed after it
        // closes, and subsequent Wi-Fi recovery must not re-prompt either.
        IPortalWatcher.mainApplications = [.current]
        monitor.usbChanged("00008140-00000000000000C3", true)
        IPortalWatcher.mainApplications = []
        monitor.usbChanged("00008140-00000000000000C3", true)
        monitor.changed(phone.serial, true)
        assert(menu.shown == [false])
        monitor.usbChanged("00008140-00000000000000D4", true)
        assert(menu.shown == [false, false], "a new physical device still offers mirroring")

        menu.close()
        assert(delegate.applicationShouldHandleReopen(NSApplication.shared, hasVisibleWindows: false))
        assert(menu.shown == [false, false, true] && menu.visible, "explicit reopen still activates the list")
        monitor.changed(phone.serial, false)
        monitor.changed(phone.serial, true)
        assert(menu.shown == [false, false, true] && menu.visible, "background updates neither reopen nor dismiss a manually opened list")
        print("Watcher startup, Wi-Fi rediscovery, USB-only invitations and explicit reopening passed.")
    }
}
