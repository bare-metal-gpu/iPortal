import Cocoa
import IOKit

// Hardware notifications arrive before the next status poll and before the
// replacement CoreMediaIO video device is discoverable.
@MainActor
final class PhoneUSBMonitor {
    private var port: IONotificationPortRef?
    private var added: io_iterator_t = 0
    private var removed: io_iterator_t = 0
    private var serials: [UInt64: String] = [:]
    private var names: [String: String] = [:]
    private var kinds: [String: IPortalDeviceKind] = [:]
    private var paired: [String: PairedDeviceDescriptor] = [:]
    private(set) var pairedHealthy = false
    private var pairedFailures = 0
    private var pairedWatchdog: DispatchWorkItem?
    private var pairedRetry: DispatchWorkItem?
    private var pairedExpiry: DispatchWorkItem?
    private let isActive: (String) -> Bool
    private var pairedProcess: Process?
    private var pairedInput: Pipe?
    private var pairedOutput: Pipe?
    private var pairedBuffer = Data()
    // Android devices come from adb through the bundled server, the way paired
    // iPhones come from the native transport. Both are optional.
    private var android: [String: AndroidDeviceDescriptor] = [:]
    private var androidProcess: Process?
    private var androidInput: Pipe?
    private var androidOutput: Pipe?
    private var androidBuffer = Data()
    private var androidFailures = 0
    private var androidRetry: DispatchWorkItem?
    // The first inventory from a watcher lists what was already attached. Like
    // the initial USB scan, it is not a new cable connection.
    private var androidPrimed = false
    private var stopped = false
    private let changed: (String, Bool) -> Void
    private let usbChanged: (String, Bool) -> Void
    private let metadataChanged: () -> Void
    var usbSerials: Set<String> { Set(serials.values).union(android.values.filter(\.usb).map(\.serial)) }
    var connectedSerials: Set<String> { Set(connectedDevices.map(\.serial)) }
    private func key(_ value: String) -> String { value.lowercased().filter { $0.isLetter || $0.isNumber } }
    func isPaired(_ serial: String) -> Bool { paired[key(serial)]?.capabilities.control != .unavailable && paired[key(serial)] != nil }
    func descriptor(for serial: String) -> PairedDeviceDescriptor? { paired[key(serial)] }
    var usbDevices: [IPortalUSBDevice] { connectedDevices.filter { isUSBConnected($0.serial) } }
    func isUSBConnected(_ serial: String) -> Bool {
        serials.values.contains { key($0) == key(serial) } || android[key(serial)]?.usb == true
    }
    func transport(for serial: String) -> IPortalConnectionTransport? {
        connectedDevices.first { key($0.serial) == key(serial) }?.transport
    }
    var connectedDevices: [IPortalUSBDevice] {
        var devices = paired.filter { $0.value.capabilities.control != .unavailable }.mapValues {
            IPortalUSBDevice(serial: $0.udid, name: $0.name, kind: IPortalDeviceKind(rawValue: $0.kind)!,
                transport: IPortalConnectionTransport(rawValue: $0.transport)!)
        }
        for serial in Set(serials.values) where devices[key(serial)] == nil {
            devices[key(serial)] = IPortalUSBDevice(serial: serial, name: names[serial] ?? "iPhone", kind: kinds[serial] ?? .iPhone)
        }
        for (id, device) in android where devices[id] == nil {
            devices[id] = IPortalUSBDevice(serial: device.serial, name: device.name, kind: .android,
                transport: IPortalConnectionTransport(rawValue: device.transport)!)
        }
        return devices.values.sorted { $0.serial < $1.serial }
    }

