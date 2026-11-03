# Menu-bar watcher

The native Mac process keeps an IOKit USB observer and status item alive after
the mirror window closes. Dock Quit and Command-Q stop mirroring and return to
that lightweight state. The settings menu's **Quit iPhone Portal** exits the
whole app. System logout, restart and shutdown requests are allowed through.

Open at Login uses `SMAppService.mainApp`. Login launches and `--background`
start only the watcher; normal launches still open the mirror. No Node server,
XCTest runner, video capture, lifecycle polling or WebKit view is kept for the
watcher. Closing mirroring stops its owned server; an independently started
server is left alone.

USB arrivals open an anchored list of attached iPhones. Each play action carries
the selected USB serial through to the server's UDID argument. The list retains
unavailable rows for two seconds through USB mode changes, disabling their play
actions immediately. Reattachment cancels removal, and repeated updates cannot
extend removal indefinitely. The invitation gate suppresses duplicate attach
notifications and short re-enumeration gaps.

Names come from a bounded, event-triggered local `devicectl list devices` query,
filtered to physical USB-attached devices and cached locally by UDID. The USB
product name is the fallback. No name polling runs in the background.

One custom panel outline defines the translucent backdrop and animated border,
including the top notch. It is positioned from the status button's screen
coordinates, clamped to the display edge, and dismissed on outside click or
Escape. Reduce Motion uses a static border.

## Verification

- macOS Release build and strict signature verification pass.
- `npm test`: 45 unit tests plus e2e, guarded input, native contract, helper patch,
  capture lifecycle and native lifecycle checks pass.
- Native lifecycle tests cover row retention/expiry, reattachment, multiple
  device rows, modern/legacy UDIDs, invitation suppression, and quit routing.
- On the connected iPhone, the panel displays its configured Unicode name and
  the play action opens native mirroring. The installed panel's gray play button
  and beam around the notch were visually checked.
- Open at Login was enabled and its menu checkmark verified. Actual logout/login
  and multiple physical iPhones were not exercised.
- Command-Q was checked on the installed build: the same native process remains,
  the mirror closes, and its Node server, XCTest runner and port 7100 listener
  stop. Dock Quit uses the same termination delegate.
