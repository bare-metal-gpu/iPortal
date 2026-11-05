# Setup and troubleshooting

Start with the [installation steps](../README.md#install). Full Xcode is needed to build and launch the signed phone helper; Command Line Tools alone are insufficient. Use an Xcode version that supports your device's OS, open it once, and finish its component installation.

## Wireless builds

The optional paired transport requires an Apple silicon Mac, Xcode 27+, its installed CoreDevice framework, Rust/Cargo, and an iPhone or iPad on iOS/iPadOS 27+. Cargo is located at `~/.cargo/bin/cargo` by default; set `CARGO` to use another executable. Install it before running `bun run app`. Rust is needed only for building, not for running the installed app.

Complete USB trust and helper setup first. In Xcode → Window → Devices and Simulators, enable **Connect via network** if needed, and keep the Mac and device on the same local network. Discovery still needs a reachable, paired device; being on Wi-Fi alone is insufficient. A compatible OS version makes the transport eligible, but the installed runtime and negotiated media capabilities determine whether it can be used.

When the optional build prerequisites are absent, USB capture remains available. Cable handover keeps the same window and session, but a changing network can still briefly interrupt picture, audio, or controls.

## Compatibility

- **macOS 14+ and iOS/iPadOS 17+** are build targets, not a guarantee for every device combination. The helper uses private automation APIs that may change with OS updates.
- Recent physical wireless checks used **one iPhone on iOS 27.3**, an Apple silicon Mac, and Xcode 27.2. USB/Wi-Fi handover, rotation, input, and audio were checked on that setup.
- Older devices, physical iPads, and simultaneous physical-device mirroring need broader testing. Multi-device isolation and iPad geometry have automated coverage.
- If a native video path is unavailable, the app can use basic video from the helper, without audio. Wireless still requires a reachable paired device.

## Additional iPhones and iPads

Each device needs Developer Mode, USB trust, developer-app trust, and its own initial setup. List device IDs and select the intended device explicitly:

```bash
bun iportal.mjs devices
UDID="<device-udid>" bun run setup
bun run app
```

Use the menu-bar list to open a separate mirror for each available device. Shortcuts and audio controls apply to the focused window. Closing one window does not stop the others.

If a device falls back to basic video when several are attached, try it alone. The app will not guess which device owns an ambiguous USB video source.

## Trust and automation approval

If startup waits for trust or automation, check the device directly. Developer-app trust is under Settings → General → VPN & Device Management. iOS can also request a passcode to enable UI Automation; complete that prompt on the device. A clean reinstall may require trusting the helper again.

Free Personal Team provisioning expires seven days after issuance. Renew with `bun run setup` followed by `bun run app`. Keep the device connected and unlocked during setup.

## Stable Mac signing

Using the same signing identity across rebuilds helps preserve macOS permission and background-helper recognition. List your available development identities:

```bash
security find-identity -v -p codesigning
```

Select the identity and team for a build:

```bash
IPORTAL_CODE_SIGN_IDENTITY="<certificate SHA-1>" \
IPORTAL_DEVELOPMENT_TEAM="<team ID>" bun run app
```

The build remembers the selection locally; otherwise it uses ad-hoc signing. Phone setup reuses the saved phone/Mac team. To select another team explicitly, run `bun run setup -- <TEAM_ID>`.

## Permissions and audio

Camera and Microphone grants apply to legacy AVFoundation USB capture. Denying Camera uses basic video without audio; denying only Microphone leaves native USB video silent. Paired native capture receives video and system audio from the phone without these Mac permissions. The Settings switches always show the actual Mac grants.

Use the gear or **⌘,** to view current grants. An undecided permission shows the system prompt; changing an existing decision opens macOS Privacy & Security. Grants apply across all device windows, and macOS may require **Quit & Reopen** after a change. iPortal does not request Mac Screen Recording or Accessibility access.

If audio is missing, check **View → Play iPhone/iPad Audio**, the Mac's selected output device, and whether the media permits capture. Protected media may be silent.

Clipboard transfers are separate from capture permissions. They happen only when requested, briefly open the phone helper, and may require **Allow Paste** on the device. Connecting does not read the clipboard or request Paste access.

## Build errors and logs

If Xcode reports a missing Metal Toolchain, install it with:

```bash
xcodebuild -downloadComponent MetalToolchain
```

Build logs are in `vendor/iportal-device-build.log` and `vendor/mac-build.log`. Runtime helper logs and command receipts live in `~/Library/Application Support/iPortal`; Mac session logs live in `~/Library/Logs`.

Logs can contain device identifiers and other local metadata. Review and redact them before posting publicly. See [security and privacy](security.md).
