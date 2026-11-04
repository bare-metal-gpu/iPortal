<p align="center">
  <img src="docs/banner.png" alt="iPortal — a glass-engraved title and Dynamic Island symbol against a sparse star field" width="100%" />
</p>

**Getting this in the EU?**

<img src="docs/eu-error.png" width="320" alt="Unable to Connect to iPhone. iPhone Mirroring is not available in your country or region." />

Apple doesn't offer iPhone Mirroring in the EU. This app is the fix: it lets you see and control your iPhone from your Mac, just like iPhone Mirroring, wherever you are.

## Install

You need macOS 14+, full Xcode, Node 22.19+ and an Apple ID (a free one is fine).

1. Xcode → Settings → Accounts: add your Apple ID.
2. Plug in your iPhone, unlock it, tap **Trust**.
3. iPhone: Settings → Privacy & Security → **Developer Mode** → On.
4. Run:

```bash
git clone https://github.com/bare-metal-gpu/iPortal && cd iPortal
npm ci
npm run setup   # builds the helper app for your iPhone
npm run app     # installs "iPortal" to ~/Applications
```

5. Open **iPortal** and allow Camera and Microphone access when asked.
6. First launch only: on the iPhone, go to Settings → General → VPN & Device Management → trust your Apple ID.

## Use

Click to tap, drag to swipe, scroll to scroll, type to type.

Closing the mirror, choosing Quit in the Dock, or pressing ⌘Q leaves the menu-bar
watcher running in a separate native helper. Connect an iPhone to see its name and press the trailing play
button to mirror it. iPads work the same way. Press Play for another connected
device to open its own mirror; pressing Play again focuses its existing window.
Keyboard shortcuts and audio controls apply to the focused window. Closing one
mirror leaves the others running. The menu-bar settings include **Open at Login** (starts only
the watcher) and **Quit iPortal** (stops everything).

| Shortcut     | Action                          |
| ------------ | ------------------------------- |
| ⌘1 / ⌘2 / ⌘3 | Home / App Switcher / Spotlight |
| ⌘V           | Paste your Mac clipboard        |
| ⌘+ / ⌘− / ⌘0 | Window size                     |

Prefer the browser? Run `npm start` and open http://localhost:7100.

## Good to know

- Connect the iPhone by USB. Locking blurs the last frame; unlocking automatically restores control after a fresh frame arrives.
- With a free Apple ID, run `npm run setup` again every 7 days.
- The iPhone's sound plays on your Mac while mirroring.
- Each additional iPhone or iPad needs the same one-time helper setup and trust.
  Select it with `UDID=<device-udid> npm run setup`; `node iportal.mjs devices` lists connected IDs.
- When macOS cannot identify a native USB video source unambiguously among several
  devices, that window uses its device's screenshot stream. Device names are never
  used to guess which screen to show.

The Mac app builds through `macos/iPortal.xcodeproj` so Xcode compiles BorderBeamKit’s Metal shader and embeds its resources. The dependency tracks Libraries.dev’s `main` branch, with the resolved commit checked in. The phone window has 56-point corner resize targets with proportional sizing, and its loading background uses the same translucent blur as the toolbar. A border beam indicates startup, reconnecting, video loading, and pending input; it fades away when ready. The centered loading message pairs ThinkingOrbsKit’s `connecting` orb with shimmering Inter text on a transparent background. Inter is bundled with its SIL Open Font License. Reduce Motion uses static indicators. If Xcode reports a missing Metal Toolchain, install it once with `xcodebuild -downloadComponent MetalToolchain`.

## Automation API

The Effect 4 server supports validated input, selector-based taps and typing, UI/device inspection, screenshots, verified transitions, retry-safe command receipts, and timed keep-awake. Browser access checks and device selection happen automatically; no sign-in or pairing prompts are added. See [the API reference](docs/api.md) for routes, examples, errors, and real-phone verification.

See [multi-device lifecycle and verification](docs/multi-device.md) for session isolation and current hardware test coverage.

## Development

Run `npm ci`, then `npm run verify` before submitting changes. This checks types,
lint, formatting, and the regression suite. The full suite needs macOS and Xcode;
it uses simulated phones and does not interact with a connected device.

- `npm run typecheck` — TypeScript checks Node modules, scripts, tests, and browser code without emitting files.
- `npm run lint` / `npm run lint:fix` — Oxlint checks correctness, imports, and promise handling; the fix command applies safe fixes only.
- `npm run format` / `npm run format:check` — Oxfmt formats or verifies supported source, configuration, HTML/CSS, and documentation files.
- `npm run check` — Run all three static checks.

Tool versions are pinned in `package.json` and `package-lock.json`. Type checking
uses `checkJs` and strict null checks with Node 22 types. Existing JavaScript
parameters and caught errors remain permissive (`noImplicitAny` and
`useUnknownInCatchVariables` are disabled); this is not a full strict-TypeScript
migration. Add JSDoc at module boundaries and for mutable nullable state. Effect
schemas validate API requests; existing endpoint checks validate upstream responses.

Node and browser globals are checked separately. `public/iportal.js` stays a
classic script so the Mac can call its named entry points; `web-assets.mjs`
inlines it into the HTML response without an extra request or compilation step.
Oxlint explicitly checks floating/misused promises, dependency cycles, duplicate
imports, unused variables, equality, and unsafe evaluation. Intentional background
work uses `void` after arranging its error handling. Console output and synchronous
filesystem operations remain allowed for the CLI, installers, and receipt store.

Oxfmt uses two spaces, double quotes, semicolons, trailing commas, and a 100-column
target. Import order is preserved. Vendored code, build output, lockfiles, and
native-language files are outside its formatting scope. See the
[Oxlint configuration guide](https://oxc.rs/docs/guide/usage/linter/config) and
[Oxfmt configuration guide](https://oxc.rs/docs/guide/usage/formatter/config).
