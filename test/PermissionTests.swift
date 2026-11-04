import Foundation

@MainActor
private final class AuthorizationFixture {
    var values: [CapturePermission: CaptureAuthorization] = [.camera: .notDetermined, .microphone: .notDetermined]
    var requests: [CapturePermission] = []
    var settings: [CapturePermission] = []
    var replies: [CapturePermission: CheckedContinuation<Void, Never>] = [:]
    func ask(_ permission: CapturePermission) async {
        requests.append(permission)
        await withCheckedContinuation { replies[permission] = $0 }
    }
    func answer(_ permission: CapturePermission, _ value: CaptureAuthorization) {
        values[permission] = value
        replies.removeValue(forKey: permission)!.resume()
    }
}

@main
struct PermissionTests {
    @MainActor static func main() async {
        let fixture = AuthorizationFixture()
        let permissions = CapturePermissions(readStatus: { fixture.values[$0]! }, ask: { await fixture.ask($0) }, monitorSystem: false)
        let first = Task { await permissions.request(.camera) }
        let second = Task { await permissions.request(.camera) }
        for _ in 0..<20 { await Task.yield() }
        assert(fixture.requests == [.camera], "two device windows must share one system prompt")
        assert(permissions.requesting == [.camera])
        fixture.answer(.camera, .denied)
        let firstAnswer = await first.value, secondAnswer = await second.value
        assert(firstAnswer == .denied && secondAnswer == .denied)
        assert(permissions.snapshot.blocksNativeCapture && !permissions.snapshot.canPlayAudio)
        assert(permissions.requesting.isEmpty)
        _ = await permissions.request(.camera)
        assert(fixture.requests == [.camera], "denial must not cause repeated prompts")

        fixture.values[.camera] = .authorized
        permissions.refresh()
        assert(permissions.snapshot.canCaptureVideo && !permissions.snapshot.canPlayAudio)
        let microphone = Task { await permissions.request(.microphone) }
        for _ in 0..<20 { await Task.yield() }
        assert(permissions.snapshot.canCaptureVideo, "pending microphone authorization cannot block video")
        fixture.answer(.microphone, .denied)
        _ = await microphone.value
        assert(permissions.snapshot.canCaptureVideo && !permissions.snapshot.canPlayAudio)

        fixture.values[.microphone] = .authorized
        permissions.refresh()
        assert(permissions.snapshot.canPlayAudio, "granting in System Settings is read from the OS")
        fixture.values[.camera] = .denied
        permissions.refresh()
        assert(permissions.snapshot.blocksNativeCapture && !permissions.snapshot.canPlayAudio,
               "revoking video forces basic video without USB audio")
        for denied in [CaptureAuthorization.restricted, .unavailable] {
            fixture.values[.camera] = denied
            fixture.values[.microphone] = denied
            permissions.refresh()
            _ = await permissions.request(.camera)
            _ = await permissions.request(.microphone)
            assert(permissions.snapshot.blocksNativeCapture && !permissions.snapshot.canPlayAudio)
        }
        assert(fixture.requests == [.camera, .microphone], "restricted/unknown states fail closed without a prompt loop")
        fixture.values[.camera] = .authorized; fixture.values[.microphone] = .authorized
        permissions.refresh()
        assert(permissions.snapshot.canCaptureVideo && permissions.snapshot.canPlayAudio)
        let switches = AuthorizationFixture()
        let switchPermissions = CapturePermissions(readStatus: { switches.values[$0]! },
            ask: { await switches.ask($0) }, showSettings: { switches.settings.append($0) }, monitorSystem: false)
        let enable = Task { await switchPermissions.setEnabled(true, for: .camera) }
        for _ in 0..<20 { await Task.yield() }
        assert(switches.requests == [.camera] && switchPermissions.snapshot.camera == .notDetermined,
               "pending permission stays off until the OS grants it")
        switches.answer(.camera, .authorized)
        await enable.value
        assert(switchPermissions.snapshot.camera == .authorized)
        await switchPermissions.setEnabled(false, for: .camera)
        assert(switches.settings == [.camera] && switchPermissions.snapshot.camera == .authorized,
               "revocation opens System Settings without a fake off state")
        switches.values[.camera] = .denied
        switchPermissions.refresh()
        assert(switchPermissions.snapshot.camera == .denied)
        await switchPermissions.setEnabled(true, for: .camera)
        assert(switches.settings == [.camera, .camera] && switches.requests == [.camera],
               "previous denial opens settings, not another system prompt")
        for status in [CaptureAuthorization.restricted, .unavailable] {
            switches.values[.camera] = status
            await switchPermissions.setEnabled(true, for: .camera)
        }
        assert(switches.settings.count == 2 && switches.requests.count == 1,
               "restricted and unavailable switches cannot request permission")
        switches.values[.camera] = .authorized
        await switchPermissions.setEnabled(true, for: .camera)
        assert(switches.settings.count == 2, "already matching authorization is a no-op")
        print("Permission denial, revocation, restoration and concurrent-request tests passed.")
    }
}
