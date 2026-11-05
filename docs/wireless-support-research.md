# Wireless/local-network feasibility

Historical feasibility notes below. The subsequent iOS 27.3 implementation and
physical-phone results are documented in [wireless implementation](wireless-implementation.md).

Research date: 2026-11-04. No wireless session, settings change, or experimental app installation was performed. The connected physical phone reports iOS 26.7.1 and an existing paired, wired CoreDevice connection.

## Conclusion

Cable-free operation is feasible, but control and media must be solved separately. The shortest proof uses the existing XCTest helper and JPEG stream over a paired network connection. A smooth production media path should evaluate native wireless capture, AirPlay, or app-side screen capture plus hardware encoding. No wireless latency figure has been measured for iPortal.

## Control and helper lifecycle

[Apple documents launching apps on paired devices over Wi-Fi](https://help.apple.com/xcode/mac/current/en.lproj/dev3e2f4ee6d.html). Xcode's network device lifecycle is the first route to reuse for starting and supervising the signed helper. The existing input, inspection, clipboard, and keep-awake logic need not be replaced merely because the transport changes.

[pymobiledevice3's tunnel documentation](https://github.com/doronz88/pymobiledevice3/blob/master/docs/guides/ios17-tunnels.md) independently describes paired Wi-Fi access and CoreDevice/RemoteXPC tunnels. It is a protocol/research reference, not a recommendation to add a Python runtime back to the product. Network access to developer services does not by itself prove that the helper's current loopback HTTP ports are reachable through the same tunnel. That is an explicit prototype acceptance criterion.

Current implementation constraints:

- `iportal.mjs` selects and tracks only `ConnectionType == "USB"`; several lifecycle paths treat loss of that attachment as device loss.
- The signed helper's HTTP and MJPEG listeners bind to `127.0.0.1`. Simply supplying a LAN IP or accepting a Network device will not make those listeners reachable.
- The `--wda` development override already accepts a network URL, but is not an integrated wireless discovery, authentication, or lifecycle solution.
- The menu-bar watcher uses IOKit USB arrival/removal. Wireless discovery needs an additional event source.
- Keep stable device identity separate from USB/network endpoint identity. Prefer USB when healthy, deduplicate simultaneous USB/Wi-Fi advertisements, and avoid closing the window or restarting the helper merely because one transport disappears.

Keep the Mac-facing API on loopback. For network helper traffic, first validate Apple's paired forwarding/tunnel route; if a direct app channel is needed, authenticate and encrypt it with automatically provisioned credentials. The existing bearer header authenticates requests but does not encrypt a plain LAN HTTP connection. This can preserve the absence of an app-specific login or manual key entry.

## Video/audio choices

| Path                                                  | Evidence and fit                                                                                                                                                                                                                                                                                                                 | Limitation / next gate                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Existing helper JPEG stream                           | Already part of iPortal and independent of native USB capture. Smallest wireless control-and-picture prototype.                                                                                                                                                                                                                  | Screenshot capture/encoding remains the video bottleneck; this path does not supply the native device audio stream. Do not equate successful connectivity with smooth video.                                                                                                                     |
| CoreMediaIO wireless capture                          | Apple exposes `kCMIOHardwarePropertyAllowWirelessScreenCaptureDevices`; the installed SDK says it enables wireless capture-device enumeration, default off. The installed capture assistant contains a wireless discovery path.                                                                                                  | [The public symbol](https://developer.apple.com/documentation/coremediaio/kcmiohardwarepropertyallowwirelessscreencapturedevices) does not establish that a paired iPhone exposes its screen this way. Worth a bounded probe; not a proven cable-free replacement for the current iPhone source. |
| AirPlay receiver plus existing helper control         | [Apple supports iPhone/iPad screen mirroring to a Mac](https://support.apple.com/en-us/102661). [UxPlay](https://github.com/FDH2/UxPlay) is an open-source macOS-capable receiver reference, including media buffering/synchronization options.                                                                                  | AirPlay carries media, not our full touch/inspection API. It normally starts through Control Center. Embedded receiver/media integration, latency, protected-content behavior, and device identity correlation need validation. Check licenses before adopting implementation code.              |
| App-side capture plus encrypted local video transport | [ScreenCaptureKit supports iOS 27](https://developer.apple.com/documentation/screencapturekit). [Apple's iOS sample](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-on-ios) covers full-display capture and the `screen-capture` background mode. It no longer needs a broadcast extension. | Requires the system sharing picker/permission, and is unavailable on the currently connected iOS 26.7.1 phone. An older-OS implementation needs a ReplayKit broadcast upload extension. Hardware encoding and a bounded, low-latency transport/decoder must still be built and measured.         |

ScreenCaptureKit/ReplayKit capture supplies media, not global touch injection. The signed XCTest helper remains responsible for control. A custom media route could preserve the Mac window and toolbar while introducing only Apple's required sharing consent on the phone. Do not promise completely silent start or restart.

Apple's separate iPhone Mirroring application is not an embeddable replacement demonstrated by this research. Its [documented requirements](https://support.apple.com/en-us/120421) include the same Apple Account, a locked nearby iPhone, and one iPhone/Mac pair at a time; Apple currently lists it as unavailable in the EU. It does not meet iPortal's iPad/multiple-device scope.

## Recommended next experiment

1. Briefly test wireless CoreMediaIO discovery on a paired, cable-free iPhone. Require actual screen frames, not merely successful property-setting or discovery of a Continuity camera. If no source appears, stop this route rather than spending an open-ended effort on private APIs.
2. Prove helper startup, authenticated commands, and the existing JPEG stream over Wi-Fi with the cable absent. Verify exactly how device-loopback ports are reached; never assume pairing alone forwards them.
3. Exercise USB-to-Wi-Fi and Wi-Fi-to-USB changes, network loss, helper restart, lock/unlock, and duplicate advertisements with stable device/window ownership.
4. Compare input completion and first changed frame separately against USB. Only after this works, benchmark AirPlay versus custom app-side encoded capture for the wireless media path. On the current phone, AirPlay is the most established screen-video option; ScreenCaptureKit becomes a cleaner app-owned candidate on iOS 27+.

Measure median and tail latency under real input, steady scrolling, orientation changes, audio playback, and network congestion. Frame rate alone does not measure interaction latency. Keep video queues bounded and avoid stale-frame catch-up; avoid applying a large media jitter buffer to control messages.
