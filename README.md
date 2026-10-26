# VSCodeRemote

A native iOS app with a file explorer and terminal for your dev machine. It connects
through Dev Tunnels (sign in with GitHub or Microsoft), so there is no SSH to set up.

```
iPhone app ──HTTPS/WSS──► Dev Tunnels relay ◄── vsremote agent (dev machine)
```

## Layout

| Path | What |
| --- | --- |
| `apps/ios/` | SwiftUI iOS app (Xcode project) |
| `apps/agent/` | `vsremote` CLI: runs the agent and hosts it on a dev tunnel |
| `packages/protocol/` | Wire contract (JS constants + [PROTOCOL.md](packages/protocol/PROTOCOL.md)) |
| `packages/agent-core/` | Agent library: file API, PTY terminal sessions |
| `packages/VSRemoteKit/` | Swift package shared by Apple clients: models, protocol, pairing |
| `openspec/` | Specs and change proposals |

npm workspaces cover the JS packages. To use `VSRemoteKit` from the iOS app, add it in Xcode:
File → Add Package Dependencies → Add Local… → `packages/VSRemoteKit`.

## Develop

```sh
npm install
npm test                 # agent e2e tests (in-process server)
npm run test:kit         # VSRemoteKit tests

brew install --cask devtunnel
devtunnel user login -g  # once
(cd apps/agent && npm link)   # once: puts `vsremote` on your PATH, linked to this checkout
```

### vsremote CLI

```sh
cd ~/Project/macgit
vsremote up              # share this folder through the tunnel, print the pairing QR
vsremote up --allow-anonymous   # same, without the sign-in on the phone (alias --no-auth)
vsremote status          # running agents and their terminal sessions
vsremote kill 3078f96c   # kill a session (id prefix from `status`); several ids are fine
vsremote kill --all      # kill every session
vsremote stop            # stop the agent sharing this folder (--all: every agent)
vsremote serve           # share on 127.0.0.1 only, no tunnel
vsremote rotate-token    # revoke every paired device
```

Sessions can also be killed from the app: Terminal tab → **+** → **Manage Sessions…**
(swipe a row, or **Kill All**).

By default the phone (or browser) must also sign in with the GitHub or Microsoft account that
runs `vsremote up` (the one `devtunnel user login` used): the dev tunnels relay turns everyone
else away before they reach the agent. With `--allow-anonymous` the pairing token alone grants
access. Switching modes keeps the tunnel URL, so paired devices stay paired.

The agent shares only the folder it was started in: run `vsremote up` inside a project and
the app can't list or touch anything above it (`--root DIR` picks another folder).
Terminals start in that folder too, but a shell is a shell: it has your user's full permissions.

### Install on iPhone without Xcode

Signing settings are personal, so they live in a gitignored file. Once:

```sh
cp apps/ios/Config/Local.xcconfig.example apps/ios/Config/Local.xcconfig
# then set DEVELOPMENT_TEAM (Xcode → Settings → Accounts; a free Apple ID works)
# and BUNDLE_ID_PREFIX (e.g. com.yourname)
```

Then:

```sh
scripts/ios-device.sh                          # build, install and launch on the paired iPhone
CONFIGURATION=Release scripts/ios-device.sh    # Release build
DEVICE=<udid> scripts/ios-device.sh            # pick a device (several paired)
xcrun devicectl list devices                   # find a device's UDID
```

Requirements: the iPhone is connected by cable or on the same Wi-Fi as a paired device,
Developer Mode is on, and the phone is unlocked so the app can launch. The first install
may need Settings → General → VPN & Device Management → trust the developer.
Signing is automatic; `-allowProvisioningUpdates` creates or renews the profile when needed.

The iOS app uses SwiftTerm, which needs the Metal toolchain
(`xcodebuild -downloadComponent MetalToolchain`, once). The first time you build in Xcode,
click "Trust & Enable" for its build plugin; on the command line pass `-skipPackagePluginValidation`.

UI is tested by hand on a real iPhone (`scripts/ios-device.sh`); the project doesn't use the simulator.

To run the e2e suite through a live tunnel:

```sh
VSREMOTE_URL=https://… VSREMOTE_TOKEN=… npm test
VSREMOTE_PAIRING_URL='vsremote://pair?…' npm run test:kit
```

## Contributing

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md), not in public issues.

## License

Copyright (C) 2026 Thanh Tran

This program is free software: you can redistribute it and/or modify it under the terms of
the GNU Affero General Public License as published by the Free Software Foundation, either
version 3 of the License, or (at your option) any later version. See [LICENSE](LICENSE).

The name "Code Remote" and the app icon are not covered by the AGPL; see
[TRADEMARKS.md](TRADEMARKS.md). A fork you distribute needs its own name and icon.

In short: you may use, study, modify and share it, but if you distribute it, or let people
use a modified version over a network, you must publish your source code under the same
license.
