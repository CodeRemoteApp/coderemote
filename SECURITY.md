# Security policy

Code Remote gives a phone shell access to a computer, so security reports are taken
seriously and handled before anything else.

## Reporting a vulnerability

**Please don't open a public issue, discussion or pull request for a vulnerability.**

Report it privately, either way:

- GitHub: [report a vulnerability](https://github.com/Tranthanh98/coderemote/security/advisories/new)
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
- **Secrets at rest.** The agent token lives in `~/.coderemote/` (mode 0600); the app keeps
  pairings and tunnel tokens in the iOS Keychain.

Out of scope, by design:

- A terminal is a real shell with your user's permissions. Someone who is legitimately
  paired can run any command, including ones that read files outside the shared folder.
- `coderemote up --allow-anonymous` drops the tunnel sign-in on purpose; the pairing token is
  then the only protection.
- Anyone who has your pairing link or token, and (for private tunnels) your GitHub or
  Microsoft account, is you as far as the agent can tell. Run `coderemote rotate-token` to
  revoke every paired device.
- Vulnerabilities in Microsoft Dev Tunnels itself; report those to
  [Microsoft](https://msrc.microsoft.com/).
