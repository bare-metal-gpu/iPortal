// Retire the previous bundle identity through its own native login-item API.
// Run only after the replacement has built and passed signature verification.
import AppKit

let oldID = "com.yachty66.iphonemirror"
let newID = "com.baremetalgpu.iportal"
let oldApp = URL(fileURLWithPath: CommandLine.arguments[1])
let oldPreferences = UserDefaults(suiteName: oldID)!
let preferences = UserDefaults(suiteName: newID)!

func fail(_ message: String) -> Never {
    fputs("iPortal migration: \(message)\n", stderr)
    exit(1)
}

// Preserve owned settings; registration fingerprints belong to the old code.
if !preferences.bool(forKey: "IdentityMigrationCompleted") {
    for key in ["WatcherOpenAtLogin", "PhoneDeviceNames", "MirrorDeviceUDID"] {
        if preferences.object(forKey: key) == nil, let value = oldPreferences.object(forKey: key) {
            preferences.set(value, forKey: key)
        }
    }
    let previousWatcher = UserDefaults(suiteName: oldID + ".watcher")!
    let watcher = UserDefaults(suiteName: newID + ".watcher")!
    for (key, value) in previousWatcher.persistentDomain(forName: oldID + ".watcher") ?? [:]
        where key.hasPrefix("NSStatusItem") {
        let renamed = key.replacingOccurrences(of: "iPhonePortal", with: "iPortal")
        if watcher.object(forKey: renamed) == nil { watcher.set(value, forKey: renamed) }
    }
    preferences.synchronize()
    watcher.synchronize()
}

let config = NSWorkspace.OpenConfiguration()
config.activates = false
config.arguments = ["--watcher-request"]
var opened = false
NSWorkspace.shared.open([URL(string: "iphone-portal://login?enabled=0")!],
    withApplicationAt: oldApp, configuration: config) { _, error in
    if let error { fail(error.localizedDescription) }
    opened = true
}

func retired() -> Bool {
    let process = Process()
    let output = Pipe()
    process.executableURL = oldApp.appendingPathComponent("Contents/MacOS/iPhoneMirror")
    process.arguments = ["--watcher-status"]
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    guard (try? process.run()) != nil else { return false }
    let data = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0,
          let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let helper = state["helperStatus"] as? Int,
          let main = state["legacyMainAppStatus"] as? Int else { return false }
    return ![1, 2].contains(helper) && ![1, 2].contains(main)
}

let deadline = Date().addingTimeInterval(20)
var unregistered = false
while Date() < deadline {
    RunLoop.current.run(until: Date().addingTimeInterval(0.25))
    oldPreferences.synchronize()
    if opened && !oldPreferences.bool(forKey: "WatcherOpenAtLogin") && retired() {
        unregistered = true
        break
    }
}
guard unregistered else { fail("The previous login item did not stop; the installed app was preserved.") }
let apps = [oldID, oldID + ".watcher"].flatMap {
    NSRunningApplication.runningApplications(withBundleIdentifier: $0)
}
apps.forEach { _ = $0.terminate() }
let exitDeadline = Date().addingTimeInterval(5)
while apps.contains(where: { !$0.isTerminated }) && Date() < exitDeadline {
    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
}
guard apps.allSatisfy(\.isTerminated) else { fail("The previous app is still stopping; installation was left unchanged.") }
preferences.set(true, forKey: "IdentityMigrationCompleted")
preferences.synchronize()
print("Previous watcher retired; login preference and menu-bar position preserved.")
