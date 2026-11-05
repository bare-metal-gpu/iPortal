<p align="center">
  <img src="docs/banner.png" alt="iPortal" width="100%" />
</p>

**Mirror and control your iPhone or iPad from your Mac—over USB or supported Wi-Fi connections.**

# Why

<img src="docs/eu-banner.png" width="100%" alt="Satirical collage: a smiling woman and cartoon character proudly present the 'iPhone Mirroring is not available in your country or region' alert against an EU-blue background with gold stars." />

iPortal is an open-source alternative that works in the EU. It runs locally, without an iPortal account or cloud relay.

## Features

### Mirror your devices

- **iPhone and iPad**, including **multiple devices at once** in independent windows.
- **Automatic device detection** over USB and supported Wi-Fi connections. Available devices appear in the menu-bar list; Wi-Fi requires an existing pairing.
- **USB and supported Wi-Fi connections**, with automatic handover between them.
- **Portrait and landscape**, following the device's orientation.
- **Automatic recovery** after unlocking or reconnecting.

### Control, navigate, and type

| Feature              | Mac control                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| **Tap / long press** | Click / click and hold                                                                           |
| **Swipe / scroll**   | Drag / scroll vertically or horizontally                                                         |
| **Zoom**             | Trackpad pinch or <kbd>⌘</kbd> + scroll                                                          |
| **Text editing**     | Type, move the cursor, select text, copy/cut/paste, undo/redo                                    |
| **Navigation**       | Home, App Switcher, Spotlight, Notification Center, and Control Center through the **View** menu |

Supports **emoji, accented characters, and input methods**. Editing shortcuts depend on the device app.

<details>
<summary><strong>Keyboard shortcuts</strong></summary>

| Shortcut            | Action                                                      |
| ------------------- | ----------------------------------------------------------- |
| ⌘1 / ⌘2 / ⌘3        | **Home / App Switcher / Spotlight**                         |
| ← / →, ⇧ + arrows   | Move the cursor / extend selection                          |
| ⌥ + arrows / Delete | Move by word / delete a word                                |
| ⌘A / ⌘C / ⌘X        | Select all / copy / cut selected device text                |
| ⌘Z / ⇧⌘Z            | Undo / redo                                                 |
| ⌘V                  | Type the Mac clipboard text into the device                 |
| ⇧⌘C / ⇧⌘V           | Copy device clipboard to Mac / send Mac clipboard to device |
| ⌘+ / ⌘− / ⌘0        | Larger / smaller / default window size                      |
| ⌘,                  | **Settings**                                                |

</details>

> Drags, trackpad scrolls, and pinches take effect **when you finish the gesture**; mouse-wheel scrolling follows a short pause.

### Clipboard and audio

- **Two-way clipboard transfers** for text, links, and images through **Edit**. iOS may ask you to **Allow Paste**.
- **Device audio on your Mac**, toggled per window through **View → Play iPhone/iPad Audio**. Protected media and basic video fallback may be silent.

### Windows and menu bar

- **Always on Top:** click the **pin** in the window toolbar to keep a mirror above other Mac windows. Click again to unpin.
- **Resize** each mirror from its corners or with keyboard shortcuts.
- **Play / Pause** each mirror from the menu-bar device list.
- **Menu-bar access stays available** after closing the app or pressing **⌘Q**. Connecting by USB can open the device list.
- Right-click the menu-bar icon for **Open at Login** or **Quit iPortal** to stop everything.

### Keep Awake

**Prevent Auto-Lock for a timed session**, without changing the device's settings. Enable it through the [local API](docs/api.md#keep-awake); the phone helper shows the remaining time. Normal Auto-Lock resumes when the timer ends. Keep Awake is **off by default** and cannot unlock a locked device.

### Browser and automation

<details>
<summary><strong>Browser controls</strong> — app launching, device buttons, and picture quality</summary>

Run `bun start` and open http://localhost:7100. Includes **touch and keyboard input**, **app launching**, **volume, lock, and wake controls**, and **picture-quality presets**. Uses basic video, without the Mac app's native audio/video playback or window controls.

</details>

<details>
<summary><strong>Local automation API</strong> — inspection, screenshots, verified actions, and keep-awake</summary>

**Automate input and app control**, inspect **device state and UI elements**, take **screenshots**, **wait for conditions**, and verify results. Command receipts help avoid repeating completed actions.

See the [API reference](docs/api.md) for commands and examples.

</details>

## Install

You need:

- A Mac running **macOS 14+**, full **Xcode** compatible with your device, and **Bun 1.4.4+**.
- An **iPhone or iPad running iOS/iPadOS 17+**, a USB cable for setup, and an **Apple Account**. A free account works.
- For **Wi-Fi**: an **Apple silicon Mac**, **Xcode 27+**, **iOS/iPadOS 27+**, and **Rust/Cargo** installed before building.

1. Open Xcode → Settings → Accounts and add your Apple Account. Under **Manage Certificates**, create an Apple Development certificate if needed.
2. Connect your device by USB, unlock it, and tap **Trust** if prompted.
3. On the device, enable Settings → Privacy & Security → **Developer Mode**. Complete the restart and confirmation.
4. Build and install:

   ```bash
   git clone https://github.com/bare-metal-gpu/iPortal && cd iPortal
   bun install --frozen-lockfile
   bun run setup
   bun run app
   ```

5. Open **iPortal** from `~/Applications`. On the device, trust your developer account under Settings → General → **VPN & Device Management** if prompted. Complete any **Enable UI Automation** or passcode prompt directly on the device.

**You can decline Camera and Microphone access and still mirror your device.** Some USB connections will have lower-quality video or no sound. [Permission help](docs/setup.md#permissions-and-audio)

### Enable Wi-Fi

Complete USB setup first. Keep both devices on the same local network and enable **Connect via network** in Xcode → Window → Devices and Simulators if needed.

Without the Wi-Fi build requirements, USB remains available. [Setup help and additional devices](docs/setup.md)

## Good to know

- **Keep the device unlocked.** Locking pauses interaction; unlocking lets the mirror recover.
- With a **free Apple Account**, the helper's provisioning expires after seven days. Rerun `bun run setup` and `bun run app` to renew it.
- **Compatibility varies.** The minimum OS versions are build targets; not every device combination has been tested. [Compatibility](docs/setup.md#compatibility)
- The installed app can run without the checkout or Bun, but **Xcode is still required**. Keep the checkout if you need to rebuild or renew the helper.
