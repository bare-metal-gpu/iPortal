# iPortal identity

The repository is `bare-metal-gpu/iPortal`. The Mac app, phone app, menu-bar
watcher, CLI, status framework, and README banner use the iPortal name.

| Resource                    | Identity                                           |
| --------------------------- | -------------------------------------------------- |
| Mac app                     | `com.baremetalgpu.iportal`                         |
| Login helper                | `com.baremetalgpu.iportal.watcher`                 |
| Phone runner                | `com.<lowercase-team-id>.iportal.mobile.xctrunner` |
| Phone status framework      | `com.baremetalgpu.iportal.statusui`                |
| Package / CLI / API service | `iportal`                                          |
| Mac-to-watcher URL scheme   | `iportal`                                          |
| Browser instance header     | `x-iportal-instance`                               |

`bun run app` migrates the previous installation before replacing it. It copies
the login preference, saved device names, preferred device, and menu-bar position;
asks the old containing app to unregister its login item; waits for the old
processes to exit; and keeps the old bundle in ignored `vendor/previous-app-*`.
A failed retirement stops installation. The new app identity needs its own
Camera and Microphone grants from macOS.

`bun run setup` updates fresh and previously branded phone projects, including
when the signing team changes. Its new build directory prevents reuse of the
old signed runner. Apple provisioning, XCTest, and upstream library/target names
remain owned by their providers. Old branding appears only in migration code,
migration tests, provenance, and historical documentation or commits.

Verified on the connected iPhone: signed runner installed with the new ID,
automation connected, status screen displayed Connected and the keep-awake
countdown, screenshots returned successfully, and the old runner was removed.
The Mac and embedded watcher passed signature verification; the old login item
was unregistered and the new watcher registered with Open at Login enabled.
