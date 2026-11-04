# iPhone status screen

The phone app uses the same `ThinkingOrb`, `BorderBeam`, Inter font, and centered
status layout as the Mac app. Both compile `shared/ConnectionAppearance.swift`
and the same pinned versions of ThinkingOrbsKit and BorderBeamKit. It has no
additional controls. The foreground orb stays animated: reconnecting uses
`solving`, connected uses `searching`, and waiting/connecting use `connecting`.
Motion pauses while the screen is inactive. Reduce Motion is respected on both
platforms.

| State                                                         | Phone screen                                              |
| ------------------------------------------------------------- | --------------------------------------------------------- |
| Launching                                                     | System launch transition, then the native waiting screen  |
| Opened without a viewer                                       | Waiting for your Mac; connect by USB and open the Mac app |
| Viewer is loading                                             | Connecting…                                               |
| Video and input are ready                                     | Connected                                                 |
| USB host detaches                                             | Disconnected; connect to your Mac                         |
| USB host reattaches while video is loading after a connection | Reconnecting…                                             |
| Heartbeat missing for 3 seconds, without a host event         | Disconnected (fallback)                                   |
| Another app is open                                           | iPortal remains in the background                         |
| Phone locked                                                  | Normal iOS lock screen; the Mac asks for unlock           |
| Helper terminated                                             | No running UI; opening the app shows the waiting screen   |

An active keep-awake lease adds a small `Awake · m:ss` badge while heartbeats are
fresh. Its countdown uses the server's actual remaining lease and advances with
the phone's monotonic clock. It disappears on expiry or when the connection
becomes stale; presence never starts a lease.

The orb and status row stay centered independently of the hint or badge below
them. State changes crossfade over 0.3 seconds, and the badge fades in/out without
moving the row. Reduce Motion disables these transitions.

## Implementation

Apple's generated XCTest host creates an empty window. `iPortalUI.framework` fills
that existing window using a SwiftUI hosting controller. The framework is loaded by the host
before the test bundle, so the screen does not depend on the HTTP server starting.
The runner's application/scene delegates and XCTest entry point stay intact.
One guarded hook suppresses automatic test startup on manual launches, so opening
the app stays on its waiting screen. Launches with XCTest configuration or the
Mac's explicit `IPORTAL_AUTOMATION=1` flag call the original test-start method.
No window is created or activated by iPortal, and other apps are never brought out
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
waits for fresh USB status before attempting another session. A native URLSession event subscription wakes the web view even while WebKit page
timers are suspended by window occlusion. Native/browser status polling is a
fallback when that stream is silent; requests still share one in-flight poll.
An in-flight capture is retained through a short re-enumeration during recovery.
Capture discovery also listens for AVFoundation device arrival instead of waiting
for the next discovery timer tick.

Status updates change only the native view model, and skip unchanged values. They do not query the accessibility tree,
create a test session, enter the input queue, or synthesize input. Presence does
not enable keep-awake. The API uses the existing local-origin and instance checks.

## Verification

`bun run test` covers presence expiry, multiple viewers, backpressure, old-helper
compatibility, Effect schema validation, repeatable installation, and rollback,
alongside the existing input/capture/lifecycle suite. `bun test ./test/build-tools.test.ts`
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

## Event-driven recovery (2026-11-03)

Normal recovery now propagates through usbmuxd `Listen` → a shared status probe →
`GET /api/events` → the native/browser bridge → AVFoundation device/frame callbacks
→ immediate viewer presence. The native app owns its event subscription so WebKit
occlusion does not suspend recovery. Standalone browsers use EventSource. Sequence
numbers, server/document identity, and observation timestamps reject obsolete events.
The existing origin/host checks protect the event endpoint as well.

IOKit matching must put the vendor in `IOPropertyMatch`. A read-only registry check
on this Mac returned zero devices with the previous top-level vendor key and one
with the corrected dictionary. Either IOKit or usbmuxd may arrive first; both enter
the same recovery window. Hardware attachment changes the UI immediately, but
capture preparation waits for current USB identity/multiplicity from usbmuxd.
Reusing the old attachment's selection policy caused an eight-second discovery
wait in a test build; the final build explicitly gates that path and has regression
coverage. Capture and helper readiness then proceed concurrently, with input still
gated on an unlocked helper and a fresh frame.

Other polling costs removed or reduced:

- USB forwards use the event-maintained device cache instead of `ListDevices` on
  every new socket. A 30-second reconciliation and subscription-failure fallback
  repair missed events.
- First-frame callbacks release readiness immediately; the 250 ms timer checks
  stalls, deadlines and retry budgets.
- Presence changes publish immediately and coalesce while a request is in flight.
  The one-second phone heartbeat remains a liveness lease, not a readiness delay.
- Capture discovery has one fallback timer, not a new retry chain per notification.
- Server health probes and browser/native status polling run on event-stream failure,
  startup, navigation failure or wake. A shared helper watchdog remains: 2 seconds
  when ready/locked, 500 ms while connecting, 10 seconds disconnected. Helper start
  output and exit events also request immediate checks. Lock/unlock and silent helper
  failures still need the watchdog because there is no lock event channel here.

Kept intentionally: keep-awake pulses, countdown rendering, MJPEG idle deadlines,
retry backoff, gesture-end debounce and explicit XCTest element waits. These enforce
leases/deadlines or wait for conditions without an available reliable event source.
A possible follow-up is using resumed capture frames to request an immediate lock
state recheck; the current unlock path can still wait for the shared watchdog.

### Final physical measurement

After fixing the selection-order regression, the user confirmed the final physical
cable cycle was smooth. The native trace recorded:

| Milestone                                     | Elapsed from earliest IOKit attachment |
| --------------------------------------------- | -------------------------------------: |
| Earliest IOKit attachment                     |                                   0 ms |
| Last IOKit attachment after USB mode switches |                                2772 ms |
| Control-ready bridge observation              |                                2861 ms |
| Fresh video sample                            |                                3074 ms |
| Input enabled / live layer submitted          |                                3076 ms |

From the final attachment to input readiness: **304 ms**. Fresh sample to input
readiness: **1.6 ms**. The same capture session survived the final mode switch;
there was no discovery timeout or capture restart during that recovery. Both the
native trace and phone phase history remained reconnecting through the mode switch.
The phone's phase history was `Connected → Disconnected → Reconnecting → Connected`;
its final attach-to-Connected interval was 764 ms, including the presence relay.

These are one final cycle's software milestones, not a high-speed-camera measurement
of displayed pixels or a statistically established median. Earlier 3.2-second figures
measured the phone status label from a different event source, so they are not a
like-for-like video benchmark. The remaining multi-second cost is primarily USB
enumeration and capture-mode switching; removing polling cannot remove those steps.

To record native milestones, create `~/Library/Application Support/iPortal/trace-reconnect` before a test and read
`~/Library/Application Support/iPortal/reconnect-trace.jsonl`. Remove the marker afterward. The log contains only
timestamps/state milestones, not frames or input contents. Record `/api/events`
alongside it for the server's USB identifiers, and read `/wda/mirror/portal` once after
a cycle for the phone's bounded phase history. Avoid high-frequency helper polling.

Validation: full Node/e2e/native-contract/capture/lifecycle suite, release Mac build
and code-signature verification, plus real phone recovery. Tests cover split/coalesced
USB messages, cache reuse, listener failure, status cancellation/coalescing, bounded
slow event clients, stale events, fallback polling, origin checks and immediate presence.