    init(observeDevices: Bool = true, usbChanged: @escaping (String, Bool) -> Void = { _, _ in },
         metadataChanged: @escaping () -> Void = {}, isActive: @escaping (String) -> Bool = { _ in false }, changed: @escaping (String, Bool) -> Void) {
        self.isActive = isActive
        self.changed = changed
        self.usbChanged = usbChanged
        self.metadataChanged = metadataChanged
        guard observeDevices else { return }
        // Start on the next turn, after the owner has retained this monitor.
        DispatchQueue.main.async { [weak self] in self?.watchPairedDevices(); self?.watchAndroidDevices() }
        guard let port = IONotificationPortCreate(kIOMainPortDefault) else { return }
        self.port = port
        CFRunLoopAddSource(CFRunLoopGetMain(), IONotificationPortGetRunLoopSource(port).takeUnretainedValue(), .commonModes)
        let context = Unmanaged.passUnretained(self).toOpaque()
        func matching() -> CFDictionary {
            let match = IOServiceMatching("IOUSBHostDevice") as NSMutableDictionary
            match[kIOPropertyMatchKey] = ["idVendor": 0x05ac]
            return match
        }
        IOServiceAddMatchingNotification(port, kIOMatchedNotification, matching(), { context, iterator in
            MainActor.assumeIsolated {
                Unmanaged<PhoneUSBMonitor>.fromOpaque(context!).takeUnretainedValue().drain(iterator, attached: true)
            }
        }, context, &added)
        drain(added, attached: true, initial: true)
        IOServiceAddMatchingNotification(port, kIOTerminatedNotification, matching(), { context, iterator in
            MainActor.assumeIsolated {
                Unmanaged<PhoneUSBMonitor>.fromOpaque(context!).takeUnretainedValue().drain(iterator, attached: false)
            }
        }, context, &removed)
        drain(removed, attached: false, initial: true)
    }

