# Real-time status bar through native USB capture

Investigation: 2026-11-04. Result: **no usable Valeria-off control found in the existing AVFoundation/CoreMediaIO backend**. This was a negative feasibility probe, not a successful `Valeria=false` handshake test.

## Scope

Preserve the current USB capture, hardware decoding, audio, input path, and UI. Inspect the connected physical iPhone without replacing Apple's capture service, patching system binaries, changing global preferences, or installing an experimental app build.

## Evidence

- The connected phone was unlocked and the iPortal API reported `ready` before and after the probe.
- A separate, short-lived AVFoundation capture client received a 1206 × 2622 frame from the same iOS capture source. The status-bar crop visibly read **09:41**. The probe used existing camera authorization and did not request permissions.
- The live capture object was `AVCaptureDALDevice`. Runtime inspection found no Valeria, demo-mode, or status-bar override setter. Explicit `respondsToSelector` checks for `setValeria:`, `setIsValeria:`, `setDemoMode:`, and `setStatusBarOverride:` all returned false. These checks did not call nonexistent setters.
- CoreMediaIO property probes covered the SDK-declared selectors on the iOS device and its input stream, across global, input, and output scopes. The available properties exposed device ownership/access, identity, stream configuration, and format/clock information; none exposed the USB handshake's `Valeria` dictionary key. This does not prove the absence of every undocumented selector.
- Inspection of the installed `iOSScreenCaptureAssistant` showed its setup code constructing options with `kFigNeroCreationOption_RenderDestination` and `kFigNeroCreationOption_Variant`, selecting `kFigNeroVariant_Valeria`, then calling `FigNeroSetup`. The application does not own that Nero session or its handshake dictionary.
- The app remained on `video=native` after the probe. The current window, toolbar, and Keep on Top state remained intact.

The host reported macOS 27.0.1. These findings apply to the inspected host and connected phone; they are not a guarantee about all macOS/iOS releases.

## Why the external implementation differs

[RayrenSX/iPhoneMirror's session implementation](https://github.com/RayrenSX/iPhoneMirror/blob/eceab25e7c8a50beaefa0afb124be2e17a2dd14d/src/Core/src/Protocol/QuickTimeSession.cpp#L102-L122) constructs the USB `hpd1` handshake itself and supplies a Boolean `Valeria` value. Its [session options](https://github.com/RayrenSX/iPhoneMirror/blob/eceab25e7c8a50beaefa0afb124be2e17a2dd14d/src/Core/src/Protocol/QuickTimeSession.h) describe demo mode as the status-bar override and default it to false.

In iPortal, `macos/Capture.swift` enables screen-capture device discovery and creates an ordinary `AVCaptureDeviceInput`. Apple's separate capture service owns the lower-level session. The protocol key is not an AVFoundation video-output setting or an exposed CoreMediaIO property discovered by this probe.

## Performance and outcome

No production source, installed binary, system preference, decoder, queue, or presentation setting changed. The probe stopped its own session and exited. There is no successful off/on comparison and **no measured latency improvement or regression claim**. The idle phone produced only two frames during the sampling interval, so that sample is not a meaningful frame-rate or end-to-end latency benchmark.

Do not add ignored dictionary keys, an app preference that cannot affect Apple's helper, or a drawn-over replacement clock. The current backend remains unchanged. A further experiment would need a concrete newly discovered backend control, or ownership of the USB handshake through a separate capture transport. The latter requires its own audio, reconnect, orientation, multi-device, and latency validation and is outside this minimal backend-switch experiment.
