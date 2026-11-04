# Permissions

The gear beside App Switcher, or **⌘,**, opens Settings over the same blurred
frame used by the lock screen. Settings belongs to its window; permission
decisions belong to the signed Mac app and apply to every device window.

| macOS permission | Allowed                               | Declined or restricted                                                     |
| ---------------- | ------------------------------------- | -------------------------------------------------------------------------- |
| Camera           | Native USB video through AVFoundation | Basic video from the phone helper's screenshot stream; controls still work |
| Microphone       | Device audio with native USB video    | Silent video; input and video startup are unaffected                       |

Both can be declined. Basic video has lower performance and no device audio.
The phone helper must still be installed, trusted, connected and unlocked. Mac
permissions cannot replace USB trust, Developer Mode or the phone's UI automation
approval. iPortal does not request Mac Screen Recording or Accessibility access.
The menu-bar watcher's Open at Login setting is independent of capture permissions.

## State and lifecycle

- Every displayed permission state comes from AVFoundation, not a saved preference.
- The top-aligned overlay contains only Camera and Microphone switches. Each is
  on only when macOS reports authorization; no optimistic state is stored.
- Opening Settings before video is ready keeps the underlying image covered
  until the first frame supplies its blurred backdrop. Late snapshot callbacks
  cannot update a closed overlay or a replacement video session.
- Enabling an undecided permission shows the system prompt. Changing a previously
  decided permission opens its macOS Privacy & Security page; an app cannot grant
  or revoke its own system authorization. Restricted/unavailable switches are disabled.
- Watcher controls remain at the app level (right-click the menu-bar icon).
  Clipboard transfers remain in Edit; connecting/reconnecting never reads the
  clipboard or requests Paste access.
- Foreground, wake, request completion, opening Settings and capture errors refresh
  state. AVFoundation offers no public permission-change event, so a one-second
  fallback runs only while at least one Settings overlay is open.
- Camera denial skips native capture and its retry budget. Granting it resets the
  capture budget and starts native video when the device is available. Input still
  requires a fresh frame and a ready phone helper.
- Microphone requests do not hold up video. Audio output changes serialize with
  capture configuration; closing a window cancels its queued changes. Denied,
  restricted and unknown statuses never cause repeated system prompts.
- Concurrent windows share one pending request per permission. All active windows
  observe changes, while audio volume and video sessions remain device-specific.
- Settings blocks phone clicks, typing, paste, scrolling, pinch and toolbar actions
  through its closing transition. Pending gestures are discarded, and stale
  document or animation callbacks cannot re-enable input.

macOS may require quitting and reopening the app after a privacy change. The app
reads the current permissions on every launch; it never claims it can bypass a
system-required restart. Existing grants survive rebuilds when the signing
identity and bundle identity remain unchanged.

## Verification

`bun run verify` exercises shared prompts, denial, restriction, revocation,
restoration, optional microphone access, capture-update ordering/cancellation,
and the Settings input gate. These tests inject authorization states; they do not
change the developer machine's privacy settings.

The 2026-11-04 installed-app checks verified real Camera/Microphone denial and
restoration after macOS Quit & Reopen. On the connected iPhone:

- Camera denied: basic video, Home control and the blurred Settings frame worked.
- Both denied: basic video and App Switcher still worked.
- Camera allowed, Microphone denied: native capture reached fresh-frame/video/input
  readiness without requesting microphone access again.

The test exposed two previously hidden fallback bugs. WKWebView rejects streaming
reads of a `multipart/x-mixed-replace` response, so the canvas client now requests
`/stream?raw=1` with `application/octet-stream`. The framed bytes are unchanged;
direct `/stream` clients retain the multipart content type. WDA also emits an extra
CRLF between frames; the parser now accepts it even across split reads. An actual
WKWebView probe decoded the phone stream with zero failures, and regression tests
cover both transport modes and split/coalesced frame separators.

macOS kept reporting the previous effective permission until its requested
restart. Real permission states, gear/Escape dismissal, smaller-window layout,
and the snapshot blur were checked in the installed app. Both original grants
were restored after testing. Automated tests simulate restricted access and
multi-window requests; those states were not physically tested.
