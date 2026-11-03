# iPhone status screen

The phone app uses the same `ThinkingOrb`, `BorderBeam`, Inter font, and centered
status layout as the Mac app. Both compile `shared/ConnectionAppearance.swift`
and the same pinned versions of ThinkingOrbsKit and BorderBeamKit. It has no
additional controls. The foreground orb stays animated: reconnecting uses
`solving`, connected uses `searching`, and waiting/connecting use `connecting`.
Motion pauses while the screen is inactive. Reduce Motion is respected on both
platforms.

| State | Phone screen |
| --- | --- |
| Launching | System launch transition, then the native waiting screen |
| Opened without a viewer | Waiting for your Mac; connect by USB and open the Mac app |
| Viewer is loading | Connecting… |
| Video and input are ready | Connected |
| Heartbeat missing for 6 seconds | Reconnecting… |
| Heartbeat missing for 20 seconds | Waiting for your Mac |
| Another app is open | Portal remains in the background |
| Phone locked | Normal iOS lock screen; the Mac asks for unlock |
| Helper terminated | No running UI; opening the app shows the waiting screen |

An active keep-awake lease adds a small `Awake · m:ss` badge while heartbeats are
fresh. Its countdown uses the server's actual remaining lease and advances with
the phone's monotonic clock. It disappears on expiry or when the connection
becomes stale; presence never starts a lease.

The orb and status row stay centered independently of the hint or badge below
them. State changes crossfade over 0.3 seconds, and the badge fades in/out without
moving the row. Reduce Motion disables these transitions.

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

On 2026-11-03, the final shared SwiftUI build was verified on the connected iPhone:
the orb, animated connection state, border beam, and countdown rendered correctly;
status updates left Settings in the foreground. With the Mac app and test process
stopped, a fresh phone-app launch stayed on the waiting screen. Reopening the Mac
app restored video/control readiness and a 30-minute keep-awake lease. The native
heartbeat expiry transitions had also passed the preceding physical-device test.

The subsequent layout refinement was built for both platforms and checked on the
phone: connected/searching, reconnecting/solving, animated waiting, and the
keep-awake badge through a real five-second lease expiry. The connected hint is
gone, and adding/removing the badge leaves the status row centered. Screenshots
after heartbeat expiry allow for the one-second native refresh and transition.
