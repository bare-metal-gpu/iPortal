import Cocoa
import ServiceManagement
import Security

@MainActor
enum IPortalWatcher {
    static let appID = "com.baremetalgpu.iportal"
    static let helperID = "com.baremetalgpu.iportal.watcher"
    static let preferences: UserDefaults = Bundle.main.bundleIdentifier == appID
        ? .standard : UserDefaults(suiteName: appID)!
    static let settingsChanged = Notification.Name(helperID + ".settingsChanged")

    static var appURL: URL {
        if Bundle.main.bundleIdentifier == appID { return Bundle.main.bundleURL }
        return (0..<4).reduce(Bundle.main.bundleURL) { url, _ in url.deletingLastPathComponent() }
    }
    static var helperURL: URL { appURL.appendingPathComponent("Contents/Library/LoginItems/iPortal Watcher.app") }
    static var mainApplications: [NSRunningApplication] {
        NSRunningApplication.runningApplications(withBundleIdentifier: appID).filter {
            $0.bundleURL?.resolvingSymlinksInPath() == appURL.resolvingSymlinksInPath()
        }
    }
    static var loginEnabled: Bool {
        preferences.synchronize()
        return preferences.bool(forKey: "WatcherLoginEnabled")
    }

    static func request(_ request: IPortalWatcherRequest) {
        let config = NSWorkspace.OpenConfiguration()
        config.activates = { if case .mirror = request { return true }; return false }()
        config.arguments = ["--watcher-request"]
        NSWorkspace.shared.open([request.url], withApplicationAt: appURL, configuration: config) { _, error in
            if let error { NSLog("iPortal watcher could not open app: %@", error.localizedDescription) }
        }
    }
}

// Only the containing app registers its bundled login item. The helper asks it
// to change the setting without opening a mirror window or starting the server.
@MainActor
enum IPortalWatcherService {
    private static var service: SMAppService { .loginItem(identifier: IPortalWatcher.helperID) }

    static func printStatus() {
        let status: [String: Any] = ["helperStatus": service.status.rawValue,
            "legacyMainAppStatus": SMAppService.mainApp.status.rawValue,
            "openAtLogin": IPortalWatcher.preferences.bool(forKey: "WatcherOpenAtLogin"),
            "helperPIDs": NSRunningApplication.runningApplications(withBundleIdentifier: IPortalWatcher.helperID).map(\.processIdentifier)]
        if let data = try? JSONSerialization.data(withJSONObject: status, options: [.sortedKeys]),
           let json = String(data: data, encoding: .utf8) { print(json) }
    }

    static func prepare(completion: @escaping () -> Void = {}) {
        let legacy = SMAppService.mainApp.status
        let inherited = legacy == .enabled || legacy == .requiresApproval
        let desired = IPortalWatcher.preferences.object(forKey: "WatcherOpenAtLogin") as? Bool ?? inherited
        configure(enabled: desired, showDevicesAfterDisable: false, completion: completion)
    }

    static func setLoginEnabled(_ enabled: Bool, completion: @escaping () -> Void) {
        configure(enabled: enabled, showDevicesAfterDisable: !enabled, completion: completion)
    }

    private static var codeFingerprint: String? {
        var code: SecStaticCode?
        var info: CFDictionary?
        guard SecStaticCodeCreateWithPath(IPortalWatcher.helperURL as CFURL, [], &code) == errSecSuccess,
              let code, SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let data = (info as? [String: Any])?[kSecCodeInfoUnique as String] as? Data else { return nil }
        return data.base64EncodedString()
    }

