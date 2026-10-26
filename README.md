<p align="center">
  <img src="apps/ios/Design/AppIcon/Icon-Default-1024x1024@1x.png" width="112" height="112" alt="Code Remote icon">
</p>

<h1 align="center">Code Remote</h1>

<p align="center">
  <b>Your computer, in your pocket.</b><br>
  An iPhone app to browse files, use git and run a real terminal on your dev machine,
  over a secure Microsoft Dev Tunnel. No SSH, no port forwarding, no VPN.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/coderemote"><img src="https://img.shields.io/npm/v/coderemote?label=npm%20coderemote" alt="npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0--or--later-blue" alt="license"></a>
  <img src="https://img.shields.io/badge/iOS-27%2B-black" alt="iOS 27+">
</p>

---

## Get started

On your computer:

```sh
npm install -g coderemote
brew install --cask devtunnel && devtunnel user login -g   # once
cd ~/projects/my-app && coderemote up
```

On your iPhone: scan the QR code that `coderemote up` prints. The app opens and pairs.

The App Store release is coming; until then, [build the app yourself](#build-the-ios-app).
Everything about the CLI (commands, requirements, FAQ) is in its
[npm README](apps/agent/README.md).

## Features

- **Files:** browse, open, edit, create, rename and delete files in the shared folder
- **Git:** changes and diffs, stage, discard, commit, pull, push and history, across every
  repository in the folder, with a repo picker
- **Terminal:** a real PTY shell with a key bar for Ctrl, Tab, Esc, arrows and modifier
  combos (Mac and Windows layouts); sessions survive the phone sleeping and reattach with
  their output, so `claude`, `vim` or a long build keep going
- **Private by default:** only your own GitHub or Microsoft account gets through the tunnel,
  plus a pairing token per device; files and git can't leave the shared folder

## How it works

```
iPhone app ──HTTPS / WSS──► Microsoft Dev Tunnels relay ◄── coderemote agent (your computer)
```

The agent listens on `127.0.0.1` and connects out to the relay, so no inbound port is ever
opened. The phone talks to it over HTTPS (files, git) and a WebSocket (terminals). The wire
contract is in [PROTOCOL.md](packages/protocol/PROTOCOL.md); the security model in
[SECURITY.md](SECURITY.md).

## Repository layout

| Path | What it is |
| --- | --- |
| [`apps/agent`](apps/agent) | `coderemote` CLI, published to npm |
| [`apps/ios`](apps/ios) | the SwiftUI iOS app |
| [`packages/agent-core`](packages/agent-core) | the agent: HTTP + WebSocket server for files, git and PTY terminals |
| [`packages/protocol`](packages/protocol) | wire contract shared by agent and app |
| [`packages/VSRemoteKit`](packages/VSRemoteKit) | Swift package: API client, pairing, tunnel sign-in, terminal UI |
| [`openspec`](openspec) | specs and change proposals |

## Develop

```sh
npm install                       # JS workspaces; also builds the CLI bundle
npm test                          # agent end-to-end tests (real HTTP, WebSocket, PTY)
npm run test:kit                  # VSRemoteKit tests
(cd apps/agent && npm link)       # `coderemote` on your PATH, running this checkout
```

After changing agent code, `npm run build -w coderemote` refreshes the linked command.

To run the end-to-end suites against a live agent:

```sh
VSREMOTE_URL=https://… VSREMOTE_TOKEN=… npm test
VSREMOTE_PAIRING_URL='vsremote://pair?…' npm run test:kit
```

### Build the iOS app

Requires Xcode 27+ and an iPhone (the project doesn't use the simulator; UI is tested by hand
on a device). Signing settings are personal, so they live in a gitignored file:

```sh
xcodebuild -downloadComponent MetalToolchain       # once, for SwiftTerm
cp apps/ios/Config/Local.xcconfig.example apps/ios/Config/Local.xcconfig
# set DEVELOPMENT_TEAM (Xcode → Settings → Accounts; a free Apple ID works)
# and BUNDLE_ID_PREFIX (e.g. com.yourname)

scripts/ios-device.sh                              # build, install and launch on your iPhone
CONFIGURATION=Release scripts/ios-device.sh        # Release build
DEVICE=<udid> scripts/ios-device.sh                # pick one of several paired iPhones
```

The iPhone needs Developer Mode on, a cable or the same Wi-Fi as the Mac, and to be
unlocked for the launch. The first install may ask you to trust the developer in
Settings → General → VPN & Device Management. In Xcode, click "Trust & Enable" for the
SwiftTerm build plugin the first time (`-skipPackagePluginValidation` on the command line).

## Contributing

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md), not in public issues.

## License

Copyright (C) 2026 Thanh Tran

This program is free software: you can redistribute it and/or modify it under the terms of
the GNU Affero General Public License as published by the Free Software Foundation, either
version 3 of the License, or (at your option) any later version. See [LICENSE](LICENSE).

In short: you may use, study, modify and share it, but if you distribute it, or let people
use a modified version over a network, you must publish your source code under the same
license.

The name "Code Remote" and the app icon are not covered by the AGPL; see
[TRADEMARKS.md](TRADEMARKS.md). A fork you distribute needs its own name and icon.
