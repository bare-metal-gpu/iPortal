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
| USB host detaches | Disconnected; connect to your Mac |
| USB host reattaches while video is loading after a connection | Reconnecting… |
| Heartbeat missing for 3 seconds, without a host event | Disconnected (fallback) |
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
at most once every second to `POST /wda/mirror/portal`. Requests have a 1-second
timeout and never overlap. Old helpers back off for 30 seconds and continue working.
The phone expires heartbeats using monotonic time independently of the Mac.
The phone also observes lockdownd's `host_attached` / `host_detached` Darwin
notifications and renders immediately on those events, without guessing USB
attachment from battery charging state. These notification names are recorded in
[libimobiledevice's notification definitions](https://github.com/libimobiledevice/libimobiledevice/blob/master/include/libimobiledevice/notification_proxy.h).
They are not a public UIKit USB API, so the heartbeat deadline remains the fallback
and delivery must be rechecked on major iOS updates. The fallback can take roughly
three to four seconds including the native UI refresh. A recent host attachment or
heartbeat is required to show an active reconnect attempt.
During the first eight seconds of reattachment, a brief USB mode-switch removal
gets a 1.2-second grace period and remains `Reconnecting…`. A longer removal still
becomes disconnected, and once video is ready a subsequent unplug is immediate.
This prevents `Disconnected → Reconnecting → Disconnected → Reconnecting` flashes
when iOS re-enumerates USB to bring up screen capture.

On the Mac, IOKit notifications for the pinned phone's USB serial freeze video/input
on removal and refresh status immediately on attachment. Responses started before
the event cannot undo that transition. A new USB attachment invalidates video readiness and renews the capture
retry budget even when the phone's identity is unchanged. The last frame stays
blurred until a fresh native or fallback frame is presented. A capture failure
waits for fresh USB status before attempting another session. Native scheduling
also refreshes the web view's connection poll while WebKit page timers are
suspended by window occlusion; those refreshes share one in-flight poll and timer.
An in-flight capture is retained through a short re-enumeration during recovery.
Capture discovery also listens for AVFoundation device arrival instead of waiting
for the next discovery timer tick.

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

USB recovery was then checked on the same phone. The first physical test recovered
after a detach and two USB enumerations; the user confirmed that mirroring returned.
The event-driven build also received actual iOS host-detach/attach notifications
(recorded by the status endpoint), survived USB re-enumeration, and returned to
connected video without restarting the app. Heartbeat expiry remains covered by
the native phase tests. Regression tests cover a network advertisement surviving
USB removal, reattachment between polls, stale readiness after removal, concurrent
native/browser polling, and retaining the same phone's frame until video recovers.

The subsequent recovery-window build was confirmed by the user on two physical
cable cycles. The phone's recorded rendered phases were exactly `Connected →
Disconnected → Reconnecting → Connected` for both, despite each attachment
containing another USB detach/attach pair. Connected returned 1.66 and 1.75 seconds
after the final USB host attachment (3.28 and 3.22 seconds after the initial host
attachment). These are status-screen recovery times including the presence
heartbeat, not touch latency or a claim of instantaneous video. Native USB
events changed the model immediately; the usual view transition still applies.
