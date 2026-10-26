<p align="center">
  <img src="https://raw.githubusercontent.com/Tranthanh98/vscoderemote/main/apps/ios/Design/AppIcon/Icon-Default-1024x1024@1x.png" width="96" height="96" alt="Code Remote icon">
</p>

<h1 align="center">coderemote</h1>

<p align="center">
  <b>Use your computer from your iPhone.</b><br>
  Browse files, review and commit with git, and run a real terminal on your dev machine,
  over a secure Microsoft Dev Tunnel. No SSH keys, no port forwarding, no VPN.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/coderemote"><img src="https://img.shields.io/npm/v/coderemote" alt="npm version"></a>
  <a href="https://github.com/Tranthanh98/vscoderemote/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/coderemote" alt="license: AGPL-3.0-or-later"></a>
  <img src="https://img.shields.io/node/v/coderemote" alt="node version">
</p>

---

`coderemote` is the computer side of **Code Remote**, an iOS app for remote development.
Run one command in a project folder, scan the QR code with your iPhone, and that folder is
in your pocket:

- **Files:** browse, open, edit, create, rename and delete files in the shared folder
- **Git:** see changes and diffs, stage, discard, commit, pull, push and read history,
  across every repository in the folder
- **Terminal:** a real shell (PTY) with a key bar for Ctrl, Tab, Esc and arrows; sessions
  keep running when your phone sleeps and pick up where you left off, so `claude`, `vim`,
  `htop` or a long build survive switching apps

## Quick start

```sh
npm install -g coderemote
brew install --cask devtunnel     # Microsoft Dev Tunnels CLI (Linux: see below)
devtunnel user login -g           # once, sign in with GitHub (-d for a Microsoft account)

cd ~/projects/my-app
coderemote up
```

`coderemote up` prints a QR code. Scan it with the iPhone Camera (or the **+** button in the
app) to pair. Done.

## How it works

```
iPhone app ──HTTPS / WSS──► Microsoft Dev Tunnels relay ◄── coderemote (your computer)
```

`coderemote` starts a small agent that listens on `127.0.0.1` only, and publishes it through
a [Microsoft Dev Tunnel](https://learn.microsoft.com/azure/developer/dev-tunnels/overview).
The tunnel connects outward, so nothing on your network has to be opened, and it works from
anywhere: cellular, hotel Wi-Fi, behind NAT or a firewall.

## Security

Remote shell access is serious, so access is locked down by default:

- **Your account only.** The tunnel is private: the relay lets through only the GitHub or
  Microsoft account that runs `coderemote up`. The phone signs in once through the system
  browser (passkeys and "Sign in with Google" work).
- **Plus a pairing token.** Every request also needs the random token from the QR code,
  stored in the iPhone Keychain. `coderemote rotate-token` revokes every paired device.
- **One folder.** Files and git are confined to the folder you started in (symlink and `..`
  escapes are blocked); terminals start there. A terminal is still a real shell with your
  user's permissions.
- **Encrypted.** All traffic is HTTPS / WSS (TLS 1.2+) to the relay.

`coderemote up --allow-anonymous` skips the account sign-in when you want the pairing token
alone. Found a vulnerability? See the
[security policy](https://github.com/Tranthanh98/vscoderemote/blob/main/SECURITY.md).

## Commands

```sh
coderemote up                    # share this folder through a dev tunnel, print the pairing QR
coderemote up --allow-anonymous  # same, without the account sign-in (alias --no-auth)
coderemote status                # running agents and their terminal sessions
coderemote kill <id>...          # end terminal sessions (an id prefix from `status` is enough)
coderemote kill --all            # end every session
coderemote stop                  # stop the agent for this folder (--all: every agent)
coderemote serve                 # share on 127.0.0.1 only, no tunnel (local testing)
coderemote rotate-token          # revoke every paired device
coderemote help                  # all options
```

Options: `--root DIR` shares another folder; `--port N` picks the local port (default
`31580`). The tunnel URL stays the same between runs, so paired phones reconnect on their own.

## Requirements

- **Node.js 20** or newer on **macOS** (Linux is expected to work but not yet tested)
- The **devtunnel CLI**:
  - macOS: `brew install --cask devtunnel`
  - Linux: `curl -sL https://aka.ms/DevTunnelCliInstall | bash`
  - more options in [Microsoft's guide](https://learn.microsoft.com/azure/developer/dev-tunnels/get-started)
- A GitHub or Microsoft account for `devtunnel user login`
- On Linux, `node-pty` compiles on install: have `python3`, `make` and a C++ compiler
  (`build-essential` on Debian/Ubuntu)
- The **Code Remote** iOS app on your iPhone (App Store release coming; meanwhile build it
  from [source](https://github.com/Tranthanh98/vscoderemote#build-the-ios-app))

## FAQ

**Is it an SSH client?** No. Nothing to configure on the computer beyond this one command:
no SSH server, keys, open ports or dynamic DNS.

**Does it need VS Code?** No. It's inspired by VS Code's remote tunnels but runs on its own.

**Does my code go through a third party?** Traffic passes through Microsoft's Dev Tunnels
relay, encrypted in transit; Code Remote runs no server of its own and collects nothing.

**What happens when my phone locks?** Terminal sessions keep running on the computer, with
their recent output. Reopen the app and they reattach.

**Can I share more than one folder?** One at a time for now: `coderemote up` uses one
tunnel per computer. Share a parent folder to reach several projects; the Git tab finds every
repository inside it.

## License

[AGPL-3.0-or-later](https://github.com/Tranthanh98/vscoderemote/blob/main/LICENSE).
"Code Remote" and its icon are trademarks of the project; see
[TRADEMARKS.md](https://github.com/Tranthanh98/vscoderemote/blob/main/TRADEMARKS.md).
