# Security and privacy

## Connections and access

- **Local operation:** mirroring does not use an iPortal account or cloud relay. Wireless uses Apple's paired-device connection.
- **Mac API:** listens on loopback. Browser requests are checked against the local host, origin, and server instance. These checks do not authenticate native processes: other software, including other local users able to reach loopback, can inspect or control the connected device. Do not expose the API through a public tunnel, proxy, or port forward.
- **Phone helper:** commands and video require an automatically generated per-session credential. Each mirrored device has its own credential; restarting its server rotates it. Incompatible or unauthenticated helpers are rejected. Rebuild both apps when upgrading the helper.
- **Transport:** helper forwarding uses private Mac sockets. On the phone, the helper binds to device loopback for legacy USB or Apple's paired tunnel address for supported paired connections; it does not offer an unauthenticated LAN listener.

## Data on disk

The server does not save screenshots, UI trees, typed text, or clipboard contents. Command receipts store hashes and sanitized outcomes to prevent duplicate actions. Explicit screenshot/API clients can save returned data themselves.

Runtime logs and receipts use restricted filesystem permissions. Logs can still contain device identifiers, app names, and diagnostic metadata. Xcode result bundles can contain sensitive launch information, including credentials. Do not publish these files without reviewing and redacting them.

Clipboard transfer is explicit, not continuous synchronization. iPortal does not automatically approve iOS Paste prompts. Camera and Microphone permission behavior is explained in [setup](setup.md#permissions-and-audio).

## Limits

- The Mac app is **not App Sandboxed or notarized**. It runs Xcode tooling and device automation as the logged-in user. Use it only on a Mac you trust.
- Session authentication does not protect a compromised Mac or phone, or software able to inspect the helper's process environment.
- The manual `--wda` endpoint override is operator-trusted. Authentication does not add encryption to a manually configured plain-HTTP endpoint; do not use an untrusted endpoint.
- Private Apple APIs and developer signing can change across OS/Xcode releases. Supported build targets do not establish compatibility with every device.

Keep macOS, Xcode, and the app's dependencies updated. The Mac app embeds Bun: updating a separately installed Bun does not update an already-built app; rebuild it to include runtime fixes. Dependency scans do not cover every native component or unknown vulnerability.
