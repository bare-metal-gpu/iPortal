import Foundation
import CoreGraphics

enum MirrorWebOrigin {
    static func allows(_ url: URL?, port: Int?) -> Bool {
        guard let url, let port, url.scheme == "http", url.port == port,
              url.user == nil, url.password == nil else { return false }
        return ["localhost", "127.0.0.1"].contains(url.host ?? "") && url.path == "/"
    }
}

enum MirrorGeometry {
    static func fittedHeight(aspect: CGFloat, preferredLongEdge: CGFloat, available: CGSize, toolbar: CGFloat) -> CGFloat {
        let maximum = max(1, min(available.height - toolbar - 20, (available.width - 20) / aspect))
        return min(maximum, max(min(400 / max(1, aspect), maximum), preferredLongEdge / max(1, aspect)))
    }

    static func frame(center: CGPoint, height: CGFloat, aspect: CGFloat, visible: CGRect, toolbar: CGFloat) -> CGRect {
        let size = CGSize(width: (height * aspect).rounded(), height: height + toolbar)
        let limits = visible.insetBy(dx: 10, dy: 10)
        return CGRect(x: max(limits.minX, min(center.x - size.width / 2, limits.maxX - size.width)),
                      y: max(limits.minY, min(center.y - size.height / 2, limits.maxY - size.height)),
                      width: size.width, height: size.height)
    }
}

// Intent changes immediately; a closing panel remains on screen during its fade.
// An old completion must never hide a popup the user has since reopened.
struct PopoverPresentation {
    private(set) var visible = false
    private var revision = 0
    mutating func setVisible(_ visible: Bool) -> Int {
        revision += 1
        self.visible = visible
        return revision
    }
    func canFinishClosing(_ revision: Int) -> Bool { !visible && self.revision == revision }
}

func dismissesPopoverMouseDown(at point: CGPoint, panel: CGRect, statusItem: CGRect?, menuTracking: Bool) -> Bool {
    !menuTracking && !panel.contains(point) && !(statusItem?.contains(point) ?? false)
}

// Delivered directly to the containing app with NSWorkspace. No global URL
// handler, shell interpolation, or durable command queue is needed.
enum IPortalWatcherRequest: Equatable {
    case mirror(String)
    case pause(String, session: UUID)
    case login(Bool)

    init?(url: URL) {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "iportal", parts.path.isEmpty,
              parts.user == nil, parts.password == nil, parts.port == nil,
              parts.fragment == nil, let items = parts.queryItems else { return nil }
        if parts.host == "pause" {
            guard items.count == 2, Set(items.map(\.name)) == ["serial", "session"],
                  let serial = items.first(where: { $0.name == "serial" })?.value,
                  Self.validSerial(serial),
                  let token = items.first(where: { $0.name == "session" })?.value,
                  let session = UUID(uuidString: token) else { return nil }
            self = .pause(serial, session: session)
            return
        }
        guard items.count == 1 else { return nil }
        switch (parts.host, items[0].name, items[0].value) {
        case ("mirror", "serial", .some(let serial)):
            guard Self.validSerial(serial) else { return nil }
            self = .mirror(serial)
        case ("login", "enabled", "1"): self = .login(true)
        case ("login", "enabled", "0"): self = .login(false)
        default: return nil
        }
    }

    private static func validSerial(_ serial: String) -> Bool {
        (8...64).contains(serial.count) && serial.allSatisfy { $0.isASCII && ($0.isHexDigit || $0 == "-") }
    }

    var url: URL {
        var parts = URLComponents()
        parts.scheme = "iportal"
        switch self {
        case .mirror(let serial):
            parts.host = "mirror"
            parts.queryItems = [URLQueryItem(name: "serial", value: serial)]
        case .pause(let serial, let session):
            parts.host = "pause"
            parts.queryItems = [URLQueryItem(name: "serial", value: serial), URLQueryItem(name: "session", value: session.uuidString)]
        case .login(let enabled):
            parts.host = "login"
            parts.queryItems = [URLQueryItem(name: "enabled", value: enabled ? "1" : "0")]
        }
        return parts.url!
    }
}

func deviceKey(_ serial: String) -> String { serial.lowercased().filter { $0.isLetter || $0.isNumber } }

enum IPortalDeviceKind: String, Codable {
    case iPhone, iPad
    init?(product: String) {
        if product.hasPrefix("iPhone") { self = .iPhone }
        else if product.hasPrefix("iPad") { self = .iPad }
        else { return nil }
    }
    var symbol: String { self == .iPad ? "ipad" : "iphone" }
    var initialRatio: CGFloat { self == .iPad ? 3 / 4 : 390 / 844 }
    func radius(width: CGFloat, height: CGFloat) -> CGFloat {
        min(width, height) * (self == .iPad ? 0.035 : 0.14)
    }
}

