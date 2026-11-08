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

private final class AudioConnectFixture: NSObject {
    var calls = 0
    var succeeds = true
    var reportsError = true
    var source: AVAudioNode?
    var destination: AVAudioNode?
    var format: AVAudioFormat?
    @objc(connect:to:format:error:)
    func connect(_ source: AVAudioNode, to destination: AVAudioNode, format: AVAudioFormat?,
                 error: AutoreleasingUnsafeMutablePointer<NSError?>?) -> Bool {
        calls += 1
        self.source = source; self.destination = destination; self.format = format
        if !succeeds && reportsError { error?.pointee = NSError(domain: "iPortal.Audio.Test", code: 43) }
        return succeeds
    }
}
private let modernGraph = AudioConnectFixture()
let graphSource = AVAudioMixerNode(), graphDestination = AVAudioMixerNode()
let graphFormat = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2)!
let graphConnected = try nativeAudioConnectUsingErrorAPI(modernGraph, source: graphSource,
                                                        destination: graphDestination, format: graphFormat)
precondition(graphConnected && modernGraph.calls == 1)
precondition(modernGraph.source === graphSource && modernGraph.destination === graphDestination && modernGraph.format === graphFormat)
modernGraph.succeeds = false
var rejectedGraph = false
do { _ = try nativeAudioConnectUsingErrorAPI(modernGraph, source: graphSource, destination: graphDestination, format: nil) }
catch let error as NSError { rejectedGraph = error.domain == "iPortal.Audio.Test" && error.code == 43 }
precondition(rejectedGraph && modernGraph.calls == 2 && modernGraph.format == nil)
modernGraph.reportsError = false
var rejectedGraphWithoutError = false
do { _ = try nativeAudioConnectUsingErrorAPI(modernGraph, source: graphSource, destination: graphDestination, format: nil) }
catch { rejectedGraphWithoutError = true }
precondition(rejectedGraphWithoutError && modernGraph.calls == 3)
let legacyGraphSupported = try nativeAudioConnectUsingErrorAPI(NSObject(), source: graphSource, destination: graphDestination, format: nil)
precondition(!legacyGraphSupported)
print("Native audio: old-SDK graph dispatch preserves arguments, errors and no replay.")
