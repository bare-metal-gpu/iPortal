# Paired wireless transport

Implemented and checked on 2026-11-05 with one physical iPhone running iOS 27.3,
an Apple silicon Mac, and Xcode 27.2. This supersedes the feasibility conclusions
in [wireless-support-research.md](wireless-support-research.md).

## Architecture

The optional `iPortalTransport` child uses the installed CoreDevice framework to
discover paired iPhones/iPads and open the phone's display-service socket. Apple
owns the pairing and tunnel. The Swift shim passes that owned socket to the Rust
receiver; no pairing records, keys, or Apple framework binaries are copied into
the app. The `idevice` dependency is pinned in `native/Cargo.lock` and attributed
in `NOTICE`.

HEVC video and AAC-ELD audio arrive on sockets bound to the paired tunnel's local
IPv6 endpoint and connected to the negotiated phone endpoint. Negotiation checks
the peer, ports, codec, payload types, SSRCs, and supported cipher mode. Media
records travel over a bounded local pipe to VideoToolbox and AVAudioEngine.
The existing per-device capture lifetime prevents an old receiver from updating
a replacement window. Stopping closes only that child's session sockets; it never
issues a global stop command. The phone was observed to expire abandoned sessions;
the exact expiry deadline was not measured.

Commands, inspection, screenshots, clipboard, keep-awake and the fallback image
stream still use the existing signed phone helper. It binds to the paired tunnel
address, retains automatic per-session token authentication, and is forwarded
through a private Mac Unix socket. The public Mac API stays on loopback. There is
no unauthenticated helper listener on a Wi-Fi interface and no new credential UI.

CoreDevice inventory events augment USB discovery. Stable device IDs deduplicate
wired/network advertisements and keep session ownership independent of the cable.
The same window, toolbar, device list and play/pause lifecycle are retained.
Interface orientation is read through the authenticated helper's existing status
observation cycle; pixels and dimensions are rotated together before presentation.
This orientation observation is not a per-frame event from the media stream.

### Cable handover and route indicators

The watcher subscribes to each CoreDevice device's information-change events,
in addition to device-list changes. This is necessary because a transport change
does not add or remove the physical device. `transportType` supplies the actual
`usb` / `wifi` metadata; cable presence alone never labels a still-wireless route
as USB. The tunnel remains the media and command path on both transports, so
moving to USB does not switch capture backends or restart the signed helper.

Route metadata is deliberately excluded from the server's connection ID. The
physical test recorded Wi-Fi → USB → Wi-Fi with the same tunnel address and
server instance. Plug-in continued playback. An unplug trace showed a roughly
3.3-second control recovery while Apple's tunnel moved back to Wi-Fi, with no
media-process restart; lost video packets triggered existing keyframe recovery.
The user subsequently confirmed both directions felt smooth. This is session
continuity, not a guarantee of zero lost frames during sudden link removal.

Both the window and popover share the secondary gray Wi-Fi symbol. It fades
in/out, pulses while visible, and stays static with Reduce Motion. Metadata-only
changes do not invoke attach/detach lifecycle actions or reopen the popover.
Device row identity uses canonical IDs, preventing duplicate rows when USB and
paired discovery spell the same serial differently. The popover only marks a
currently connected paired endpoint as available; it does not promise that a
locked device or an uninstalled helper will be ready for interaction immediately.

Physical USB invitations are separate from overall device reachability. A cable
attachment still offers mirroring when Wi-Fi already knows the phone, while its
removal does not disconnect that paired session. USB and network discovery have
independent invitation gates; duplicate USB services and brief enumeration bounces
do not reopen a dismissed popover. Regression tests exercise the real monitor's
event dispatch with synthetic inventories and no hardware observers.

## Measured fixes

- **Pipe batching:** Darwin's `FileHandle.read(upToCount: 65536)` held small records
  waiting for more bytes. A controlled producer wrote after 50 ms and closed 750 ms
  later: that read returned at 802 ms; `availableData` returned at 55 ms. The receiver
  now consumes available bytes immediately and retains framing across partial reads.
- **Video:** runtime delivery/presentation-enqueue counters were roughly 46–60 fps,
  typically 55–60, after the fix. The user confirmed much smoother motion. These
  counters do not measure panel refresh or end-to-end input latency.
- **Rotation:** asymmetric pixel tests cover all four orientations and return to
  portrait. The user confirmed landscape and orientation transitions on the phone.
- **Audio:** the paired connection delivered 10 ms audio packets in bursts with
  gaps around 110 ms. A 50 ms queue discarded roughly 15% of decoded packets.
  Counting completion at `.dataPlayedBack` also included output-device latency.
  The receiver now counts `.dataConsumed`, primes 120 ms of audio, bounds backlog
  to 240 ms, and resets a truly exhausted/overfull queue with generation guards.
  More than 3,800 successive packets then passed with zero queue drops, decoder
  errors, or rebufferings. The user replayed the same Photos video and confirmed
  smooth audio. This adds an audio-only jitter reserve; video and input are not
  delayed by it. It is not a guarantee for arbitrary Wi-Fi congestion.

## Verification and limits

Cable-free helper startup took 6.5 seconds in one run. A standalone native stream
produced its first HEVC data about 0.83 seconds after launch; neither figure is a
universal startup or interaction latency guarantee. A 12-second probe decoded
716 video frames without HEVC decoder errors.

The installed app passed live authenticated API checks for state, element lookup,
typed attributes, hierarchy, screenshots, waits, timeouts and app transitions.
Unauthenticated helper requests returned 401. The authenticated fallback image
stream also worked wirelessly. The user confirmed real scrolling, rotation,
video smoothness and Photos audio. Keep-awake was restored after restart.

