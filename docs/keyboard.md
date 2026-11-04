# Keyboard input

The Mac window keeps an invisible text-input client focused so macOS can compose
Unicode, dead-key, and input-method text. Only committed text is sent. Editing
keys are separate ordered commands, with buffered text flushed before navigation
or selection. Native Edit menu actions target the active device window; Settings,
lock, disconnect, and a new video epoch prevent stale input from being forwarded.

## Why typing made the keyboard collapse

On the tested iPhone, both WDA's ordinary text path and direct
`_XCT_sendString` briefly hid and reopened the software keyboard. XCTest's
keyboard sender changes the hardware-keyboard state. Switching to `typeKey`
alone did not solve it: it hid the keyboard and rejected supplementary Unicode
characters such as emoji.

`/wda/mirror/text` and `/wda/mirror/key` now compose Recap events using the touch
sender already used by keep-awake. Text uses Unicode events; editing uses HID
keys with modifier down/up in the same bounded stream. Playback still goes
through the XCTest daemon and waits for acknowledgement. It never activates or
refocuses an app, changes keyboard settings, or uses the clipboard for ordinary
typing. Unsupported runtimes return an error instead of silently reverting to
the flickering path. These private APIs require verification on new iOS versions.

## Verified on the connected iPhone, 2026-11-04

- Recorded slow letters, backspace, accented text, and emoji: the software
  keyboard remained visible throughout.
- Character navigation, Shift-selection/replacement, Command-A, Command-Left,
  forward delete, Option-Backspace, and Command-Z produced the expected field
  values in Settings search.
- Composed `café 👋 日本語 é` text was preserved; deletion worked afterward.
- Through the installed Mac window, Command-A, `abc`, Backspace, Left Arrow,
  and `x` produced `axb`. The recording showed no keyboard dismissal.
- Automated coverage checks committed composition only once, text-before-key
  ordering, Settings isolation, unrelated Mac shortcuts, malformed key/modifier
  input, stale application and locked-device rejection, and native validation.

Behavior such as Undo, Tab, Home, and Page Up remains controlled by the focused
phone app. Clipboard Copy/Cut is a separate explicit transfer and may briefly
foreground the helper or require iOS Paste permission. Selector-targeted `/type`
continues to use XCTest's element action; the device window uses the new focused
text path.
