import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

if (process.platform !== "darwin") process.exit(0);
const source = await readFile(new URL("../macos/NativeMedia.swift", import.meta.url), "utf8");
const input = source
  .split("// BEGIN TESTABLE MEDIA INPUT")[1]
  .split("// END TESTABLE MEDIA INPUT")[0];
const rotation = source
  .split("// BEGIN TESTABLE MEDIA ROTATION")[1]
  .split("// END TESTABLE MEDIA ROTATION")[0];
const audioClock = source
  .split("// BEGIN TESTABLE AUDIO CLOCK")[1]
  .split("// END TESTABLE AUDIO CLOCK")[0];
const audioStart = source
  .split("// BEGIN TESTABLE AUDIO START")[1]
  .split("// END TESTABLE AUDIO START")[0];
const directory = await mkdtemp(path.join(tmpdir(), "iportal-media-test-"));
try {
  const file = path.join(directory, "input.swift");
  await writeFile(
    file,
    `import Foundation
import CoreImage
import CoreVideo
import AVFoundation
${input}
${rotation}
${audioClock}
${audioStart}
// Reproduce the invalid output state without sleeping the test host. The
// recoverable start API must return an error, not terminate the process.
let stoppedEngine = AVAudioEngine(), stoppedPlayer = AVAudioPlayerNode()
stoppedEngine.attach(stoppedPlayer)
stoppedEngine.connect(stoppedPlayer, to: stoppedEngine.mainMixerNode,
                      format: AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2)!)
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
`,
  );
  execFileSync("/usr/bin/xcrun", ["swift", file], { stdio: "inherit", timeout: 30000 });
} finally {
  await rm(directory, { recursive: true, force: true });
}
