# Security policy

Code Remote gives a phone shell access to a computer, so security reports are taken
seriously and handled before anything else.

## Reporting a vulnerability

**Please don't open a public issue, discussion or pull request for a vulnerability.**

Report it privately, either way:

- GitHub: [report a vulnerability](https://github.com/CodeRemoteApp/coderemote/security/advisories/new)
  (Security tab → "Report a vulnerability")
- Email: trantienthanh2412@gmail.com

Include what you found, how to reproduce it (versions, commands, requests), and the impact
you expect. A proof of concept helps but isn't required.

What to expect:

- an acknowledgement within 3 days
- an assessment and a plan within 14 days
- a fix released as soon as it's ready, with credit to you in the advisory unless you'd
  rather stay anonymous

Please give us a reasonable time to fix the issue before disclosing it publicly.

## Supported versions

Only the latest release and the `main` branch get security fixes. The agent and the app
must run the same protocol version; update both.

## What the relay can see

A phone reaches the agent through the dev tunnel's relay, which terminates TLS. A phone paired
from a link that has a `pk` (every link from an agent with end-to-end encryption), using an app
version that supports it, encrypts
between itself and the agent on top of that, so the relay forwards ciphertext (details in
`packages/protocol/PROTOCOL.md`, "End-to-end encryption"). What that covers:

- **Encrypted end to end through the tunnel:** the bearer token, every API request and response
  (files, git, agent sessions), and the terminal and agents sockets. A relay that records the
  traffic learns none of it, and can't replay it. The agent proves its identity against the key in
  the QR, so a relay can't pose as it.
- **Not encrypted through the tunnel:** media played from the shared folder, files and photos
  uploaded to coding-agent sessions, and downloads too large for one message. They travel with a
  short-lived ticket that opens only those routes (never git, the terminal or writes), so the relay
  can read them but can't use them to reach the rest.
- **Visible to the relay anyway:** that a session exists, message sizes and timing, and the tunnel's
  own sign-in. It can also refuse service.

A phone paired before this existed, or from a link without `pk`, talks plaintext through the
tunnel (the relay can read the token and everything else) until it learns the key: the agent
shows it over the LAN connection, whose certificate the phone pinned, so one visit to the
computer's network upgrades it; a new QR scan does too. The key is never taken from a tunnel
answer, which a relay could rewrite. (`coderemote rotate-token` replaces the key and revokes every
device.) On
the same network the phone connects directly with the agent's certificate pinned and no relay is
involved (see [Local network](packages/protocol/PROTOCOL.md#local-network); `--no-lan` turns it
off). To avoid Microsoft's relay entirely, `coderemote serve` runs the agent on `127.0.0.1`
without a tunnel; put it behind something you trust, such as SSH or WireGuard/Tailscale.

## Security model

In scope, and worth reporting if broken:

- **Access control.** Every request needs the agent's bearer token (from the pairing link or
  QR code). By default the dev tunnel is also private: only the dev tunnels account that runs
  `coderemote up` gets through the relay, using the sign-in handoff described in
  `packages/protocol/PROTOCOL.md`.
- **The shared folder.** File, git and terminal requests must stay inside the folder
  `coderemote up` was started in, including through symlinks, `..`, encoded paths and git
  arguments.
- **No local exposure.** The agent listens on `127.0.0.1` only.
- **Encryption through the tunnel.** Requests sealed for an agent's identity key must stay
  confidential and unreplayable, and a client holding that key must never fall back to
  plaintext. Weaknesses in the handshake or the sealing are in scope.
- **Secrets at rest.** The agent token and its identity key live in `~/.coderemote/` (mode 0600); the app keeps
  pairings and tunnel tokens in the iOS Keychain.

Out of scope, by design:

- A terminal is a real shell with your user's permissions. Someone who is legitimately
  paired can run any command, including ones that read files outside the shared folder.
- `coderemote up --allow-anonymous` drops the tunnel sign-in on purpose; the pairing token is
  then the only protection.
- What the relay can still see or do, as listed above (media and uploads, metadata, refusing
  service, and plaintext traffic of phones without `pk`). Beyond that, `--web` starts VS Code's own tunnel, which is Microsoft's service with its own
  sign-in and gives the browser the whole machine, not only the shared folder.
- Anyone who has your pairing link or token, and (for private tunnels) your GitHub or
  Microsoft account, is you as far as the agent can tell. Run `coderemote rotate-token` to
  revoke every paired device.
- Vulnerabilities in Microsoft Dev Tunnels itself; report those to
  [Microsoft](https://msrc.microsoft.com/).
