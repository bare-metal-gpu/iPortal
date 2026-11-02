# Completion-delay experiment

Development-only routes; no normal mirror UX or production route is changed. The recorder source is shared with the streaming-touch experiment. Main checkout and its installed build remain untouched.

The experiment distinguishes three facts:

1. Empty runner-local Recap playback with completion delay enabled/disabled verifies whether the iOS runtime itself contains the suspected delay, without generating any HID events.
2. Real daemon taps at confirmation intervals 0, 50 and 300 ms measure input onset, touch lifetime and callback-after-touch-end, using UIKit events from the same runner process and monotonic uptime.
3. Runner-local full-tap Recap playback tests whether disabling completion delay can deliver input under the existing signing/entitlement boundary. Prewarm must succeed. A fast callback without matching UIKit began/ended events is **not** an improvement.

No system daemon is modified, no entitlement is added, and queue ownership is retained until the actual callback. Nonempty tests target only the foreground runner recorder, in portrait, with bounded complete taps. Reset and hide refuse to discard active-contact evidence. The recorder holds the foreground app’s idle timer only while visible, restoring the previous value when hidden or backgrounded; no keepalive HID pulses contaminate measurements. The harness hides an idle recorder in its finalizer.

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

The signed iPhone helper builds successfully. Installer repeatability and JavaScript syntax checks pass. Physical tests completed in an exclusive phone slot on 3 November 2026. Eighteen daemon taps delivered matching UIKit began/ended events. The raw runner-local path did not get past prewarm. Production remains unchanged.

`empty-playback-macos.m` runs a zero-event smoke test on macOS. The recorded five-sample medians were **200.319 ms** with the completion delay enabled and **0.025 ms** with it disabled. The stream contains no HID events. This confirms the callback/selector contract and the delay in macOS Recap; it is not proof that iOS permits runner-local touch delivery. The raw results are in `macos-empty-playback-results.json`.

```sh
xcrun clang -fobjc-arc -framework Foundation scripts/delay-prototype/empty-playback-macos.m -o vendor/empty-playback-macos
vendor/empty-playback-macos
```

## Physical results

The actual iPhone runtime confirms the completion-delay switch: five empty-stream samples had median **202.02 ms** with delay enabled versus **1.18 ms** with it disabled (the harness polls at 1 ms). Empty streams contain zero input events.

Real daemon taps retained the completion tail at all three implicit-confirmation intervals:

| Requested tap | Confirmation 0 ms | Confirmation 50 ms | Confirmation 300 ms |
| --- | ---: | ---: | ---: |
| 60 ms | 280.31 ms | 280.00 ms | 282.60 ms |
| 250 ms | 470.96 ms | 464.05 ms | 462.92 ms |

These are native callback medians, three samples per cell. UIKit observed touch onset 23–39 ms after the daemon invocation; the callback arrived roughly 175–196 ms **after** UIKit touch end. This is principally a completion/throughput tail, not an equivalent delay before touch-down. HTTP, host preflight, browser recording and display capture are excluded from those native onset numbers.

The direct runner-local candidate used logical 402×874 geometry and scale 1, matching the streaming experiment's successful raw delivery calibration. Its virtual-HID-service prewarm did not complete. A 3-second bound returned unsupported operation with no events dispatched; the recorder remained empty and activeCount zero. A second call was rejected while prewarm remained pending. The log identifies virtual service creation, but does not prove the precise cause. No privilege changes or daemon modifications were attempted.

**Conclusion:** the 200 ms delay is verified on iOS and removable for a player we own, but no working mechanism was found to remove it from real daemon-mediated touches under the current signing/permission boundary. Lowering confirmation to zero does not solve it. A fast local callback without UIKit delivery would not count as a fix.

`phone-results.json` preserves the grouped timings and local failure evidence. The parent owns restoring the production runner after the exclusive test slot.
