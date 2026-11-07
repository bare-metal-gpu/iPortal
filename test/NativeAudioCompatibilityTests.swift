// These NSObject fixtures expose the public Objective-C selector without
// importing its newer Swift overlay. They exercise the modern path even when
// CI runs on an older SDK/OS, with no audio hardware or sound playback.
private final class AudioStartFixture: NSObject {
    var calls = 0
    var succeeds = true
    var reportsError = true
    @objc(playAndReturnError:)
    func start(_ error: AutoreleasingUnsafeMutablePointer<NSError?>?) -> Bool {
        calls += 1
        if !succeeds && reportsError {
            error?.pointee = NSError(domain: "iPortal.Audio.Test", code: 42)
        }
        return succeeds
    }
}
private let modernAudio = AudioStartFixture()
let modernAudioStarted = try nativeAudioStartUsingErrorAPI(modernAudio)
precondition(modernAudioStarted)
precondition(modernAudio.calls == 1)
modernAudio.succeeds = false
var rejectedAudioStart = false
do { _ = try nativeAudioStartUsingErrorAPI(modernAudio) }
catch let error as NSError {
    rejectedAudioStart = error.domain == "iPortal.Audio.Test" && error.code == 42
}
precondition(rejectedAudioStart && modernAudio.calls == 2, "Propagate failure once without fallback/replay")
modernAudio.reportsError = false
var rejectedMissingError = false
do { _ = try nativeAudioStartUsingErrorAPI(modernAudio) }
catch { rejectedMissingError = true }
precondition(rejectedMissingError && modernAudio.calls == 3, "A false result without NSError is still failure")
let legacyAudioSupported = try nativeAudioStartUsingErrorAPI(NSObject())
precondition(!legacyAudioSupported, "Missing capability selects the legacy path before dispatch")
print("Native audio: old-SDK runtime dispatch, NSError propagation and no replay passed.")
