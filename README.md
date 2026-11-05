<p align="center">
  <img src="docs/banner.png" alt="iPortal — a glass-engraved title and Dynamic Island symbol against a sparse star field" width="100%" />
</p>

**Getting this in the EU?**

<img src="docs/eu-error.png" width="320" alt="Unable to Connect to iPhone. iPhone Mirroring is not available in your country or region." />

Apple doesn't offer iPhone Mirroring in the EU. This app is the fix: it lets you see and control your iPhone from your Mac, just like iPhone Mirroring, wherever you are.

## Install

You need macOS 14+, full Xcode, Bun 1.4.4+ and an Apple ID (a free one is fine).

1. Xcode → Settings → Accounts: add your Apple ID. Under Manage Certificates, create an Apple Development certificate if you do not have one.
2. Plug in your iPhone, unlock it, tap **Trust**.
3. iPhone: Settings → Privacy & Security → **Developer Mode** → On.
4. Run:

```bash
git clone https://github.com/bare-metal-gpu/iPortal && cd iPortal
bun install --frozen-lockfile
bun run setup   # builds the helper app for your iPhone
bun run app     # installs "iPortal" to ~/Applications
```

5. Open **iPortal**. Camera access enables smoother USB video; Microphone access enables device audio. Both are optional.
6. First launch only: on the iPhone, go to Settings → General → VPN & Device Management → trust your Apple ID.

### Wireless

On an Apple silicon Mac with Xcode 27 and an iPhone/iPad running iOS/iPadOS 27+,
iPortal can use Xcode's existing paired network connection. Complete the USB setup
above, keep the device on the same local network, and enable **Connect via network**
in Xcode's Devices and Simulators window if it is not already available. The same
menu-bar device list and mirror window are used; no extra iPortal pairing is needed.

Plugging USB in lets the paired connection move to the wired route; unplugging
returns it to the network without replacing the device window or helper session.
A small Wi-Fi symbol beside the traffic lights shows the reported network
route. The same symbol in the device list identifies a reachable paired network
device; Play keeps its existing behavior. The symbol fades on route changes and
respects Reduce Motion.

Building this optional transport also requires Rust/Cargo (`~/.cargo/bin/cargo`,
or the `CARGO` environment variable). It is compiled into the app; users of the
built app do not need Rust. Without the optional transport, USB capture still works.
See [wireless implementation and verification](docs/wireless-implementation.md)
for compatibility limits and measured results.

The installed Mac app contains its compiled Bun/Effect server, browser assets,
font, and signed phone helper. It can run after the checkout is moved or removed,
without Node, Python, or a separately installed Bun. Xcode is still required to
launch the phone helper. Helper logs and command receipts live in
`~/Library/Application Support/iPortal`; Mac session logs remain in `~/Library/Logs`.
The app bundle stays read-only.

For stable Mac signing across rebuilds, select your Apple Development identity
once with `IPORTAL_CODE_SIGN_IDENTITY="<certificate SHA-1>" IPORTAL_DEVELOPMENT_TEAM="<team ID>" bun run app`.
Use `security find-identity -v -p codesigning` to list identities. The build remembers
the selection locally; otherwise it uses ad-hoc signing. Setup reuses the saved
phone/Mac team, with `bun run setup -- <TEAM_ID>` as an explicit override.

## Use

Click to tap, drag to swipe, scroll to scroll, type to type.

Click the pin beside Settings to keep that device window above other app windows.
Click it again to restore normal window ordering. The pin and **Window → Keep on Top**
stay in sync; each device window has its own state.

Open the gear beside App Switcher (or press ⌘,) to manage permissions. Settings
reflects macOS’s current state across all device windows. With legacy USB capture, without Camera access,
mirroring uses basic video from the phone helper; without Microphone access,
video continues silently. Paired native capture obtains video and device audio
from the phone and does not use either Mac capture permission.
See [permission behavior](docs/permissions.md).

Settings shows Camera and Microphone as native switches that reflect macOS authorization.
Use the Edit menu to transfer clipboard text, links, or an image. Transfers happen
only when requested; connecting never reads the clipboard or asks for Paste access.
The phone briefly opens iPortal for a transfer, then returns to the previous app.
iOS may ask you to allow Paste. Sending a clipboard item makes it available to Paste
on the device; ⌘V still inserts text directly.

Closing the mirror, choosing Quit in the Dock, or pressing ⌘Q leaves the menu-bar
watcher running in a separate native helper. Connect an iPhone to see its name and press the trailing play
button to mirror it. iPads work the same way. Press Play for another connected
device to open its own mirror. An open mirror shows Pause for that device; Pause closes only its window and
stops its session. Play returns once that session has finished stopping.
Keyboard shortcuts and audio controls apply to the focused window. Closing one
mirror leaves the others running. Right-click the menu-bar icon for **Open at Login** (starts only
the watcher) and **Quit iPortal** (stops everything).

| Shortcut            | Action                                                      |
| ------------------- | ----------------------------------------------------------- |
| ⌘1 / ⌘2 / ⌘3        | Home / App Switcher / Spotlight                             |
| ← / →, ⇧ + arrows   | Move the cursor / extend the selection                      |
| ⌥ + arrows / Delete | Move by word / delete a word                                |
| ⌘A / ⌘C / ⌘X        | Select all / copy / cut the device selection                |
| ⌘Z / ⇧⌘Z            | Undo / redo in the device app                               |
| ⌘V                  | Insert clipboard text on the device                         |
| ⇧⌘C / ⇧⌘V           | Copy device clipboard to Mac / send Mac clipboard to device |
| ⌘+ / ⌘− / ⌘0        | Window size                                                 |

