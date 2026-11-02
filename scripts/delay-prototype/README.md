# Completion-delay experiment

Development-only routes; no normal mirror UX or production route is changed. The recorder source is shared with the streaming-touch experiment. Main checkout and its installed build remain untouched.

The experiment distinguishes three facts:

1. Empty runner-local Recap playback with completion delay enabled/disabled verifies whether the iOS runtime itself contains the suspected delay, without generating any HID events.
2. Real daemon taps at confirmation intervals 0, 50 and 300 ms measure input onset, touch lifetime and callback-after-touch-end, using UIKit events from the same runner process and monotonic uptime.
3. Runner-local full-tap Recap playback tests whether disabling completion delay can deliver input under the existing signing/entitlement boundary. Prewarm must succeed. A fast callback without matching UIKit began/ended events is **not** an improvement.

No system daemon is modified, no entitlement is added, and queue ownership is retained until the actual callback. Nonempty tests target only the foreground runner recorder, in portrait, with bounded complete taps. Reset refuses to discard active-contact evidence.

Build in this worktree only:

```sh
python3 scripts/delay-prototype/install.py
xcodebuild build-for-testing -project vendor/WebDriverAgent/WebDriverAgent.xcodeproj \
  -scheme WebDriverAgentRunner -destination id=PHONE_UDID -derivedDataPath vendor/build \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=TEAM_ID CODE_SIGN_STYLE=Automatic
```

With an exclusive phone test slot, start the built runner with `TEST_RUNNER_MIRROR_DELAY_EXPERIMENT=1 TEST_RUNNER_USE_IP=127.0.0.1`. These are xcodebuild test-runner environment variables. An isolated USB bridge must forward host 18100 to device 8100. POST `{ "mode": "show" }` to `/wda/mirror/experiment/delay`, then activate the returned runner bundle ID if needed. Run:

```sh
node scripts/delay-prototype/measure.mjs http://127.0.0.1:18100 /absolute/report.json
```

The route is disabled without the environment flag. It is not wired into the public mirror API. Only this experiment branch's installer includes it in WDA.

## Status and offline evidence

The signed iPhone helper builds successfully. Installer repeatability and JavaScript syntax checks pass. **No phone input has been dispatched by this experiment yet**: its exclusive phone slot is pending while another task finishes.

`empty-playback-macos.m` runs a zero-event smoke test on macOS. The recorded five-sample medians were **200.319 ms** with the completion delay enabled and **0.025 ms** with it disabled. The stream contains no HID events. This confirms the callback/selector contract and the delay in macOS Recap; it is not proof that iOS permits runner-local touch delivery. The raw results are in `macos-empty-playback-results.json`.

```sh
xcrun clang -fobjc-arc -framework Foundation scripts/delay-prototype/empty-playback-macos.m -o vendor/empty-playback-macos
vendor/empty-playback-macos
```