    private func drain(_ iterator: io_iterator_t, attached: Bool, initial: Bool = false) {
        while case let service = IOIteratorNext(iterator), service != 0 {
            defer { IOObjectRelease(service) }
            var id: UInt64 = 0
            IORegistryEntryGetRegistryEntryID(service, &id)
            let serial = IORegistryEntryCreateCFProperty(service, "USB Serial Number" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? String
            guard let serial = serial ?? serials[id] else { continue }
            if attached {
                let product = IORegistryEntryCreateCFProperty(service, "USB Product Name" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? String
                guard let product, let kind = IPortalDeviceKind(product: product) else { continue }
                names[serial] = product
                kinds[serial] = kind
            } else if serials[id] == nil { continue }
            receiveUSB(serviceID: id, serial: serial, attached: attached, initial: initial)
        }
    }

    // Physical cable presence and overall reachability are different events.
    // The watcher needs the former even while Wi-Fi keeps the mirror alive.
    func receiveUSB(serviceID: UInt64, serial: String, attached: Bool, initial: Bool = false) {
        guard !stopped else { return }
        let before = isUSBConnected(serial)
        if attached { serials[serviceID] = serial } else { serials.removeValue(forKey: serviceID) }
        let after = isUSBConnected(serial)
        guard !initial, before != after else { return }
        usbChanged(serial, after)
        if !isPaired(serial) { changed(serial, after) }
    }

    func stop() {
        stopped = true
        pairedWatchdog?.cancel(); pairedRetry?.cancel(); pairedExpiry?.cancel()
        pairedHealthy = false
        pairedOutput?.fileHandleForReading.readabilityHandler = nil
        try? pairedInput?.fileHandleForWriting.close()
        if let pairedProcess, pairedProcess.isRunning { pairedProcess.terminate() }
        pairedProcess = nil; pairedInput = nil; pairedOutput = nil; paired.removeAll()
        androidRetry?.cancel()
        androidOutput?.fileHandleForReading.readabilityHandler = nil
        try? androidInput?.fileHandleForWriting.close()
        if let androidProcess, androidProcess.isRunning { androidProcess.terminate() }
        androidProcess = nil; androidInput = nil; androidOutput = nil; android.removeAll()
        if added != 0 { IOObjectRelease(added); added = 0 }
        if removed != 0 { IOObjectRelease(removed); removed = 0 }
        if let port { IONotificationPortDestroy(port); self.port = nil }
        serials.removeAll()
    }

    private func armWatchdog(_ seconds: TimeInterval) {
        pairedWatchdog?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.observerFailed() }
        pairedWatchdog = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }
    private func expireCache() {
        pairedExpiry = nil
        guard !stopped, !pairedHealthy else { return }
        replacePaired(paired.filter { isActive($0.value.udid) })
        if !paired.isEmpty { scheduleExpiry(after: 5) }
    }
    private func scheduleExpiry(after seconds: TimeInterval) {
        guard pairedExpiry == nil else { return }
        let work = DispatchWorkItem { [weak self] in self?.expireCache() }
        pairedExpiry = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }
    private func observerFailed() {
        guard !stopped else { return }
        pairedWatchdog?.cancel()
        pairedHealthy = false
        pairedFailures += 1
        let previous = pairedProcess
        pairedProcess = nil
        pairedOutput?.fileHandleForReading.readabilityHandler = nil
        try? pairedInput?.fileHandleForWriting.close()
        if previous?.isRunning == true { previous?.terminate() }
        scheduleExpiry(after: 30)
        pairedRetry?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.watchPairedDevices() }
        pairedRetry = work
        DispatchQueue.main.asyncAfter(deadline: .now() + min(30, pow(2, Double(min(pairedFailures, 5)))), execute: work)
    }
    private func watchPairedDevices() {
        guard !stopped, pairedProcess == nil else { return }
        let executable = IPortalWatcher.appURL.appendingPathComponent("Contents/MacOS/iPortalTransport")
        guard FileManager.default.isExecutableFile(atPath: executable.path) else { return }
        let task = Process(), input = Pipe(), output = Pipe()
        task.executableURL = executable; task.arguments = ["--watch"]
        task.standardInput = input; task.standardOutput = output; task.standardError = FileHandle.nullDevice
        pairedProcess = task; pairedInput = input; pairedOutput = output; pairedBuffer = Data()
        armWatchdog(10)
        output.fileHandleForReading.readabilityHandler = { [weak self, weak task] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async {
                guard let self, !self.stopped, let task, self.pairedProcess === task else { return }
                self.pairedBuffer.append(data)
                while let newline = self.pairedBuffer.firstIndex(of: 10) {
                    let line = Data(self.pairedBuffer[..<newline])
                    self.pairedBuffer = Data(self.pairedBuffer[(newline + 1)...])
                    guard self.receivePaired(line) else { self.observerFailed(); return }
                }
                if self.pairedBuffer.count > 65536 { self.observerFailed() }
            }
        }
        task.terminationHandler = { [weak self] task in
            DispatchQueue.main.async {
                guard let self, !self.stopped, self.pairedProcess === task else { return }
                self.observerFailed()
            }
        }
        do { try task.run() } catch { observerFailed() }
    }

    @discardableResult func receivePaired(_ data: Data) -> Bool {
        guard !stopped else { return false }
        guard let inventory = try? PairedInventory.decode(data) else { pairedHealthy = false; return false }
        pairedHealthy = true
        pairedFailures = 0
        pairedExpiry?.cancel(); pairedExpiry = nil
        if pairedProcess != nil { armWatchdog(30) }
        replacePaired(Dictionary(uniqueKeysWithValues: inventory.devices.map { ($0.key, $0) }))
        return true
    }
    private func replacePaired(_ next: [String: PairedDeviceDescriptor]) {
        let before = Dictionary(uniqueKeysWithValues: connectedDevices.map { (key($0.serial), $0) })
        let capabilitiesChanged = paired != next
        paired = next
        let after = Dictionary(uniqueKeysWithValues: connectedDevices.map { (key($0.serial), $0) })
        for (id, device) in before where after[id] == nil { changed(device.serial, false) }
        for (id, device) in after where before[id] == nil { changed(device.serial, true) }
        if before != after || capabilitiesChanged { metadataChanged() }
    }

