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
    private var paired: [String: IPortalUSBDevice] = [:]
    private var pairedProcess: Process?
    private var pairedInput: Pipe?
    private var pairedOutput: Pipe?
    private var pairedBuffer = Data()
    private var stopped = false
    private let changed: (String, Bool) -> Void
    private let metadataChanged: () -> Void
    var connectedSerials: Set<String> { Set(connectedDevices.map(\.serial)) }
    private func key(_ value: String) -> String { value.lowercased().filter { $0.isLetter || $0.isNumber } }
    func isPaired(_ serial: String) -> Bool { paired[key(serial)] != nil }
    func transport(for serial: String) -> IPortalConnectionTransport? {
        connectedDevices.first { key($0.serial) == key(serial) }?.transport
    }
    var connectedDevices: [IPortalUSBDevice] {
        var devices = paired
        for serial in Set(serials.values) where devices[key(serial)] == nil {
            devices[key(serial)] = IPortalUSBDevice(serial: serial, name: names[serial] ?? "iPhone", kind: kinds[serial] ?? .iPhone)
        }
        return devices.values.sorted { $0.serial < $1.serial }
    }

    init(metadataChanged: @escaping () -> Void = {}, changed: @escaping (String, Bool) -> Void) {
        self.changed = changed
        self.metadataChanged = metadataChanged
        // Start on the next turn, after the owner has retained this monitor.
        DispatchQueue.main.async { [weak self] in self?.watchPairedDevices() }
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
            if attached { serials[id] = serial } else { serials.removeValue(forKey: id) }
            if !initial, !isPaired(serial) { changed(serial, attached) }
        }
    }

    func stop() {
        stopped = true
        pairedOutput?.fileHandleForReading.readabilityHandler = nil
        try? pairedInput?.fileHandleForWriting.close()
        if let pairedProcess, pairedProcess.isRunning { pairedProcess.terminate() }
        pairedProcess = nil; pairedInput = nil; pairedOutput = nil; paired.removeAll()
        if added != 0 { IOObjectRelease(added); added = 0 }
        if removed != 0 { IOObjectRelease(removed); removed = 0 }
        if let port { IONotificationPortDestroy(port); self.port = nil }
        serials.removeAll()
    }

    private func watchPairedDevices() {
        guard !stopped else { return }
        let executable = IPortalWatcher.appURL.appendingPathComponent("Contents/MacOS/iPortalTransport")
        guard FileManager.default.isExecutableFile(atPath: executable.path) else { return }
        let task = Process(), input = Pipe(), output = Pipe()
        task.executableURL = executable; task.arguments = ["--watch"]
        task.standardInput = input; task.standardOutput = output; task.standardError = FileHandle.nullDevice
        pairedProcess = task; pairedInput = input; pairedOutput = output; pairedBuffer = Data()
        output.fileHandleForReading.readabilityHandler = { [weak self, weak task] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async {
                guard let self, self.pairedProcess === task else { return }
                self.pairedBuffer.append(data)
                guard self.pairedBuffer.count <= 65536 else { task?.terminate(); return }
                while let newline = self.pairedBuffer.firstIndex(of: 10) {
                    let line = Data(self.pairedBuffer[..<newline])
                    self.pairedBuffer = Data(self.pairedBuffer[(newline + 1)...])
                    self.receivePaired(line)
                }
            }
        }
        task.terminationHandler = { [weak self] task in
            DispatchQueue.main.async {
                guard let self, self.pairedProcess === task else { return }
                self.pairedProcess = nil
                self.receivePaired(Data("{\"devices\":[]}".utf8))
                DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in self?.watchPairedDevices() }
            }
        }
        do { try task.run() } catch { pairedProcess = nil }
    }

    private func receivePaired(_ data: Data) {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rows = root["devices"] as? [[String: String]], rows.count <= 64 else { return }
        let before = Dictionary(uniqueKeysWithValues: connectedDevices.map { (key($0.serial), $0) })
        var next: [String: IPortalUSBDevice] = [:]
        for row in rows {
            guard let serial = row["udid"], !serial.isEmpty, serial.count <= 256,
                  let name = row["name"], name.count <= 256,
                  let kind = row["kind"].flatMap(IPortalDeviceKind.init(rawValue:)),
                  let transport = row["transport"].flatMap(IPortalConnectionTransport.init(rawValue:)) else { return }
            next[key(serial)] = IPortalUSBDevice(serial: serial, name: name, kind: kind, transport: transport)
        }
        paired = next
        let after = Dictionary(uniqueKeysWithValues: connectedDevices.map { (key($0.serial), $0) })
        for (id, device) in before where after[id] == nil { changed(device.serial, false) }
        for (id, device) in after where before[id] == nil { changed(device.serial, true) }
        if before != after { metadataChanged() }
    }
}