`bun run verify` passed, including isolated synthetic USB/multi-device lifecycles,
authentication, permissions, clipboard, capture cancellation, native contracts,
and relocated packaged-server execution. Native tests cover partial pipe reads,
orientation pixels, HEVC framing/loss/bounds, and RTP sequence wrap/reordering.
Synthetic tests explicitly disable real paired-device discovery.

Only one physical iPhone was available. Physical iPad/simultaneous-device checks,
wireless clipboard handoff and prolonged congestion still need
dedicated validation. Protected-media audio remains subject to phone capture
restrictions. Audio/video clock synchronization has not been benchmarked.

This path relies on a private CoreDevice ABI and the phone's display service.
Native media is gated to Apple silicon/Xcode 27 builds and iOS/iPadOS 27+; future
OS/Xcode changes may require adaptation. The optional process boundary contains
framework failures so the normal app can still launch. Legacy USB capture and
the helper's screenshot fallback remain available.

## Capability and lifecycle hardening

The inventory protocol is version 1. The native producer and both Mac consumers
share `shared/DeviceCapabilities.swift`; the server decodes the same contract with
Effect Schema. A common valid/invalid fixture corpus runs through both decoders.
Each descriptor carries its OS version and separate control, video and audio
capabilities: eligible is not the same as negotiated support. Older OS versions
can be identified but are excluded from this paired feature path; their physical
USB capture remains available. No new pairing prompts are introduced.

Capture selection separates physical USB presence from the active paired route.
In particular, a Wi-Fi-only neighbor cannot make the sole USB capture ambiguous.
Native media failures prefer authorized USB capture before the helper image
stream. A previously negotiated native backend gets one media-only retry per
minute before fallback. Other transient failures get a 30-second cooldown; an unsupported negotiated
format stays disabled for that endpoint/OS version. A new endpoint or OS version
allows a new capability attempt. Camera permission decisions use the active
backend rather than a newly changed discovery label.

Observer failure is not a device-detach event. Discovery keeps a bounded
30-second cache while restarting with backoff; healthy authenticated server
sessions and fresh native capture can survive that cache's expiry. Confirmed
device removal still takes effect immediately. Stopped and replaced processes
cannot publish late inventory. Initialization and socket opening have deadlines;
device, network and wake events are primary, with a 10-second heartbeat/cache
reconciliation and 30-second silence watchdog as fallback. A native build that is
skipped removes cached output. Packaging also checks a host/toolchain/source stamp,
and only validated live inventory makes the native path eligible at runtime.

Video starts independently of audio negotiation. Unsupported audio does not
stop video. In-order audio has no new reorder delay; a missing packet gets at most
20 ms to arrive, inside the existing playback prebuffer. Sequence wrap, duplicates,
late packets, loss and queue bounds are tested. RTP timestamps insert bounded
silence for short gaps and reset playback on larger discontinuities. A bounded
0.998–1.002 playback-rate correction limits source/output clock drift without
holding video or input. Absolute audio/video synchronization and Bluetooth output
latency remain unmeasured.

Validation includes mixed USB/wireless inventories, old-OS eligibility, permission
denial, unsupported and transient media fallback, observer crashes/silence,
replacement callbacks, shared schema fixtures, packet loss/reordering/wrap, and
native/legacy builds. Physical checks on additional older devices and iPads remain
necessary before claiming that hardware coverage.

### Live-check corrections

On the physical iOS 27.3 phone, terminating all three discovery observers preserved
Ready state, the server/connection identity, and the active media/helper processes.
State inspection, screenshots, element lookup, Home and app launch also succeeded.
iOS required its UI Automation approval before the helper could start.

Further live checks exposed two cases not represented by the initial fixtures:

- A provisional legacy USB selection could stay selected after paired discovery,
  forcing a helper rebind on unplug. Startup now awaits the first discovery
  snapshot before launching the helper (at most 1.5 seconds; unsupported hosts
  proceed immediately). Paired discovery remains preferred. The live startup
  check confirmed `connection: Paired` while the physical route was USB.
- The display service deliberately stops sending frames on an unchanged Home
  screen, and resumes immediately on a screen change. An idle keyframe request
  did not force an image, so it was not retained. Idle proof now requires a valid
  video sender report whose packet count matches the received sequence span and
  whose last complete frame matches the exact displayed RTP timestamp. This
  retains an unchanged picture without fabricating a new frame timestamp. Lock,
  reconnect, missing packets, incomplete frames, and expired proofs still require
  fresh pixels. The Rust and Swift regression tests cover these distinctions.

After these corrections, the user confirmed smooth USB → Wi-Fi → USB handover
on the installed build. The continuous trace recorded both route changes without
a media-process exit or capture restart. Unplugging still produced an internal
Connecting → Ready interval of about 1.7 seconds; this is a lifecycle measurement,
not a measured visual or input interruption. The separate three-minute API sampler
finished before the cable cycle, so it does not establish uninterrupted command
availability during handover. Audio diagnostics included some drops/rebuffering;
the successful perceptual check does not imply zero packet loss or sample-perfect
audio continuity.

The final `bun run verify`, 10 Rust tests, Clippy, and signed Mac build passed.
Keep-awake was restored and temporary reconnect tracing was disabled afterward.

## Build and diagnostics

`bun run app` builds the optional helper when Xcode 27, its CoreDevice framework,
and Cargo are available. Rust is build-time only. Run `cargo test --locked` and
`cargo clippy --all-targets --locked -- -D warnings` from `native/` for Rust checks.

Existing opt-in reconnect tracing also records paired video counters and audio
queue counters. Audio diagnostics contain counts and timings, never audio data.
Do not publish runtime traces: other trace events contain local device metadata.
