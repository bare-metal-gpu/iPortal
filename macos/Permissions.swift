import Cocoa
import AVFoundation
import Combine

enum CapturePermission: CaseIterable, Hashable {
    case camera, microphone
    var title: String { self == .camera ? "Camera" : "Microphone" }
    var symbol: String { self == .camera ? "video" : "speaker.wave.2" }
    var mediaType: AVMediaType { self == .camera ? .video : .audio }
    var settingsPane: String { self == .camera ? "Privacy_Camera" : "Privacy_Microphone" }
}

enum CaptureAuthorization: Equatable {
    case notDetermined, authorized, denied, restricted, unavailable
    init(_ status: AVAuthorizationStatus) {
        switch status {
        case .notDetermined: self = .notDetermined
        case .authorized: self = .authorized
        case .denied: self = .denied
        case .restricted: self = .restricted
        @unknown default: self = .unavailable
        }
    }
    var title: String {
        switch self {
        case .notDetermined: return "Not requested"
        case .authorized: return "Allowed"
        case .denied: return "Not allowed"
        case .restricted: return "Restricted by macOS"
        case .unavailable: return "Unavailable"
        }
    }
}

struct CapturePermissionSnapshot: Equatable {
    var camera: CaptureAuthorization
    var microphone: CaptureAuthorization
    subscript(_ permission: CapturePermission) -> CaptureAuthorization {
        permission == .camera ? camera : microphone
    }
    var canCaptureVideo: Bool { camera == .authorized }
    var canPlayAudio: Bool { canCaptureVideo && microphone == .authorized }
    var blocksNativeCapture: Bool { camera != .authorized && camera != .notDetermined }
}

// Authorization belongs to the signed Mac app, not an individual phone window.
// Read the OS every time; never persist a second, potentially stale permission bit.
@MainActor
final class CapturePermissions: ObservableObject {
    static let shared = CapturePermissions()
    static let didChange = Notification.Name("iPortal.capturePermissionsChanged")
    @Published private(set) var snapshot: CapturePermissionSnapshot
    @Published private(set) var requesting: Set<CapturePermission> = []
    private let readStatus: (CapturePermission) -> CaptureAuthorization
    private let ask: (CapturePermission) async -> Void
    private let showSettings: (CapturePermission) -> Void
    private var pending: [CapturePermission: Task<CaptureAuthorization, Never>] = [:]
    private var observers: [NSObjectProtocol] = []
    private var wakeObserver: NSObjectProtocol?
    private var inspecting: Set<UUID> = []
    private var refreshTimer: Timer?

    init(readStatus: @escaping (CapturePermission) -> CaptureAuthorization = {
        CaptureAuthorization(AVCaptureDevice.authorizationStatus(for: $0.mediaType))
    }, ask: @escaping (CapturePermission) async -> Void = {
        _ = await AVCaptureDevice.requestAccess(for: $0.mediaType)
    }, showSettings: @escaping (CapturePermission) -> Void = { permission in
        let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?" + permission.settingsPane)!
        if !NSWorkspace.shared.open(url) {
            NSWorkspace.shared.open(URL(fileURLWithPath: "/System/Applications/System Settings.app"))
        }
    }, monitorSystem: Bool = true) {
        self.readStatus = readStatus; self.ask = ask; self.showSettings = showSettings
        snapshot = CapturePermissionSnapshot(camera: readStatus(.camera), microphone: readStatus(.microphone))
        guard monitorSystem else { return }
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification,
            object: nil, queue: .main) { [weak self] _ in MainActor.assumeIsolated { self?.refresh() } })
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification,
            object: nil, queue: .main) { [weak self] _ in MainActor.assumeIsolated { self?.refresh() } }
    }

    func refresh() {
        let next = CapturePermissionSnapshot(camera: readStatus(.camera), microphone: readStatus(.microphone))
        guard next != snapshot else { return }
        snapshot = next
        NotificationCenter.default.post(name: Self.didChange, object: self)
    }

    @discardableResult
    func request(_ permission: CapturePermission) async -> CaptureAuthorization {
        refresh()
        guard snapshot[permission] == .notDetermined else { return snapshot[permission] }
        if let pending = pending[permission] { return await pending.value }
        requesting.insert(permission)
        let task = Task { @MainActor in
            await ask(permission)
            refresh()
            return snapshot[permission]
        }
        pending[permission] = task
        let result = await task.value
        pending[permission] = nil
        requesting.remove(permission)
        return result
    }

    func inspect(_ id: UUID, visible: Bool) {
        if visible { inspecting.insert(id); refresh() } else { inspecting.remove(id) }
        if inspecting.isEmpty { refreshTimer?.invalidate(); refreshTimer = nil }
        else if refreshTimer == nil {
            // AVFoundation has no public authorization-change notification.
            // Foreground/request events are primary; only open settings panels
            // use this fallback, including while System Settings is frontmost.
            let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.refresh() }
            }
            timer.tolerance = 0.25
            RunLoop.main.add(timer, forMode: .common)
            refreshTimer = timer
        }
    }

    func setEnabled(_ enabled: Bool, for permission: CapturePermission) async {
        refresh()
        guard enabled != (snapshot[permission] == .authorized) else { return }
        // A switch expresses intent, never a saved permission bit. macOS owns
        // grants and revocations; denied permissions cannot be prompted again.
        switch snapshot[permission] {
        case .notDetermined:
            if enabled { await request(permission) }
        case .authorized, .denied:
            showSettings(permission)
        case .restricted, .unavailable:
            break
        }
        refresh()
        // Reconcile AppKit's switch even when opening System Settings leaves
        // authorization unchanged. Do not show an optimistic fake permission.
        objectWillChange.send()
    }

    deinit {
        refreshTimer?.invalidate()
        observers.forEach(NotificationCenter.default.removeObserver)
        if let wakeObserver { NSWorkspace.shared.notificationCenter.removeObserver(wakeObserver) }
    }
}