    private static func configure(enabled: Bool, showDevicesAfterDisable: Bool, completion: @escaping () -> Void) {
        let fingerprint = codeFingerprint
        let needsUpdate = enabled && fingerprint != IPortalWatcher.preferences.string(forKey: "WatcherRegisteredCode")
        let removeRegistration = (service.status == .enabled && (!enabled || needsUpdate))
            || (service.status == .requiresApproval && !enabled)
        let previous = removeRegistration ? NSRunningApplication.runningApplications(withBundleIdentifier: IPortalWatcher.helperID).first(where: {
            $0.bundleURL?.resolvingSymlinksInPath() == IPortalWatcher.helperURL.resolvingSymlinksInPath()
        }) : nil
        do {
            if removeRegistration { try service.unregister() }
            afterExit(previous) { stopped in
                guard stopped else {
                    report(NSError(domain: "iPortalWatcher", code: 1, userInfo: [NSLocalizedDescriptionKey: "The previous watcher is still stopping."]))
                    completion()
                    return
                }
                do {
                    let registering = enabled && (service.status == .notRegistered || service.status == .notFound)
                    if registering { try service.register() }
                    IPortalWatcher.preferences.set(enabled, forKey: "WatcherOpenAtLogin")
                    if service.status == .enabled {
                        IPortalWatcher.preferences.set(fingerprint, forKey: "WatcherRegisteredCode")
                    }
                    let legacy = SMAppService.mainApp.status
                    if (legacy == .enabled || legacy == .requiresApproval) && (!enabled || service.status == .enabled) {
                        try SMAppService.mainApp.unregister()
                    }
                    publishStatus()
                    // register() itself launches the helper asynchronously.
                    if registering { completion() }
                    else { launch(showDevices: showDevicesAfterDisable, completion: completion) }
                } catch { report(error); completion() }
            }
        } catch { report(error); completion() }
    }

    private static func afterExit(_ app: NSRunningApplication?, completion: @escaping (Bool) -> Void) {
        guard let app, !app.isTerminated else { completion(true); return }
        var observer: NSObjectProtocol?
        var timeout: DispatchWorkItem?
        var finished = false
        let finish: (Bool) -> Void = { stopped in
            guard !finished else { return }
            finished = true
            if let observer { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
            observer = nil
            timeout?.cancel(); timeout = nil
            completion(stopped)
        }
        observer = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didTerminateApplicationNotification,
            object: nil, queue: .main) { note in
                MainActor.assumeIsolated {
                    if (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.processIdentifier == app.processIdentifier {
                        finish(true)
                    }
                }
            }
        let work = DispatchWorkItem { finish(app.isTerminated) }
        timeout = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: work)
        // Covers termination between unregister() and observer installation.
        if app.isTerminated { finish(true) }
    }

    private static func publishStatus() {
        IPortalWatcher.preferences.set(service.status == .enabled, forKey: "WatcherLoginEnabled")
        IPortalWatcher.preferences.synchronize()
        DistributedNotificationCenter.default().postNotificationName(IPortalWatcher.settingsChanged,
            object: IPortalWatcher.appURL.path, userInfo: nil, deliverImmediately: true)
        NSLog("iPortal watcher registration: %ld", service.status.rawValue)
    }

    private static func launch(showDevices: Bool = false, completion: @escaping () -> Void = {}) {
        guard service.status != .requiresApproval else {
            SMAppService.openSystemSettingsLoginItems()
            completion()
            return
        }
        if NSRunningApplication.runningApplications(withBundleIdentifier: IPortalWatcher.helperID).contains(where: {
            !$0.isTerminated && $0.bundleURL?.resolvingSymlinksInPath() == IPortalWatcher.helperURL.resolvingSymlinksInPath()
        }) { completion(); return }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = false
        config.arguments = showDevices ? ["--show-devices"] : ["--started-by-app"]
        NSWorkspace.shared.openApplication(at: IPortalWatcher.helperURL, configuration: config) { _, error in
            DispatchQueue.main.async {
                if let error { report(error) }
                completion()
            }
        }
    }

    private static func report(_ error: Error) {
        NSLog("iPortal watcher registration failed: %@", error.localizedDescription)
        let alert = NSAlert()
        alert.messageText = "Couldn’t start the menu-bar watcher"
        alert.informativeText = "Check iPortal in System Settings → General → Login Items."
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }
}
