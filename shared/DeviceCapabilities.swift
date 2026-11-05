import Foundation
import Darwin

// Versioned wire contract shared by the CoreDevice producer and both Mac
// consumers. The Effect decoder uses the same fixtures as this decoder.
enum DeviceCapability: String, Codable { case eligible, supported, unavailable }
struct PairedCapabilities: Codable, Equatable {
    var control: DeviceCapability
    var video: DeviceCapability
    var audio: DeviceCapability
}
struct PairedDeviceDescriptor: Codable, Equatable {
    var udid: String
    var identifier: String
    var name: String
    var kind: String
    var transport: String
    var address: String
    var osVersion: String
    var capabilities: PairedCapabilities
    var key: String { udid.lowercased().replacingOccurrences(of: "-", with: "") }
    var mediaKey: String { "\(key):\(address):\(osVersion)" }
}
struct PairedInventory: Codable {
    var version = 1
    var devices: [PairedDeviceDescriptor]
    static func decode(_ data: Data) throws -> Self {
        guard data.count <= 65536 else { throw CocoaError(.coderReadCorrupt) }
        let value = try JSONDecoder().decode(Self.self, from: data)
        guard value.version == 1, value.devices.count <= 64 else { throw CocoaError(.coderReadCorrupt) }
        var keys = Set<String>()
        for device in value.devices {
            var ip = in6_addr()
            let validIP = device.address.withCString { inet_pton(AF_INET6, $0, &ip) } == 1
            let ula = withUnsafeBytes(of: ip) { $0[0] & 0xfe == 0xfc }
            guard [device.udid, device.identifier, device.name, device.address, device.osVersion].allSatisfy({ !$0.isEmpty && $0.utf16.count <= 256 }),
                  device.udid.range(of: "^[a-zA-Z0-9-]+\\z", options: .regularExpression) != nil,
                  !device.key.isEmpty, keys.insert(device.key).inserted,
                  device.osVersion.range(of: "^[0-9]+(\\.[0-9]+){0,2}\\z", options: .regularExpression) != nil,
                  ["iPhone", "iPad"].contains(device.kind), ["usb", "wifi"].contains(device.transport),
                  validIP, ula else { throw CocoaError(.coderReadCorrupt) }
            if (Int(device.osVersion.split(separator: ".")[0]) ?? 0) < 27,
               device.capabilities != PairedCapabilities(control: .unavailable, video: .unavailable, audio: .unavailable) {
                throw CocoaError(.coderReadCorrupt)
            }
        }
        return value
    }
}