Text, deletion, and navigation preserve the on-screen keyboard. Unicode and committed Mac input-method text are supported. Editing behavior follows the focused device app. Copy and Cut transfer a changed device clipboard back to the Mac using the same brief helper handoff.

Prefer the browser? Run `bun start` and open http://localhost:7100.

## Good to know

- Connect the iPhone by USB or use its supported paired network connection. Locking blurs the last frame; unlocking automatically restores control after a fresh frame arrives.
- With a free Apple ID, run `bun run setup` and `bun run app` again every 7 days to refresh the bundled phone helper.
- The iPhone's sound plays on your Mac with paired native capture, or with legacy native USB video and Microphone access. Protected media may omit capture audio.
- Each additional iPhone or iPad needs the same one-time helper setup and trust.
  Select it with `UDID=<device-udid> bun run setup`, then run `bun run app` to update the installed helper; `bun iportal.mjs devices` lists connected IDs.
- When macOS cannot identify a native USB video source unambiguously among several
  devices, that window uses its device's screenshot stream. Device names are never
  used to guess which screen to show.

The Mac app builds through `macos/iPortal.xcodeproj` so Xcode compiles BorderBeamKit’s Metal shader and embeds its resources. The dependency tracks Libraries.dev’s `main` branch, with the resolved commit checked in. The phone window has 56-point corner resize targets with proportional sizing, and its loading background uses the same translucent blur as the toolbar. A border beam indicates startup, reconnecting, video loading, and pending input; it fades away when ready. The centered loading message pairs ThinkingOrbsKit’s `connecting` orb with shimmering Inter text on a transparent background. Inter is bundled with its SIL Open Font License. Reduce Motion uses static indicators. If Xcode reports a missing Metal Toolchain, install it once with `xcodebuild -downloadComponent MetalToolchain`.

## Automation API

The Effect 4 server supports validated input, selector-based taps and typing, UI/device inspection, screenshots, verified transitions, retry-safe command receipts, and timed keep-awake. Browser access checks and device selection happen automatically; no sign-in or pairing prompts are added. See [the API reference](docs/api.md) for routes, examples, errors, and real-phone verification.

See [multi-device lifecycle and verification](docs/multi-device.md) for session isolation and current hardware test coverage.

## Development

Run `bun install --frozen-lockfile`, then `bun run verify` before submitting changes. This checks types,
lint, formatting, and the regression suite. The full suite needs macOS and Xcode;
it uses simulated phones and does not interact with a connected device.

Verification also compiles the server and repeats the USB, lifecycle, streaming,
and multi-device checks from a temporary directory with no Node or Bun on the
server's PATH. `bun run build:server` builds the executable separately. The server
uses `@effect/platform-bun` with the existing Effect 4 schemas; `node:` imports
use Bun's compatibility APIs and do not require Node. The optional real-phone
benchmark uses Bun and a Swift image sampler, with no Python dependencies.

- `bun run typecheck` — TypeScript checks server modules, scripts, tests, and browser code without emitting files.
- `bun run lint` / `bun run lint:fix` — Oxlint checks correctness, imports, and promise handling; the fix command applies safe fixes only.
- `bun run format` / `bun run format:check` — Oxfmt formats or verifies supported source, configuration, HTML/CSS, and documentation files.
- `bun run check` — Run all three static checks.

Bun is pinned in `package.json` and CI; dependencies are pinned in `bun.lock`. Type checking
uses `checkJs` and strict null checks with Bun types. Existing JavaScript
parameters and caught errors remain permissive (`noImplicitAny` and
`useUnknownInCatchVariables` are disabled); this is not a full strict-TypeScript
migration. Add JSDoc at module boundaries and for mutable nullable state. Effect
schemas validate API requests; existing endpoint checks validate upstream responses.

Bun and browser globals are checked separately. `public/iportal.js` stays a
classic script so the Mac can call its named entry points; `web-assets.mjs`
inlines it into the HTML response without an extra request or compilation step.

App-owned native text and colors use `shared/Appearance.swift`, compiled into
the Mac app, menu-bar watcher, and iPhone/iPad status UI. Each process registers
the bundled Inter variable font. The browser uses matching CSS colors and the
same font through a locally served, fingerprinted URL. Native menus, dialogs,
switches, and SF Symbols retain their system styling. Layout dimensions and
animation timing belong to their existing components.
Oxlint explicitly checks floating/misused promises, dependency cycles, duplicate
imports, unused variables, equality, and unsafe evaluation. Intentional background
work uses `void` after arranging its error handling. Console output and synchronous
filesystem operations remain allowed for the CLI, installers, and receipt store.

Oxfmt uses two spaces, double quotes, semicolons, trailing commas, and a 100-column
target. Import order is preserved. Vendored code, build output, lockfiles, and
native-language files are outside its formatting scope. See the
[Oxlint configuration guide](https://oxc.rs/docs/guide/usage/linter/config) and
[Oxfmt configuration guide](https://oxc.rs/docs/guide/usage/formatter/config).
