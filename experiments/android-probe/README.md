# Android probe

A throwaway feasibility check for [the Android assessment](../../docs/android-assessment.md).
It is not part of iPortal and changes nothing in the product.

`Probe.java` runs on the phone as the adb `shell` user through `app_process`,
the same way scrcpy's server does. It is not an app: nothing is installed or
signed, and the phone shows no permission prompt beyond the existing USB
debugging authorisation. It uses hidden framework APIs through reflection.

## Run

Needs a JDK, an Android SDK with `platform-tools`, one `build-tools` version and
one `platforms/android-*`, and one authorised device. Unlock the phone first.

```sh
./run.sh                      # all steps
./run.sh video tree           # selected steps: input clipboard video hevc tree audio
KEEP_STREAM=/tmp/out.h264 ./run.sh video
```

The script opens Settings (the probe drags on its list and types into its search
field), runs the probe, presses Home and deletes what it pushed to
`/data/local/tmp`. Do not run the `tree` step on the lock screen: it clicks the
first element whose text contains "search", which can be a notification.

## Steps

| Step            | What it exercises                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| `input`         | `InputManager.injectInputEvent`: one-finger drags, asynchronous and wait-for-finish, then a two-finger spread |
| `clipboard`     | `IClipboard` read, write, read back, restore, as `com.android.shell`                                          |
| `video`, `hevc` | Mirror display 0 into a hardware `MediaCodec` encoder; time from an injected drag to the next encoded frame   |
| `tree`          | `UiAutomation`: tree walk, screenshot, `ACTION_CLICK`, Unicode `ACTION_SET_TEXT`                              |
| `audio`         | `AudioRecord` on `REMOTE_SUBMIX` while the probe plays a 440 Hz tone                                          |

## Results, Pixel 6a, Android 17 (API 37), USB, 2026-11-10

- Input: every event accepted. About 1 ms per event asynchronously, 3–4 ms when
  waiting for the app to finish handling it.
- Clipboard: round trip of text with accents, emoji and no prompt; 1–4 ms per call.
- Video: `c2.exynos.h264.encoder` and `c2.exynos.hevc.encoder` at 1080×2400,
  first frame 90–165 ms after starting setup. Injected drag to next encoded frame:
  55–66 ms over eight samples (H.264, Settings list), 40–56 ms on the lock screen.
  `ffprobe` read the pulled stream as H.264 High, 1080×2400.
- Tree: 155 nodes in Settings in 83 ms on the first walk, 3–8 ms afterwards.
  Screenshot 80–125 ms, 105–145 ms including JPEG encoding.
  Click accepted in 4–19 ms; `héllo 👋 日本語` set and read back.
- Audio: capture started in 70–250 ms. The tone was recovered as a clean 440 Hz
  signal, but 36 dB below its source level, and the same at media volume 5 and 25.
  The cause is not established.

These timings are measured on the phone. They exclude adb transport, decoding and
display on the Mac, so they are not end-to-end latency.
