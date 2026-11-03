import Foundation

// CoreDevice's local name inventory works while the phone is locked and does not
// launch a test runner. Query only on USB arrivals; cached names render immediately.
@MainActor
final class PhoneDeviceNames {
    private let defaults: UserDefaults
    private var names: [String: String]

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        names = defaults.dictionary(forKey: "PhoneDeviceNames") as? [String: String] ?? [:]
    }
    private var process: Process?
    private var requested = Set<String>()
    private var again = false
    var onUpdate: (() -> Void)?

    private func key(_ serial: String) -> String { serial.lowercased().filter { $0.isLetter || $0.isNumber } }
    func name(for serial: String, fallback: String) -> String { names[key(serial)] ?? fallback }

    func refresh(_ serials: Set<String>) {
        guard !serials.isEmpty else { return }
        requested = serials
        if process != nil { again = true; return }
        let wanted = Set(serials.map(key))
        let output = FileManager.default.temporaryDirectory.appendingPathComponent("iphone-portal-names-\(UUID().uuidString).json")
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        task.arguments = ["devicectl", "list", "devices", "--json-output", output.path]
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        let timeout = DispatchWorkItem { if task.isRunning { task.terminate() } }
        task.terminationHandler = { [weak self] task in
            task.terminationHandler = nil
            timeout.cancel()
            let data = try? Data(contentsOf: output)
            try? FileManager.default.removeItem(at: output)
            let result = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let devices = (result?["result"] as? [String: Any])?["devices"] as? [[String: Any]] ?? []
            var found: [String: String] = [:]
            for device in devices {
                guard let hardware = device["hardwareProperties"] as? [String: Any], hardware["reality"] as? String == "physical",
                      let udid = hardware["udid"] as? String,
                      let properties = device["deviceProperties"] as? [String: Any],
                      let name = properties["name"] as? String, !name.isEmpty else { continue }
                let key = udid.lowercased().filter { $0.isLetter || $0.isNumber }
                if wanted.contains(key) { found[key] = name }
            }
            let discovered = found
            DispatchQueue.main.async {
                guard let self, self.process === task else { return }
                self.process = nil
                self.names.merge(discovered) { _, new in new }
                self.defaults.set(self.names, forKey: "PhoneDeviceNames")
                self.onUpdate?()
                if self.again { self.again = false; self.refresh(self.requested) }
            }
        }
        do {
            try task.run()
            process = task
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 6, execute: timeout)
        } catch { try? FileManager.default.removeItem(at: output) }
    }

    func stop() {
        again = false
        if let process, process.isRunning { process.terminate() }
        process = nil
    }
}
