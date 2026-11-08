import Cocoa

// No native transport process or real hardware observation is started here.
enum IPortalWatcher { static let appURL = URL(fileURLWithPath: "/nonexistent-iportal-test") }

@main
struct USBMonitorTests {
    @MainActor static func main() throws {
        let serial = "00008140-00000000000000A1"
        let usbSerial = "0000814000000000000000a1"
        var physical: [Bool] = [], availability: [Bool] = []
        var cableInvitations = USBInvitationGate()
        var now: TimeInterval = 0, cablePrompts = 0
        let monitor = PhoneUSBMonitor(observeDevices: false, usbChanged: { serial, attached in
            physical.append(attached)
            if attached {
                if cableInvitations.attached(serial, at: now) { cablePrompts += 1 }
            } else { cableInvitations.detached(serial, at: now) }
        }, changed: { _, attached in
            availability.append(attached)
        })
        defer { monitor.stop() }
        let row: [String: Any] = ["udid": serial, "name": "Test Phone", "kind": "iPhone", "transport": "wifi",
            "identifier": "fixture-1", "address": "fd00:1234::1", "osVersion": "27.3",
            "capabilities": ["control": "eligible", "video": "eligible", "audio": "eligible"]]
        let paired = try JSONSerialization.data(withJSONObject: ["version": 1, "devices": [row]])
        monitor.receivePaired(paired)
        assert(availability == [true] && physical.isEmpty)
        monitor.receiveUSB(serviceID: 1, serial: usbSerial, attached: true)
        assert(physical == [true] && cablePrompts == 1,
               "USB must offer mirroring even when Wi-Fi already discovered the phone")
        assert(availability == [true], "plug-in cannot restart a reachable paired mirror")
        assert(monitor.connectedDevices.count == 1 && monitor.isUSBConnected(serial))
        monitor.receiveUSB(serviceID: 1, serial: usbSerial, attached: true)
        monitor.receiveUSB(serviceID: 2, serial: usbSerial, attached: true)
        monitor.receiveUSB(serviceID: 1, serial: usbSerial, attached: false)
        assert(physical == [true], "duplicate services and partial removal do not create cable episodes")
        now = 1
        monitor.receiveUSB(serviceID: 2, serial: usbSerial, attached: false)
        assert(physical == [true, false] && availability == [true], "Wi-Fi survives physical USB removal")
        now = 4
        monitor.receiveUSB(serviceID: 3, serial: serial, attached: true)
        assert(cablePrompts == 2, "a subsequent cable connection can invite again while Wi-Fi stays reachable")
        monitor.receivePaired(paired)
        assert(cablePrompts == 2, "metadata refreshes cannot retrigger invitations")
        monitor.receivePaired(Data("{\"version\":1,\"devices\":[]}".utf8))
        assert(availability == [true], "USB keeps the device reachable when the paired route disappears")
        monitor.receiveUSB(serviceID: 3, serial: serial, attached: false)
        assert(availability == [true, false])
        monitor.receiveUSB(serviceID: 4, serial: serial, attached: true)
        assert(availability == [true, false, true], "USB-only reachability still follows the cable")
        var tablet = row; tablet["udid"] = "000000000000000000000002"; tablet["kind"] = "iPad"
        monitor.receivePaired(try JSONSerialization.data(withJSONObject: ["version": 1, "devices": [tablet]]))
        assert(monitor.connectedDevices.count == 2 && monitor.usbDevices.count == 1)
        assert(captureSourceID(for: serial, devices: monitor.usbDevices,
            sources: [CaptureSourceIdentity(id: "opaque-avfoundation-id", isIOS: true)], singleUSB: true) != nil)
        monitor.stop()
        assert(!monitor.receivePaired(paired) && monitor.connectedDevices.isEmpty)
        let fixtures = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [[String: Any]]
        for fixture in fixtures {
            let data = try JSONSerialization.data(withJSONObject: fixture["inventory"]!)
            let accepted = (try? PairedInventory.decode(data)) != nil
            assert(accepted == fixture["valid"] as! Bool, fixture["name"] as! String)
        }
        print("Shared inventory fixtures, mixed wireless/USB capture and stopped callbacks passed.")
        print("USB invitations survive paired discovery; duplicate services and route changes preserve session reachability.")
    }
}
