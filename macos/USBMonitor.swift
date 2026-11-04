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
    private let changed: (String, Bool) -> Void
    var connectedSerials: Set<String> { Set(serials.values) }
    var connectedDevices: [IPortalUSBDevice] {
        connectedSerials.sorted().map { IPortalUSBDevice(serial: $0, name: names[$0] ?? "iPhone", kind: kinds[$0] ?? .iPhone) }
    }

    init(changed: @escaping (String, Bool) -> Void) {
        self.changed = changed
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
            if !initial { changed(serial, attached) }
        }
    }

    func stop() {
        if added != 0 { IOObjectRelease(added); added = 0 }
        if removed != 0 { IOObjectRelease(removed); removed = 0 }
        if let port { IONotificationPortDestroy(port); self.port = nil }
        serials.removeAll()
    }
}

