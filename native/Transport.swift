// Optional process boundary: a missing or incompatible Xcode framework can never
// prevent the normal app from launching. No Apple framework is redistributed.
import Foundation
import CoreDevice
import Darwin
import AppKit
import Network

func key(_ value: String) -> String { value.lowercased().filter { $0.isLetter || $0.isNumber } }
func descriptor(_ device: RemoteDevice) -> PairedDeviceDescriptor? {
    let info = device.deviceInfo
    guard info.state.rawValue == "connected" else { return nil }
    guard let udid = info.udid, let product = info.productType,
          product.hasPrefix("iPhone") || product.hasPrefix("iPad"),
          let version = info.osVersion, let major = Int(version.split(separator: ".").first ?? ""),
          let address = info.tunnelIPAddressString else { return nil }
    let transport: String
    switch info.iportalTransportType()?.rawValue {
    case "wired": transport = "usb"
    case "localNetwork": transport = "wifi"
    default: return nil
    }
    let eligibility: DeviceCapability = major >= 27 ? .eligible : .unavailable
    return PairedDeviceDescriptor(udid: udid, identifier: device.deviceIdentifier.uuidString,
        name: info.name ?? (product.hasPrefix("iPad") ? "iPad" : "iPhone"),
        kind: product.hasPrefix("iPad") ? "iPad" : "iPhone", transport: transport, address: address,
        osVersion: version, capabilities: PairedCapabilities(control: eligibility, video: eligibility, audio: eligibility))
}
func emitInventory() {
    let devices = DeviceManager.shared.allDevices().compactMap(descriptor).sorted { $0.key < $1.key }
    guard let data = try? JSONEncoder().encode(PairedInventory(devices: devices)),
          (try? PairedInventory.decode(data)) != nil else { return }
    try? FileHandle.standardOutput.write(contentsOf: data + Data([10]))
}

func emit(_ kind: UInt32, _ flags: UInt32, _ time: UInt32, _ data: Data) {
    guard data.count <= 8 * 1024 * 1024 else { return }
    var header = Data()
    for value in [kind, flags, time, UInt32(data.count)] {
        var big = value.bigEndian
        withUnsafeBytes(of: &big) { header.append(contentsOf: $0) }
    }
    do {
        try FileHandle.standardOutput.write(contentsOf: header)
        try FileHandle.standardOutput.write(contentsOf: data)
    } catch { exit(0) }
}

@main struct NativeTransport {
    @MainActor private static var observedDevices: [UUID: ObjectIdentifier] = [:]
    @MainActor private static func refreshInventory() {
        for device in DeviceManager.shared.allDevices() {
            let identity = ObjectIdentifier(device)
            guard observedDevices[device.deviceIdentifier] != identity else { continue }
            observedDevices[device.deviceIdentifier] = identity
            device.addDeviceInfoChangedHandler(on: .main) { _, _ in emitInventory() }
        }
        emitInventory()
    }
    @MainActor static func main() async {
        signal(SIGPIPE, SIG_IGN)
        let arguments = Array(CommandLine.arguments.dropFirst())
        // Also covers an ABI/framework hang before CoreDevice initialization.
        let initializationDeadline = DispatchWorkItem { exit(78) }
        DispatchQueue.global().asyncAfter(deadline: .now() + 8, execute: initializationDeadline)
        // EOF must cancel even while initialization or createSocket is pending.
        if !arguments.contains("--check") && !arguments.contains("--duration") {
            DispatchQueue.global().async { _ = try? FileHandle.standardInput.readToEnd(); exit(0) }
        }
        let manager = DeviceManager.shared
        await manager.awaitFullInitialization()
        initializationDeadline.cancel()
        if arguments == ["--check"] { emitInventory(); return }
        if arguments == ["--watch"] {
            manager.addDevicesAddedHandler(on: .main) { _ in MainActor.assumeIsolated { refreshInventory() } }
            manager.addDevicesChangedHandler(on: .main) { _ in MainActor.assumeIsolated { refreshInventory() } }
            refreshInventory()
            let path = NWPathMonitor()
            path.pathUpdateHandler = { _ in DispatchQueue.main.async { refreshInventory() } }
            path.start(queue: .global(qos: .utility))
            let wake = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification,
                object: nil, queue: .main) { _ in MainActor.assumeIsolated { refreshInventory() } }
            // Heartbeat and slow reconciliation are fallbacks; device events are primary.
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                refreshInventory()
            }
            path.cancel()
            NSWorkspace.shared.notificationCenter.removeObserver(wake)
            return
        }
        guard arguments.count >= 2, arguments[0] == "--stream",
              let device = manager.allDevices().first(where: { key($0.deviceInfo.udid ?? "") == key(arguments[1]) }),
              descriptor(device)?.capabilities.video != .unavailable, descriptor(device) != nil else { exit(2) }
        do {
            let socketDeadline = DispatchWorkItem { exit(75) }
            DispatchQueue.global().asyncAfter(deadline: .now() + 8, execute: socketDeadline)
            let socket: FileHandle = try await withCheckedThrowingContinuation { continuation in
                device.createSocket(toServiceNamed: "com.apple.coredevice.displayservice", completingOn: nil) {
                    continuation.resume(with: $0)
                }
            }
            socketDeadline.cancel()
            defer { try? socket.close() }
            if let value = descriptor(device), let data = try? JSONEncoder().encode(value) {
                emit(0, 0, 0, data)
            }
            var pair: [Int32] = [-1, -1]
            guard socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) == 0 else { exit(3) }
            let cancellationWriter = FileHandle(fileDescriptor: pair[1], closeOnDealloc: true)
            if arguments.count == 4, arguments[2] == "--duration", let seconds = Double(arguments[3]), seconds > 0, seconds <= 300 {
                DispatchQueue.global().asyncAfter(deadline: .now() + seconds) { try? cancellationWriter.close() }
            }
            let fd = dup(socket.fileDescriptor), cancelFD = pair[0]
            let result: Int32 = await withCheckedContinuation { continuation in
                DispatchQueue.global(qos: .userInteractive).async {
                    let result = iportal_media_run(fd, cancelFD, { _, kind, flags, time, bytes, count in
                        emit(kind, flags, time, count == 0 ? Data() : Data(bytes: bytes!, count: count))
                    }, nil)
                    continuation.resume(returning: result)
                }
            }
            withExtendedLifetime(cancellationWriter) {}
            if result != 0 { exit(4) }
        } catch { exit(3) }
    }
}