struct IPortalMirrorSession: Codable, Equatable {
    enum Phase: String, Codable { case mirroring, stopping }
    let serial: String
    let name: String
    let kind: IPortalDeviceKind
    let id: UUID
    let phase: Phase
}

// A persisted snapshot is useful when the watcher starts after the app. Only
// accept it while its exact owning process is alive, including its launch date.
// PID reuse, crashes and missed termination notifications cannot revive it.
struct IPortalSessionSnapshot: Codable {
    let pid: Int32
    let launchedAt: TimeInterval
    let sessions: [IPortalMirrorSession]

    func liveSessions(owners: [Int32: TimeInterval]) -> [IPortalMirrorSession] {
        guard let started = owners[pid], abs(started - launchedAt) < 0.001 else { return [] }
        return sessions
    }
}

// One owner per physical device, independent of USB spelling or enumeration ID.
// Removal is identity-checked: a delayed close cannot remove a replacement.
struct DeviceSessionRegistry<Session: AnyObject> {
    private var sessions: [String: Session] = [:]
    var values: [Session] { Array(sessions.values) }
    func session(for serial: String) -> Session? { sessions[deviceKey(serial)] }
    mutating func insert(_ session: Session, for serial: String) { sessions[deviceKey(serial)] = session }
    mutating func remove(_ session: Session, for serial: String) {
        if sessions[deviceKey(serial)] === session { sessions.removeValue(forKey: deviceKey(serial)) }
    }
}

struct IPortalUSBDevice: Identifiable, Equatable {
    let serial: String
    let name: String
    var kind: IPortalDeviceKind = .iPhone
    var id: String { serial }
}

struct CaptureSourceIdentity {
    let id: String
    let isIOS: Bool
}

// Display names can be duplicated, renamed, or stale. They are never identity.
// Never assume the sole camera belongs to one of several attached devices.
func captureSourceID(for target: String, devices: [IPortalUSBDevice], sources: [CaptureSourceIdentity],
                     singleUSB: Bool) -> String? {
    let expected = deviceKey(target)
    if let exact = sources.first(where: { deviceKey($0.id) == expected }) { return exact.id }
    let ios = sources.filter(\.isIOS)
    if singleUSB, devices.count == 1, deviceKey(devices[0].serial) == expected, ios.count == 1 { return ios[0].id }
    return nil
}

struct IPortalDeviceRow: Identifiable, Equatable {
    let serial: String
    let name: String
    var available: Bool
    var kind: IPortalDeviceKind = .iPhone
    var id: String { serial }
}

// Keep the label through brief USB enumeration gaps, but disable its action
// immediately. Repeated updates must not extend a genuinely removed row's life.
struct USBDeviceListState {
    private var rows: [String: IPortalDeviceRow] = [:]
    private var deadlines: [String: TimeInterval] = [:]
    var devices: [IPortalDeviceRow] { rows.values.sorted { $0.serial < $1.serial } }
    var nextExpiry: TimeInterval? { deadlines.values.min() }

    mutating func update(_ devices: [IPortalUSBDevice], at now: TimeInterval) {
        let connected = Set(devices.map(\.serial))
        for device in devices {
            rows[device.serial] = IPortalDeviceRow(serial: device.serial, name: device.name, available: true, kind: device.kind)
            deadlines.removeValue(forKey: device.serial)
        }
        for serial in rows.keys where !connected.contains(serial) {
            rows[serial]?.available = false
            if deadlines[serial] == nil { deadlines[serial] = now + 2 }
        }
        expire(at: now)
    }

    mutating func expire(at now: TimeInterval) {
        for (serial, deadline) in deadlines where now >= deadline {
            rows.removeValue(forKey: serial)
            deadlines.removeValue(forKey: serial)
        }
    }
}

// Recent iPhones omit the UDID separator in IOKit; usbmuxd expects it.
func phoneUDID(fromUSBSerial serial: String) -> String {
    let compact = serial.replacingOccurrences(of: "-", with: "")
    if compact.count == 40, compact.allSatisfy({ $0.isHexDigit }) { return compact.lowercased() }
    guard compact.count == 24, compact.allSatisfy({ $0.isHexDigit }) else { return serial }
    return (String(compact.prefix(8)) + "-" + String(compact.suffix(16))).uppercased()
}

// A capture-mode USB bounce is one connection, not a second invitation. Closing
// the mirror or dismissing the popover also does not re-prompt on that connection.
struct USBInvitationGate {
    private var announced = Set<String>()
    private var detachedAt: [String: TimeInterval] = [:]

    mutating func attached(_ serial: String, at now: TimeInterval) -> Bool {
        if let detached = detachedAt.removeValue(forKey: serial), now - detached >= 2 {
            announced.remove(serial)
        }
        return announced.insert(serial).inserted
    }

