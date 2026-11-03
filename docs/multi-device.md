# Multiple iPhones and iPads

The existing menu-bar list now accepts physical iPhones and iPads. Each Play
action opens or focuses the selected device's window. A normal launch still opens
one window, preferring the last used attached device. With no device attached it
shows Disconnected and binds that waiting window when a compatible device arrives.
Other USB Apple products are not advertised as mirrorable.

## Ownership and lifecycle

- The app coordinator indexes `MirrorSession` objects by normalized USB UDID.
  USB re-enumeration changes an attachment ID, never the window's target.
- Each session owns its window, WebKit document, gesture tracking, status stream,
  capture retry budget, frozen frame, server instance and reconnect state.
  Menu commands resolve the key window first. Closing one session cannot stop
  another; last-window close and application Quit still leave the native watcher.
- Each server binds exclusively to one device. Local WDA/MJPEG ports are allocated
  by the OS. HTTP prefers 7100 and falls back to an OS-assigned port when occupied.
  A private launch pipe reports the bound port; health checks verify both launch
  owner and UDID before loading the page. No unrelated existing server is adopted.
- A per-device Unix socket lease prevents duplicate controllers. A stale socket
  is removed only after connection refusal and an inode check. Graceful shutdown
  retains the lease until its owned test launcher exits, with a bounded kill.
  Test launchers use shared immutable products and separate result bundles.
  Recovery never uses a global process-name kill.
  A lifetime-pipe supervisor also stops the owned launcher after a server crash;
  teardown escalates only that child if it does not respond to termination.
- Command receipts and helper logs are per device. A transport generation aborts
  in-flight/queued commands and closes old tunnels on detach or re-enumeration;
  stale input does not execute on the next attachment. Other devices' generations,
  keep-awake leases and command queues are unchanged.
- Native readiness still requires matching document, server, device and observation
  epoch plus a fresh frame. Reconnect keeps only that window's frozen frame.

## Capture and iPad layout

Native capture uses a matching device identifier, or the existing unambiguous
single-USB/single-iOS-source fallback. Cached/display names are labels, not identity.
Ambiguous multi-device sources use the existing per-device MJPEG fallback; this can
be less smooth than native video. An already-running native iPhone capture stays
running when another device is attached. No camera source is shared by two sessions.
An ambiguous identity defers further native retries until USB inventory changes,
so a working fallback stream is not periodically frozen by futile retries.

Capture configuration/teardown is serialized per source, so a stalled device cannot
block another device's capture. Concurrent permission requests coalesce, and prior
camera/audio decisions are reused. Stable development signing remains necessary
for permissions to survive changed builds.

iPads start with tablet proportions and smaller screen corners; reported frame
dimensions continue to drive resizing and rotation. Controls keep the existing
layout. Device icons and short device-specific text adapt to iPad. The existing
helper and embedded status framework already target iPhone and iPad; each physical
device still needs provisioning, Developer Mode and trust.

## Verification

`npm test` includes two simulated devices behind the same USB multiplexer. It checks
independent HTTP/tunnel ports, owner/UDID health checks, separate receipts, iPad
coordinate scaling, two streams, locking one device, cancelling queued input on
detach, reattachment with a new USB ID, closing/reopening, and crash/lease recovery
while the other device remains live. Native tests exercise registry ownership,
late-close rejection, iPad classification/geometry, ambiguous capture rejection,
USB row independence and per-source capture concurrency. Existing single-device
tests remain in the suite.

The connected physical iPhone has been checked for startup, live native video,
menu shortcut targeting, keep-awake and locked startup. Quit stopped the main app,
server and launcher while preserving the watcher; reopening started one targeted
session. The signed update reused camera/microphone
permissions without prompting. Only one physical device is available: simultaneous
physical captures, iPad rotation/audio and second-device provisioning remain
hardware validation items, not measured claims.

The user also completed a physical USB unplug/replug and confirmed smooth recovery.
The server retained the same pinned UDID across new USB attachment IDs, and the
keep-awake lease was restored after the capture-mode USB re-enumeration settled.
The final installed build was reopened and visually checked with live native video
and a fresh 30-minute keep-awake lease.
