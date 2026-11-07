import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

if (process.platform !== "darwin") process.exit(0);
const source = await readFile(new URL("../macos/NativeMedia.swift", import.meta.url), "utf8");
const pipelineTests = await readFile(
  new URL("../test/NativeMediaPipelineTests.swift", import.meta.url),
  "utf8",
);
const directory = await mkdtemp(path.join(tmpdir(), "iportal-media-test-"));
try {
  const file = path.join(directory, "input.swift");
  await writeFile(
    file,
    `import Foundation
import CoreImage
import CoreVideo
import AVFoundation
${source}
// Compile the entire production pipeline, including callbacks and SDK API
// availability. These collaborators replace only the window/process boundary.
final class CaptureLifetime: @unchecked Sendable {
  private let lock = NSLock()
  private var cancelled = false
  var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
  func cancel() { lock.lock(); cancelled = true; lock.unlock() }
}
final class FrameStore: @unchecked Sendable {
  private let lock = NSLock()
  private var received: [CMSampleBuffer] = []
  func consume(_ sample: CMSampleBuffer) { lock.lock(); received.append(sample); lock.unlock() }
  var samples: [CMSampleBuffer] { lock.lock(); defer { lock.unlock() }; return received }
}
struct PairedCapabilities: Codable { let control: String, video: String, audio: String }
final class MediaTestEvents: @unchecked Sendable {
  private let lock = NSLock()
  private var events: [String] = []
  func record(_ event: String) { lock.lock(); events.append(event); lock.unlock() }
  func count(_ event: String) -> Int { lock.lock(); defer { lock.unlock() }; return events.filter { $0 == event }.count }
}
let testEvents = MediaTestEvents()
func iportalTrace(_ event: String, _ values: [String: Any] = [:]) { testEvents.record(event) }
let ownership = MediaDecodeOwnership()
let firstDecode = ownership.admit(until: Date())!
let secondDecode = ownership.admit(until: Date())!
precondition(ownership.admit(until: Date(timeIntervalSinceNow: 0.02)) == nil, "Decode backlog must remain bounded")
var delivered: [UInt64] = []
precondition(ownership.present(secondDecode) { delivered.append(secondDecode) })
precondition(!ownership.present(firstDecode) { delivered.append(firstDecode) }, "Out-of-order callback cannot rewind the picture")
ownership.complete(firstDecode)
let thirdDecode = ownership.admit(until: Date())!
precondition(thirdDecode > secondDecode)
let unblocked = DispatchSemaphore(value: 0)
DispatchQueue.global().async {
  precondition(ownership.admit(until: Date(timeIntervalSinceNow: 3)) == nil)
  unblocked.signal()
}
ownership.retire()
precondition(unblocked.wait(timeout: .now() + 1) == .success, "Retiring a decode generation must wake admission")
precondition(!ownership.present(thirdDecode) { delivered.append(thirdDecode) })
ownership.complete(secondDecode); ownership.complete(secondDecode); ownership.complete(thirdDecode)
precondition(ownership.admit(until: Date()) == nil, "Retired generation cannot admit new input")
let anotherDevice = MediaDecodeOwnership()
precondition(anotherDevice.admit(until: Date()) == 0, "Device ownership must be isolated")
precondition(delivered == [secondDecode])
let budget = MediaDecoderBudget.device("SYNTHETIC-DEVICE-A")
let sameDeviceBudget = MediaDecoderBudget.device("syntheticdevicea")
let retirementTokens = (0..<3).map { _ in budget.acquire()! }
precondition(sameDeviceBudget.acquire() == nil, "Stalled retirement must bound sessions across replacement receivers")
precondition(MediaDecoderBudget.device("synthetic-device-b").acquire() != nil, "One stalled device must not exhaust another device's budget")
budget.release(retirementTokens[0])
precondition(sameDeviceBudget.acquire() != nil, "Completed retirement permits recovery")
budget.release(retirementTokens[1]); budget.release(retirementTokens[2])
precondition(nativeMediaUsesYUV(bitsPerComponent: 8, transferFunction: kCVImageBufferTransferFunction_sRGB as String))
precondition(nativeMediaUsesYUV(bitsPerComponent: 8, transferFunction: kCVImageBufferTransferFunction_ITU_R_709_2 as String))
precondition(!nativeMediaUsesYUV(bitsPerComponent: nil, transferFunction: kCVImageBufferTransferFunction_sRGB as String))
precondition(!nativeMediaUsesYUV(bitsPerComponent: 8, transferFunction: nil))
precondition(!nativeMediaUsesYUV(bitsPerComponent: 10, transferFunction: kCVImageBufferTransferFunction_sRGB as String))
precondition(!nativeMediaUsesYUV(bitsPerComponent: 8, transferFunction: kCVImageBufferTransferFunction_SMPTE_ST_2084_PQ as String))
precondition(!nativeMediaUsesYUV(bitsPerComponent: 8, transferFunction: kCVImageBufferTransferFunction_ITU_R_2100_HLG as String))
let pixelCandidates = nativeMediaPixelAttributeCandidates([
  kCVPixelBufferMetalCompatibilityKey as String: true,
  kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
], nativeYUV: true)
precondition(pixelCandidates.first?[kCVPixelBufferPixelFormatTypeKey as String] == nil, "Confirmed SDR can use native format")
precondition(pixelCandidates.last?[kCVPixelBufferPixelFormatTypeKey as String] as? OSType == kCVPixelFormatType_32BGRA)
precondition(nativeMediaPixelAttributeCandidates([:]).allSatisfy { $0[kCVPixelBufferPixelFormatTypeKey as String] as? OSType == kCVPixelFormatType_32BGRA }, "Unknown/HDR formats retain consistent previous BGRA behavior")
print("Native media: bounded admission, obsolete/out-of-order callbacks, retirement and pixel-format fallback passed.")
// Deliver a real AVAudioEngine configuration-change notification while stopped.
// No sound is played; the asynchronous recovery must run, then respect teardown.
private let audioRecovery = NativeMediaAudio()
let recoveryEngine = Mirror(reflecting: audioRecovery).children.first { $0.label == "engine" }!.value as! AVAudioEngine
let changesBefore = testEvents.count("paired-audio-output-changed")
NotificationCenter.default.post(name: .AVAudioEngineConfigurationChange, object: recoveryEngine)
let recoveryDeadline = Date(timeIntervalSinceNow: 3)
while testEvents.count("paired-audio-output-changed") == changesBefore && Date() < recoveryDeadline { Thread.sleep(forTimeInterval: 0.005) }
precondition(testEvents.count("paired-audio-output-changed") > changesBefore, "Hardware changes must reconfigure the audio owner")
audioRecovery.stop()
Thread.sleep(forTimeInterval: 0.03)
let changesAfterStop = testEvents.count("paired-audio-output-changed")
NotificationCenter.default.post(name: .AVAudioEngineConfigurationChange, object: recoveryEngine)
Thread.sleep(forTimeInterval: 0.03)
precondition(testEvents.count("paired-audio-output-changed") == changesAfterStop, "Stopped audio cannot restart on a late hardware event")
print("Native audio: configuration changes recover off the notification callback and late events respect shutdown.")
// Reproduce the invalid output state without sleeping the test host. The
// recoverable start API must return an error, not terminate the process.
let stoppedEngine = AVAudioEngine(), stoppedPlayer = AVAudioPlayerNode()
stoppedEngine.attach(stoppedPlayer)
if #available(macOS 27.0, *) {
  try stoppedEngine.connectNode(stoppedPlayer, to: stoppedEngine.mainMixerNode,
                               format: AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2)!)
} else {
  stoppedEngine.connect(stoppedPlayer, to: stoppedEngine.mainMixerNode,
                        format: AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2)!)
}
var rejectedStoppedOutput = false
do { try startNativeAudioPlayer(stoppedPlayer) } catch { rejectedStoppedOutput = true }
precondition(rejectedStoppedOutput, "Stopped output must fail without aborting")
print("Native audio: unavailable output returns a recoverable error.")
var audioClock = AudioPacketClock()
precondition(audioClock.observe(UInt32.max - 479)?.silence == 0)
precondition(audioClock.observe(0)?.silence == 0)
precondition(audioClock.observe(960)?.silence == 480)
precondition(audioClock.observe(960) == nil)
precondition(audioClock.observe(480) == nil)
precondition(audioClock.observe(96000)?.reset == true)
precondition(audioClock.observe(0)?.reset == true)
var drift = AudioDriftControl()
for _ in 0..<10000 { precondition((0.998...1.002).contains(drift.rate(pendingPackets: 24))) }
precondition(drift.rate(pendingPackets: 24) > 1)
for _ in 0..<10000 { precondition((0.998...1.002).contains(drift.rate(pendingPackets: 1))) }
precondition(drift.rate(pendingPackets: 1) < 1)
print("Native audio: timestamps, wrap, loss, discontinuity and bounded clock correction passed.")
let pipe = Pipe()
let started = ProcessInfo.processInfo.systemUptime
DispatchQueue.global().async {
  Thread.sleep(forTimeInterval: 0.05)
  try! pipe.fileHandleForWriting.write(contentsOf: Data([1,2,3]))
  Thread.sleep(forTimeInterval: 1)
  try! pipe.fileHandleForWriting.close()
}
let bytes = readAvailableMediaBytes(pipe.fileHandleForReading)
precondition(bytes == Data([1,2,3]))
precondition(ProcessInfo.processInfo.systemUptime-started < 0.75, "Small media records must not wait for a full read buffer")
precondition(readAvailableMediaBytes(pipe.fileHandleForReading).isEmpty, "EOF ends capture")
print("Native media: partial pipe reads arrive immediately and EOF cancels cleanly.")
var pixel: CVPixelBuffer?
let attributes = [kCVPixelBufferIOSurfacePropertiesKey as String: [:]] as CFDictionary
precondition(CVPixelBufferCreate(nil, 2, 3, kCVPixelFormatType_32BGRA, attributes, &pixel) == 0)
let original = pixel!
CVPixelBufferLockBaseAddress(original, [])
let bytesPerRow = CVPixelBufferGetBytesPerRow(original)
let address = CVPixelBufferGetBaseAddress(original)!.assumingMemoryBound(to: UInt8.self)
for y in 0..<3 { for x in 0..<2 {
  let i = y * bytesPerRow + x * 4
  address[i] = UInt8(20 + (y * 2 + x) * 30)
  address[i + 1] = address[i]; address[i + 2] = address[i]; address[i + 3] = 255
}}
CVPixelBufferUnlockBaseAddress(original, [])
private let rotator = NativeMediaRotation()
for (orientation, width, expected) in [
  ("PORTRAIT", 2, [20,50,80,110,140,170]),
  ("LANDSCAPE", 3, [50,110,170,20,80,140]),
  ("UIA_DEVICE_ORIENTATION_LANDSCAPERIGHT", 3, [140,80,20,170,110,50]),
  ("UIA_DEVICE_ORIENTATION_PORTRAIT_UPSIDEDOWN", 2, [170,140,110,80,50,20]),
  ("PORTRAIT", 2, [20,50,80,110,140,170]),
] {
  rotator.setOrientation(orientation)
  let output = rotator.apply(original)!
  precondition(CVPixelBufferGetWidth(output) == width)
  precondition(CVPixelBufferGetHeight(output) == 6 / width)
  CVPixelBufferLockBaseAddress(output, .readOnly)
  let data = CVPixelBufferGetBaseAddress(output)!.assumingMemoryBound(to: UInt8.self)
  let stride = CVPixelBufferGetBytesPerRow(output)
  for i in expected.indices { precondition(abs(Int(data[(i / width) * stride + (i % width) * 4])-expected[i]) <= 2, orientation) }
  CVPixelBufferUnlockBaseAddress(output, .readOnly)
}
print("Native media: pixels and dimensions agree in all four orientations and on return to portrait.")
// The source contains six distinct pixels. Its clean aperture excludes the
// bottom row and right column; no padding may survive in any orientation.
for (orientation, width, expected) in [
  ("PORTRAIT", 1, [20,80]),
  ("LANDSCAPE", 2, [20,80]),
  ("UIA_DEVICE_ORIENTATION_LANDSCAPERIGHT", 2, [80,20]),
  ("UIA_DEVICE_ORIENTATION_PORTRAIT_UPSIDEDOWN", 1, [80,20]),
] {
  rotator.setOrientation(orientation)
  let output = rotator.apply(original, aperture: CGRect(x: 0, y: 1, width: 1, height: 2))!
  precondition(CVPixelBufferGetWidth(output) == width)
  precondition(CVPixelBufferGetHeight(output) == 2 / width)
  CVPixelBufferLockBaseAddress(output, .readOnly)
  let data = CVPixelBufferGetBaseAddress(output)!.assumingMemoryBound(to: UInt8.self)
  let stride = CVPixelBufferGetBytesPerRow(output)
  for i in expected.indices { precondition(abs(Int(data[(i / width) * stride + (i % width) * 4])-expected[i]) <= 2, orientation + " cropped") }
  CVPixelBufferUnlockBaseAddress(output, .readOnly)
}
precondition(rotator.apply(original, aperture: .zero) == nil)
precondition(rotator.apply(original, aperture: CGRect(x: -1, y: 0, width: 2, height: 3)) == nil)
rotator.setOrientation("PORTRAIT")
rotator.setDisplayPixels(CGSize(width: 1, height: 2))
let padded = rotator.apply(original)!
precondition(CVPixelBufferGetWidth(padded) == 1 && CVPixelBufferGetHeight(padded) == 2)
rotator.setDisplayPixels(CGSize(width: 1206, height: 2622))
precondition(rotator.apply(original) === original, "Do not crop a downscaled stream using native dimensions")
print("Native media: encoded padding is excluded in all orientations; invalid apertures are rejected.")
${pipelineTests}
`,
  );
  execFileSync("/usr/bin/xcrun", ["swift", file], { stdio: "inherit", timeout: 30000 });
} finally {
  await rm(directory, { recursive: true, force: true });
}
