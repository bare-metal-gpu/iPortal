# Menu-bar watcher

The bundled `iPortal Watcher.app` owns the status item and IOKit USB
observer. It is a separate `LSUIElement` app registered with
`SMAppService.loginItem(identifier:)`. The main app owns a separate mirror, server
and capture per selected device. Closing its last window, Dock Quit and Command-Q terminate that process
normally. The helper remains alive. The menu-bar settings' **Quit iPortal**
terminates both processes; logout and shutdown follow normal macOS behavior.

Open at Login applies only to the helper. Existing main-app login registration
is migrated after the helper registration succeeds. The helper opens the exact
containing app with an explicit selected-device request. Settings requests can
start the main process briefly without opening a window or starting the server.
Disabling Open at Login unregisters the helper, waits for its termination, then
relaunches it for the current session. Registration is refreshed after helper
code changes, and a process-lifetime file lock prevents concurrent launches from
creating duplicate status items.

No Node server, XCTest runner, video capture, lifecycle polling or WebKit view
runs inside the helper. Main-app termination stops its owned server; an
independently started server is left alone. Both processes share local device
name preferences, and workspace notifications track main-app launch/termination.

The main app publishes per-device window sessions when they open, bind, close,
or finish stopping. A distributed notification prompts the watcher to read the
latest snapshot; opening the popup also refreshes it. Snapshots are accepted only
while the owning PID and launch time match a running containing app. A crashed
or restarted app cannot leave stale Pause buttons behind. No polling is added.

Each active window shows Pause, including locked, reconnecting, minimized, or
unplugged windows. Pause closes only that device's window and stops its server.
The action carries the window session's UUID, so delayed clicks cannot close a
replacement. Its button stays disabled while stopping, then becomes Play if the
device is attached. Other device sessions keep running. An active disconnected
window stays listed until closed even after its USB row expires.

USB arrivals open an anchored list of attached iPhones and iPads. Each play action carries
the selected USB serial through to the server's UDID argument. The list retains
unavailable rows for two seconds through USB mode changes, disabling their play
actions immediately. Reattachment cancels removal, and repeated updates cannot
extend removal indefinitely. The invitation gate suppresses duplicate attach
notifications and short re-enumeration gaps.

Names come from a bounded, event-triggered local `devicectl list devices` query,
filtered to physical USB-attached devices and cached locally by UDID. The USB
product name is the fallback. No name polling runs in the background.

The popup uses the same active, behind-window `NSVisualEffectView` HUD material
as the mirror and toolbar. One custom panel outline masks the native blur and
defines the animated border, including the top notch. It is positioned from the status button's screen
coordinates, clamped to the display edge, and dismissed on outside click or
Escape. Reduce Motion uses a static border.

Clicking the status icon toggles the popup with a short fade. Outside-click
monitors exclude both the popup and the status icon, so mouse-down cannot dismiss
it before the icon's mouse-up action runs. Visibility follows the requested state;
stale fade completions cannot hide a popup reopened by a rapid click. Reduce Motion
uses immediate visibility changes. Regression tests cover icon/outside hit testing
and interrupted transitions; the installed helper's rapid toggles were confirmed
by the user.

## Building and diagnostics

The Xcode project embeds and signs the helper as a target dependency. For stable
local development signing, set `IPORTAL_CODE_SIGN_IDENTITY` and `IPORTAL_DEVELOPMENT_TEAM`
when running `macos/build.sh --install`; a successful build caches those public
identifiers under ignored `vendor/` files for subsequent builds. Without a
selected identity, the default remains ad-hoc signing. Use the install command
to replace the generated app bundle, rather than overwriting its executable in
place. The app refreshes Service Management registration when its helper's code
fingerprint changes.

Background launches wait for watcher preparation to finish before exiting. This
keeps the containing app alive through unregistering the old helper, waiting for
its process to stop, and registering its replacement after an update.

The installed main executable's `--watcher-status` argument prints the native
helper registration status, legacy main-app login status and helper PIDs, then
exits without launching a mirror. It does not request administrator access.
Native status values are 0 = unregistered, 1 = enabled, 2 = approval required,
3 = not found. A new bundled helper can report 3 before initial registration.

## Verification

- Release build and deep, strict signature verification pass for both apps.
- `npm test`: 50 unit tests plus e2e, guarded input, native contract, helper patch,
  capture lifecycle and native lifecycle checks pass.
- Native lifecycle tests cover request validation, selected-phone round trips,
  USB row retention/expiry, reattachment, multiple rows, invitation suppression,
  pause-token validation, and stale snapshots after crashes or PID reuse.
- The installed helper is registered and running as the native launchd job;
  the legacy main-app login registration is disabled. A second helper launch
  exits without creating another watcher.
- Dock Quit was exercised by the user and confirmed successful. Process checks
  afterward found the same watcher PID still running under launchd with no exit,
  while the main app, its Node server, XCTest runner and port 7100 listener were
  gone. Command-Q independently produced the same result.
- Play has reopened the main app with the selected phone's UDID. The popup uses
  the existing name, gray play button and notched border-beam view unchanged.
- Actual logout/login and multiple physical iPhones have not been exercised.

## Locked-phone startup

The server makes one bounded CoreDevice lock-state query per USB connection
while the phone helper is unavailable. It publishes the result asynchronously
without blocking status updates. Live Xcode launch output also reports a locked
phone immediately instead of waiting for the launch process to exit. A healthy
phone helper supplies the authoritative ongoing state. Results from an old USB
connection are discarded, and probe errors stay unknown.

On the connected locked phone, the installed server reported `locked: true` and
`lifecycle: locked` even while the helper was unavailable; the native app displayed
**Locked — Unlock your iPhone to continue**. Regression tests cover nonblocking
publication, one query per attachment, stale-result rejection and probe failures.