    // MARK: Android

    private func androidObserverFailed() {
        guard !stopped else { return }
        androidFailures += 1
        let previous = androidProcess
        androidProcess = nil
        androidOutput?.fileHandleForReading.readabilityHandler = nil
        try? androidInput?.fileHandleForWriting.close()
        if previous?.isRunning == true { previous?.terminate() }
        // Without the inventory nothing is known to be reachable.
        replaceAndroid([:])
        androidRetry?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.watchAndroidDevices() }
        androidRetry = work
        DispatchQueue.main.asyncAfter(deadline: .now() + min(60, pow(2, Double(min(androidFailures, 6)))), execute: work)
    }
    private func watchAndroidDevices() {
        guard !stopped, androidProcess == nil else { return }
        let executable = IPortalWatcher.appURL.appendingPathComponent("Contents/MacOS/iportal-server")
        guard FileManager.default.isExecutableFile(atPath: executable.path) else { return }
        let task = Process(), input = Pipe(), output = Pipe()
        task.executableURL = executable
        // The lifetime supervisor ends the watcher when this process goes away.
        task.arguments = ["--owned-command", executable.path, "devices", "--platform", "android", "--watch"]
        task.standardInput = input; task.standardOutput = output; task.standardError = FileHandle.nullDevice
        androidProcess = task; androidInput = input; androidOutput = output; androidBuffer = Data()
        androidPrimed = false
        output.fileHandleForReading.readabilityHandler = { [weak self, weak task] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async {
                guard let self, !self.stopped, let task, self.androidProcess === task else { return }
                self.androidBuffer.append(data)
                while let newline = self.androidBuffer.firstIndex(of: 10) {
                    let line = Data(self.androidBuffer[..<newline])
                    self.androidBuffer = Data(self.androidBuffer[(newline + 1)...])
                    // Other output, such as a log line, is not inventory.
                    if line.first == UInt8(ascii: "{"), line.range(of: Data("\"devices\"".utf8)) != nil {
                        guard self.receiveAndroid(line) else { self.androidObserverFailed(); return }
                    }
                }
                if self.androidBuffer.count > 65536 { self.androidObserverFailed() }
            }
        }
        task.terminationHandler = { [weak self] task in
            DispatchQueue.main.async {
                guard let self, !self.stopped, self.androidProcess === task else { return }
                self.androidObserverFailed()
            }
        }
        do { try task.run() } catch { androidObserverFailed() }
    }

    @discardableResult func receiveAndroid(_ data: Data) -> Bool {
        guard !stopped else { return false }
        guard let inventory = try? AndroidInventory.decode(data) else { return false }
        androidFailures = 0
        replaceAndroid(Dictionary(uniqueKeysWithValues: inventory.devices.map { (key($0.serial), $0) }),
                       initial: !androidPrimed)
        androidPrimed = true
        return true
    }
    private func replaceAndroid(_ next: [String: AndroidDeviceDescriptor], initial: Bool = false) {
        guard android != next else { return }
        let before = Dictionary(uniqueKeysWithValues: connectedDevices.map { (key($0.serial), $0) })
        let cables = Set(usbSerials.map(key))
        android = next
        let after = Dictionary(uniqueKeysWithValues: connectedDevices.map { (key($0.serial), $0) })
        // Cable presence first, as for iPhones: it can invite mirroring even
        // when the phone was already reachable over Wi-Fi.
        if !initial {
            for (id, device) in next where device.usb && !cables.contains(id) { usbChanged(device.serial, true) }
            for id in cables where next[id]?.usb != true && before[id]?.kind == .android {
                usbChanged(before[id]!.serial, false)
            }
        }
        for (id, device) in before where after[id] == nil { changed(device.serial, false) }
        for (id, device) in after where before[id] == nil { changed(device.serial, true) }
        metadataChanged()
    }
}
