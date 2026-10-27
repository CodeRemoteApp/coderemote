<p align="center">
  <img src="https://raw.githubusercontent.com/CodeRemoteApp/coderemote/main/docs/images/icon.png" width="96" height="96" alt="Code Remote icon">
</p>

<h1 align="center">coderemote</h1>

<p align="center">
  <b>Use your computer from your iPhone.</b><br>
  Browse files, review and commit with git, and run a real terminal on your dev machine,
  over a secure Microsoft Dev Tunnel. No SSH keys, no port forwarding, no VPN.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/coderemote"><img src="https://img.shields.io/npm/v/coderemote" alt="npm version"></a>
  <a href="https://github.com/CodeRemoteApp/coderemote/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/coderemote" alt="license: AGPL-3.0-or-later"></a>
  <img src="https://img.shields.io/node/v/coderemote" alt="node version">
</p>

<p align="center">
  <a href="https://coderemoteapp.github.io/web/"><b>Website</b></a> ·
  <a href="https://coderemoteapp.github.io/web/docs/"><b>Docs</b></a>
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
- **VS Code in the browser (optional):** `coderemote up --web` also starts VS Code's own
  tunnel and prints a vscode.dev link that opens the folder in the full editor

## Quick start

```sh
npm install -g coderemote
cd ~/projects/my-app && coderemote up
```

Scan the QR code it prints with your iPhone Camera (or the **+** button in the app). Done.

The first run sets itself up: it downloads Microsoft's Dev Tunnels CLI (once, verified) and
opens your browser to sign in with GitHub. Prefer a Microsoft account? Run
`coderemote login --microsoft` first.

## How it works

<p align="center">
  <img src="https://raw.githubusercontent.com/CodeRemoteApp/coderemote/main/docs/images/how-it-works.png" width="760" alt="How it works: the Code Remote app on the iPhone connects over HTTPS/WSS to the Microsoft Dev Tunnels relay; coderemote on your computer (127.0.0.1:31580) connects outbound to the same relay and serves files, git and terminals from the shared folder. Security at each hop: token in the iPhone Keychain, only your account through the relay, token check and one folder on the computer.">
</p>

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
alone.

`--web` runs `code tunnel`, which is VS Code's tunnel, not ours: it signs in with its own
GitHub account and gives the browser the whole machine, not just the shared folder. It stops
with `coderemote`, unless a `code tunnel` was already running.

Found a vulnerability? See the
[security policy](https://github.com/CodeRemoteApp/coderemote/blob/main/SECURITY.md).

## Commands

```sh
coderemote up                    # share this folder through a dev tunnel, print the pairing QR
coderemote up --allow-anonymous  # same, without the account sign-in (alias --no-auth)
coderemote up --web              # also run `code tunnel`: open this folder in VS Code on vscode.dev
coderemote status                # running agents and their terminal sessions
coderemote kill <id>...          # end terminal sessions (an id prefix from `status` is enough)
coderemote kill --all            # end every session
coderemote stop                  # stop the agent for this folder (--all: every agent)
coderemote serve                 # share on 127.0.0.1 only, no tunnel (local testing)
coderemote requests [PORT]       # requests that reached a previewed port (--grep, --failed, --json)
coderemote request <ID>          # headers and bodies of one request (--show-secrets, --json)
coderemote rotate-token          # revoke every paired device
coderemote login                 # sign in again (--microsoft, or --device-code without a browser)
coderemote update                # install the latest version (`up` says when there's one)
coderemote help                  # all options
```

Options: `--root DIR` shares another folder; `--port N` picks the local port (default
`31580`). The tunnel URL stays the same between runs, so paired phones reconnect on their own.

`requests` and `request` read the traffic log of a port you preview from the app, so a coding
agent in a terminal (Claude Code, Codex, …) can debug with it: run them in the shared folder.
The log lives in the agent's memory only (the latest 200 requests per port, bodies up to 64 KB).
Auth headers, cookies and token-like fields are masked; `--show-secrets` prints them, for
example to reuse a session token in a test.

## Requirements

- **Node.js 20** or newer on **macOS** (Linux is expected to work but not yet tested)
- A **GitHub or Microsoft account** to sign in to Dev Tunnels
- The **Dev Tunnels CLI** is downloaded on first run into `~/.coderemote/bin` (the macOS build
  must carry Microsoft's code signature). A `devtunnel` already on your `PATH` is used instead,
  or point `CODEREMOTE_DEVTUNNEL` at one.
- For `--web` only: **VS Code** with its `code` command on your `PATH` (in VS Code, run
  *Shell Command: Install 'code' command in PATH*), or point `CODEREMOTE_CODE` at one. The first
  run signs `code tunnel` in with GitHub.
- On Linux, `node-pty` compiles on install (`python3`, `make`, a C++ compiler:
  `build-essential` on Debian/Ubuntu), and signing in needs `libsecret` (`libsecret-1-0`)
- The **Code Remote** iOS app on your iPhone (App Store release coming; see the
  [website](https://coderemoteapp.github.io/web/))

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

[AGPL-3.0-or-later](https://github.com/CodeRemoteApp/coderemote/blob/main/LICENSE).
"Code Remote" and its icon are trademarks of the project; see
[TRADEMARKS.md](https://github.com/CodeRemoteApp/coderemote/blob/main/TRADEMARKS.md).
