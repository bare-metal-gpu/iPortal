import Foundation

@MainActor
private final class AuthorizationFixture {
    var values: [CapturePermission: CaptureAuthorization] = [.camera: .notDetermined, .microphone: .notDetermined]
    var requests: [CapturePermission] = []
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
        print("Permission denial, revocation, restoration and concurrent-request tests passed.")
    }
}