    mutating func detached(_ serial: String, at now: TimeInterval) { detachedAt[serial] = now }
}

// USB can re-enumerate while screen capture is starting. Only that recovery
// window absorbs short removals; unplugging a working mirror is immediate.
struct USBRecoveryWindow {
    private var startedAt: TimeInterval?
    private var detachedUntil: TimeInterval?
    var active: Bool { startedAt != nil }
    mutating func attached(at now: TimeInterval) {
        if startedAt == nil { startedAt = now }
        // usbmuxd may publish the reattached device just after IOKit does.
        detachedUntil = now + 1.2
    }
    mutating func detached(at now: TimeInterval) -> Bool {
        guard let startedAt, now - startedAt < 8 else { finish(); return false }
        detachedUntil = now + 1.2
        return true
    }
    func holdsDisconnect(at now: TimeInterval) -> Bool {
        guard let startedAt, now - startedAt < 8 else { return false }
        return now < (detachedUntil ?? startedAt + 1.2)
    }
    mutating func finish() { startedAt = nil; detachedUntil = nil }
}

// Native readiness belongs to a specific web document, observation epoch and
// device. A new observation must receive a frame after its own transition.
struct VideoReadinessGate {
    private(set) var lifecycle = "connecting"
    private(set) var deviceID: String?
    private(set) var connectionID = ""
    private(set) var epoch = -1
    private(set) var bridgeID = ""
    private(set) var serverInstance = ""
    private(set) var statusRevision = -1
    private var suspendedRevision: Int?
    private(set) var requiredFrameAfter: TimeInterval = 0

    struct Change {
        let accepted: Bool
        let newStatus: Bool
        let invalidated: Bool
        let deviceChanged: Bool
        let reattached: Bool
    }

    mutating func observe(_ state: String, deviceID incomingID: String?, epoch: Int,
                          bridgeID: String, serverInstance: String, statusRevision: Int, now: TimeInterval,
                          connectionID: String = "") -> Change {
        let next = ["ready", "locked", "connecting", "disconnected"].contains(state) ? state : "connecting"
        let newDocument = bridgeID != self.bridgeID
        if !newDocument && (epoch < self.epoch || statusRevision < self.statusRevision
            || (next == "ready" && statusRevision <= (suspendedRevision ?? -1))) {
            return Change(accepted: false, newStatus: false, invalidated: false, deviceChanged: false, reattached: false)
        }
        let newStatus = newDocument || statusRevision > self.statusRevision
        if newStatus { suspendedRevision = nil }
        let deviceID = incomingID.flatMap { $0.isEmpty ? nil : $0 }
        let deviceChanged = deviceID != self.deviceID
        let reattached = !deviceChanged && ((lifecycle == "disconnected" && next != "disconnected")
            || (!self.connectionID.isEmpty && !connectionID.isEmpty && connectionID != self.connectionID))
        let invalidated = next != lifecycle || deviceChanged || epoch != self.epoch
            || bridgeID != self.bridgeID || serverInstance != self.serverInstance || reattached
        self.deviceID = deviceID
        self.connectionID = connectionID
        self.epoch = epoch
        self.bridgeID = bridgeID
        self.serverInstance = serverInstance
        self.statusRevision = statusRevision
        lifecycle = next
        if invalidated { requiredFrameAfter = now }
        return Change(accepted: true, newStatus: newStatus, invalidated: invalidated, deviceChanged: deviceChanged, reattached: reattached)
    }

    mutating func suspend(at now: TimeInterval) {
        lifecycle = "connecting"
        suspendedRevision = statusRevision
        requiredFrameAfter = now
    }

    mutating func disconnect(at now: TimeInterval) {
        suspend(at: now)
        lifecycle = "disconnected"
    }

    mutating func requireFreshFrame(at now: TimeInterval) { requiredFrameAfter = now }

    func acceptsFrame(at timestamp: TimeInterval, now: TimeInterval) -> Bool {
        lifecycle == "ready" && timestamp > requiredFrameAfter && timestamp <= now && now - timestamp < 3
    }
}

// A single frame cannot erase failure history. Limit attempts in a rolling
// minute; only ten seconds of continuous healthy video resets the budget.
struct CaptureRetryBudget {
    private var attempts: [TimeInterval] = []
    private var healthySince: TimeInterval?

    mutating func beginAttempt(at now: TimeInterval) -> Bool {
        attempts.removeAll { now - $0 >= 60 }
        guard attempts.count < 2 else { return false }
        attempts.append(now)
        healthySince = nil
        return true
    }

    mutating func healthy(at now: TimeInterval) {
        if healthySince == nil { healthySince = now }
        if now - (healthySince ?? now) >= 10 { attempts.removeAll() }
    }

    mutating func failed() { healthySince = nil }
}
