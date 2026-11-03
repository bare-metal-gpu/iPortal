# iPhone status screen

The phone app uses the same `ThinkingOrb`, `BorderBeam`, Inter font, and centered
status layout as the Mac app. Both compile `shared/ConnectionAppearance.swift`
and the same pinned versions of ThinkingOrbsKit and BorderBeamKit. It has no
additional controls. Motion runs while connecting/reconnecting; waiting and
connected states use a still orb. Reduce Motion is respected on both platforms.

| State | Phone screen |
| --- | --- |
| Launching | System launch transition, then the native waiting screen |
| Opened without a viewer | Waiting for your Mac; connect by USB and open the Mac app |
| Viewer is loading | Connecting… |
| Video and input are ready | Connected; you can open another app |
| Heartbeat missing for 6 seconds | Reconnecting… |
| Heartbeat missing for 20 seconds | Waiting for your Mac |
| Another app is open | Portal remains in the background |
| Phone locked | Normal iOS lock screen; the Mac asks for unlock |
| Helper terminated | No running UI; opening the app shows the waiting screen |

When connected, an active keep-awake lease adds its remaining minutes. This is a
display of the existing lease, not a separate idle-timer override or an unlock loop.
The countdown disappears on expiry or when the connection becomes stale.

## Implementation

Apple's generated XCTest host creates an empty window. `PortalUI.framework` fills
that existing window using a SwiftUI hosting controller. The framework is loaded by the host
before the test bundle, so the screen does not depend on the HTTP server starting.
The runner's application/scene delegates and XCTest entry point stay intact.
One guarded hook suppresses automatic test startup on manual launches, so opening
the app stays on its waiting screen. Launches with XCTest configuration or the
Mac's explicit `PORTAL_AUTOMATION=1` flag call the original test-start method.
No window is created or activated by Portal, and other apps are never brought out
of the foreground by a status update.

The build compiles and signs this framework with the host's existing identity.
It adds one load command in unused Mach-O header padding, without relocating code
or data. The installer supports the current arm64 XCTRunner, including Xcode's
single-slice universal wrapper. Unknown formats and insufficient padding fail
closed. A failed embed restores the entire original bundle, and setup checks the
resulting link and signatures. This integration must be rechecked after major
Xcode runner changes; it is not a general binary patcher or an App Store build path.

The viewer sends validated `POST /api/presence` requests with `{clientId, ready}`.
The server expires each viewer after 6 seconds and publishes the aggregate state
at most once every 2 seconds to `POST /wda/mirror/portal`. Requests have a 1-second
timeout and never overlap. Old helpers back off for 30 seconds and continue working.
The phone expires heartbeats using monotonic time independently of the Mac.

Status updates change only the native view model, and skip unchanged values. They do not query the accessibility tree,
create a test session, enter the input queue, or synthesize input. Presence does
not enable keep-awake. The API uses the existing local-origin and instance checks.

## Verification

`npm test` covers presence expiry, multiple viewers, backpressure, old-helper
compatibility, Effect schema validation, repeatable installation, and rollback,
alongside the existing input/capture/lifecycle suite. `python3 test/portal-host.py`
covers binary-section preservation, repeated linking, and unsupported layouts.

Physical-device checks: standalone launch, waiting/connecting/connected screen,
countdown, heartbeat expiry, and background updates without stealing focus.
