# Code Remote protocol v4

The agent listens on `127.0.0.1` and is reachable remotely through a Dev Tunnel
(`https://<tunnel>-<port>.<region>.devtunnels.ms`), and from the same network through its
[LAN listener](#local-network). The agent's bearer token is always
required. By default the tunnel is also private: the relay admits only the dev tunnels account
that owns it (see [Tunnel sign-in](#tunnel-sign-in)). `coderemote up --allow-anonymous` drops
that second layer and leaves the token as the only boundary.

Every request carries:

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer <token>` |
| `X-Tunnel-Skip-AntiPhishing-Page` | `true` (skips the Dev Tunnels browser interstitial) |

## Pairing

The agent prints a QR code for

```
vsremote://pair?url=<https base url>&token=<token>[&id=<agentId>][&pk=<key>]
vsremote://pair?[url=<https base url>&]token=<token>&id=<agentId>&lan=<port>&addr=<a,b,...>&fp=<fingerprint>[&pk=<key>]
```

`url` is the tunnel's address, `token` the bearer token. `id`, the agent's identity, is there
whenever the agent has a [LAN listener](#local-network); a client identifies the machine by it
(else by the tunnel's host), whether or not the rest of the LAN parameters come with it.

The other LAN parameters are there only while the agent's tunnel isn't up: `lan` the listener's
port, `addr` up to 3 of its addresses (the likeliest to reach first, at most one IPv6), `fp` its
certificate's fingerprint. A client pins `fp` straight from the QR: it was read off the computer's
own screen, as the token was. With the tunnel up the link leaves them out, to keep the QR small:
a client learns them from `/api/info` over the tunnel. An agent that starts without internet
prints the long link, with `url` only if it remembers its tunnel's address; clients then reach it
on the local network only, until `/api/info` reports a tunnel.

`pk` is the agent's identity key for [end-to-end encryption](#end-to-end-encryption): 32 bytes as
unpadded base64url (43 characters), in either shape, whenever the agent has one. A client that
reads it pins it for that machine, and refuses a `pk` that isn't exactly that; one that doesn't
know `pk` ignores it and talks to the agent in plaintext, as before.

A link has `token` and either `url` or `id`, `lan`, `addr` and `fp`; clients refuse anything else,
and ignore a partial set of LAN parameters.

`coderemote rotate-token` invalidates every paired device.

## Compatibility

`GET /api/info` answers `protocol` (the version this agent speaks), `minClientProtocol` (the
oldest client protocol it still serves) and `version` (the CLI's version, `null` in a source
checkout). A client compares them with its own protocol:

- below `minClientProtocol`: the client is too old for this agent and asks its user to update the
  client, instead of calling routes that changed;
- `protocol` below the oldest agent the client supports: the agent is too old and the client asks
  its user to run `coderemote update` on that computer.

Agents from before these fields answer neither `minClientProtocol` nor `version`; clients treat a
missing `minClientProtocol` as compatible. The check is per agent: one outdated computer doesn't
block the others.

So that every client, however old, can still read it, `GET /api/info` never changes
incompatibly: its fields keep their names and types, and new ones are only added.

`minClientProtocol` is raised only when a change leaves older clients unable to work (a route
removed or changed incompatibly, a message they would misread), never for additions they can
ignore, and only after a client release that speaks the new protocol is available, or clients
would be told to update to a version that doesn't exist yet.

## Tunnel sign-in

A private tunnel's relay answers before the agent does:

- unauthenticated `GET`s and WebSocket handshakes: `302` to
  `https://global.rel.tunnels.api.visualstudio.com/auth/<provider>?pb=<tunnel>/auth/postback/...`
- other methods: `401` with `WWW-Authenticate: tunnel`

The agent itself never redirects and never sends that header, so clients treat either as
"sign in required" and run the handoff:

1. The client opens, in the system browser (it shares Safari's sessions and passkeys),
   `GET /vsremote/handoff?nonce=<unix seconds>.<random>&sig=<base64url(HMAC-SHA256(token, nonce))>&state=<random>`.
   This route takes no bearer token; the HMAC proves the caller holds it.
2. The relay makes the user sign in as the tunnel's owner, then forwards the request
   (query intact) to the agent.
3. The agent checks the signature, the nonce (five-minute window, single use) and the state,
   mints a dev tunnels connect token and redirects to
   `vsremote://tunnel-auth?token=<connect token>&expires=<ms since 1970>&state=<state>`.
4. The client sends `X-Tunnel-Authorization: tunnel <connect token>` on every request and
   terminal socket. The relay checks and strips it; the agent never sees it.

Connect tokens last 24 hours. While one still works, `POST /api/tunnel/token` (bearer token
required) returns `{ token, expiresAt }`, a fresh one; clients renew when less than 12 hours
remain. Anonymous tunnels answer both routes with 404.

### Tunnel status

`GET /api/tunnel` (bearer token required) describes the agent's tunnel and the other machines on
the same dev tunnels account. Agents without a tunnel, and agents from before this route, answer 404.

```
{ provider, account, previewPorts,
  tunnel: { id, url, access: "private" | "anonymous", expiration, connections, uploaded, downloaded },
  machines: [{ id, name, url, online, current }],
  others: [{ id, kind: "preview" | "vscode" | "other", name, online }],
  quota: { used, limit } | null }
```

`provider` names the tunnel service, `"devtunnels"` (missing from agents before 0.3.8: read it as
`"devtunnels"`). Clients group machines by `provider` and `account`, one connection each.
`account` is the signed-in dev tunnels user, e.g. `"thanh (GitHub)"`. `expiration`, `uploaded` and
`downloaded` are the service's own wording (`"30 days"`, `"1188 KB"`); the expiration is pushed
back every time `coderemote up` starts. `connections` counts clients connected to the tunnel now.
`machines` are the account's tunnels labelled `coderemote` (every agent labels its own; tunnels from
older releases are missing until their agent restarts), this one first with `current: true`.
`others` are the account's remaining tunnels, the ones `quota` counts besides the machines:
coderemote preview tunnels (`name` is their computer), VS Code's `code tunnel` ones, and other
tools' (`name` is their description, or null). Empty when the account couldn't be listed; missing
from agents before it was added (read it as empty).
`url` is a machine's agent address, the same as in its pairing link, so clients can tell which
ones they've paired; `online` is whether an agent hosts it now. `quota` counts every tunnel on the
account, preview tunnels included, against the most it may keep (`null` when they couldn't be
listed). The answer is cached for 15 seconds.

`DELETE /api/tunnel` (bearer token required, added within v4: older agents answer 404) deletes one
of the account's tunnels, so a phone can clear out ones nothing uses any more.

```
{ id, account, force? }  ->  { deleted }
```

`id` is a tunnel ID as `machines` lists it (with or without the region suffix); `account` is the
account the client showed, as `GET /api/tunnel` reported it. Before deleting, the agent checks the
computer's dev tunnels sign-in again. Errors carry `{ error, code }`:

| Status | `code` | When |
| --- | --- | --- |
| 400 | `EINVAL` | `id` or `account` missing |
| 403 | `ELOGIN` | the computer's sign-in has expired (`coderemote login` on it) |
| 409 | `EACCOUNT` | the computer is signed in to another account than `account` |
| 404 | `ENOTUNNEL` | no such tunnel on the account |
| 409 | `EOWN` | the agent's own tunnel, which this request runs through: delete it on the computer |
| 409 | `EONLINE` | an agent serves it right now; send `force: true` to delete it anyway |
| 502 | `EDEVTUNNEL` | devtunnel failed, with its own words |

Deleting a tunnel an agent uses changes its address, so every phone paired with it pairs again;
that agent's next `coderemote up` makes a new one. On the computer the same is
`coderemote tunnels` and `coderemote tunnels delete <id>`.

## Local network

Unless started with `--no-lan` (or `"lan": false` in its config), `coderemote up` also accepts
connections from the local network: TLS on its own port, on every interface, serving the same
routes and sockets with the same bearer token. `coderemote serve` never does.

The certificate is self-signed and kept across runs (`coderemote rotate-token` replaces it), so
clients can't check it by name or chain. They pin it instead: `GET /api/info` over the tunnel
answers

```
lan: { port, addresses: ["192.168.1.5", ...], fingerprint } | null
```

`fingerprint` is the lowercase hex SHA-256 of the certificate's DER encoding, `addresses` the
computer's current non-loopback, non-link-local addresses (IPv4 first), and `null` means there
is no LAN listener. A client sends a request over the network only after the TLS handshake shows
that exact certificate, and needs no `X-Tunnel-*` header there.

Over the tunnel, every request also passed the relay's sign-in; over LAN only the bearer token
guards it. So the LAN listener answers 404 for everything that hands out or uses that second
factor: `/vsremote/handoff`, `/api/tunnel` and `/api/tunnel/*` (connect token renewal, tunnel
status and deletion), `/api/preview` and `/api/preview/*` (preview connect tokens, public
sharing), and `POST /api/builds/install` (a public install link). Hook delivery answers 404 too:
it's only for coding agents on the computer itself. Clients send those requests through the
tunnel whatever route they use for the rest.

On macOS the agent also advertises a Bonjour service `_coderemote._tcp` on the LAN port, with TXT
entries `fp` (the first 16 hex characters of `fingerprint`) and `proto` (the protocol version),
so a client that knows the fingerprint finds the agent when the tunnel is out of reach. The TXT
record never carries the token or the shared folder.

`agentId` is the agent's identity: 32 hex characters, made once per agent port and kept across
restarts and token rotations, so a client that pairs again recognizes the machine. `tunnel` is
`{ url }` while the agent hosts its tunnel, else `null`: an agent started without internet runs on
the local network only and connects its tunnel once it can, without restarting.

Adding `lan`, `agentId` and `tunnel` didn't change the protocol version: clients that don't know
them ignore them.

## End-to-end encryption

Through the tunnel, TLS ends at the relay, which would otherwise see the bearer token and every
request and response. A client that holds the agent's `pk` (from the [pairing link](#pairing))
encrypts between itself and the agent instead, so the relay forwards ciphertext. It adds nothing
on the [local network](#local-network), whose pinned certificate already covers it, and the
agent's loopback listener stays plaintext for local tools (the hook command, the CLI). Test vectors
for everything below are in [`e2e-vectors.json`](e2e-vectors.json).

Support is advertised in `GET /api/info` as `e2e: { version: 1 }` (`null` without an identity
key). Through the tunnel (the loopback listener) the response never carries the key: a client
takes it from the pairing link. Over the LAN listener it adds `publicKey` (the same 43
characters), so a client paired before the agent had a key can adopt it over the certificate it
pinned, without scanning again; a client takes it from nowhere else, never replaces a key it
already pinned, and ignores one that arrives through the tunnel. Adding `e2e` and `pk` didn't
change the protocol version.

### Handshake

`POST /api/e2e/handshake`, no `Authorization`, JSON `{ "v": 1, "epk": "<base64url>" }` with a fresh
X25519 public key. The agent answers `{ "v": 1, "sid": "<session id>", "epk": "<base64url>",
"confirm": "<base64url>" }` with its own ephemeral public key. With `S` the agent's identity
key (`pk`), `ec` and `es` the two ephemeral keys:

```
ikm     = X25519(ec_priv, S) || X25519(ec_priv, es)       # the agent computes both from its side
salt    = SHA256("coderemote-e2e-1" || S || ec || es)
c2s     = HKDF-SHA256(ikm, salt, info="c2s", 32)           # client to agent
s2c     = HKDF-SHA256(ikm, salt, info="s2c", 32)           # agent to client
confirm = HMAC-SHA256(HKDF-SHA256(ikm, salt, info="confirm", 32), salt)
```

The client checks `confirm`: only the holder of the identity private key can compute it, and a
client that sees a different value sends nothing further. 400 for a bad body or a `v` the agent
doesn't know (`code: "e2e_version"`), 429 when handshakes come too fast. The bearer token is not
part of the handshake; it travels inside the sealed messages.

A session ends after 30 minutes idle, when the agent stops, and when `rotate-token` runs; the
agent keeps at most 64, dropping the least recently used. A session serves **either** sealed
requests **or** one socket, whichever it is used for first.

### Sealed messages

A sealed message is `counter || ciphertext || tag`: an 8-byte big-endian counter, then
ChaCha20-Poly1305 output (16-byte tag). The nonce is four zero bytes plus the counter; each
direction has its own key and counts from 0. The associated data names the session and the
direction, below. At most 8 MiB of plaintext per message.

### Sealed requests

`POST /api/e2e` with `X-E2E-Session: <sid>`; the body is a sealed message (AAD `"<sid>:req"`)
of `u32 header length (big endian) || JSON header || body`, where the header is
`{ "method", "path", "headers" }` (`path` with its query; `headers` including `authorization`) and
the body the request's. The agent checks the counter against a window of the last 128, so
requests may arrive out of order but none twice, then runs the request against its own routes
with the same authorization as a plaintext one.

The answer is `200` with a sealed message (AAD `"<sid>:res:<request counter>"`) of the same
packing: header `{ "status", "headers" }`, then the body. Outside the envelope the agent
answers only: `400` for a message that doesn't authenticate or repeats a counter (`e2e_bad`,
`e2e_replay`), `401` with `code: "e2e_session"` for an unknown or expired session (the client
handshakes again and, for an idempotent request, retries once), `413` for a body over the limit.
A request for `/api/e2e` or `/api/e2e/handshake` inside an envelope is refused with 404.

A response over the limit comes back as a sealed `413` with `code: "e2e_too_large"`; the client
fetches such a transfer with a ticket.

### Sealed sockets

The terminal and agents sockets are opened as `GET /api/term/ws?e2e=<sid>` or
`GET /api/agents/ws?e2e=<sid>`, with no `Authorization` and no other parameter, on a session of
their own (a fresh handshake). Every frame in both directions is a binary WebSocket message
holding a sealed message (AAD `"<sid>:ws:c2s"` or `"<sid>:ws:s2c"`) whose plaintext is one byte
(`0` text, `1` binary) followed by the frame's payload. Counters must arrive in order.

The first client frame is
`{ "type": "open", "kind": "term" | "agents", "token", "id", "cols", "rows", "cwd" }`
(`id`, `cols`, `rows`, `cwd` as the terminal's query parameters). The agent sends nothing before
it, and closes the socket if it doesn't arrive within 5 seconds. After it, the frames are those of
the [terminal](#terminal) and [agents](#live-updates) sockets. The agent closes with 4400 for a
bad, repeated or missing frame (or the wrong `kind`), 4401 for a wrong token, 4404 for an unknown
terminal `id`, 4408 for no `open`, 4500 for anything else.

### Tickets

Three kinds of transfer stay outside the envelope: byte-range reads of media, uploads, and
downloads too large for one sealed message. Sending the bearer token with them would hand it to
the relay, so they use a ticket instead. `POST /api/e2e/ticket` (inside the envelope, with the
token) with `{ "scope": "read" | "upload" }` answers `{ "ticket", "expiresIn" }` (seconds, 300).
The client sends `Authorization: Ticket <ticket>` on:

| Scope | Routes |
| --- | --- |
| `read` | `GET /api/fs/read` |
| `upload` | `POST /api/agents/uploads`, `GET /api/agents/uploads` |

Anywhere else, and after it expires, a ticket answers 401. The relay can read what travels with a
ticket and replay the ticket until it expires; it can't use it for anything else.

### What stays outside

The tunnel's own sign-in (`X-Tunnel-Authorization`, `/vsremote/handoff`), the public preview and
install links, and hook delivery. Message sizes, timing and the existence of a session are visible
to the relay. A client that holds a `pk` never sends a request or opens a socket to that agent
through the tunnel in plaintext, and never puts the token anywhere outside a sealed message.

## Devices

Without them the pairing token is the one credential: whoever has it is the phone. A phone that
enrolls becomes a *device* the agent knows by two P-256 keys made in its Secure Enclave, and from
then on the token is good for enrolling more devices and nothing else. Support is advertised in
`GET /api/info` as `devices: { version: 1, strict, presence, presenceWindow }` (`null` without
it, which an agent started with `serve`, with no tunnel, is). Test vectors for the signatures are
in [`device-vectors.json`](device-vectors.json). Enrolling, signing in and presence need a
secure channel: a [sealed request](#sealed-requests), or the LAN listener. Elsewhere they answer 403.

### Enrolling

`POST /api/devices` with `Authorization: Bearer <pairing token>` and
`{ "name", "deviceKey", "presenceKey" }`: a name of up to 64 characters, and the device key and
the (optional) presence key as 65-byte uncompressed P-256 points in unpadded base64url. The agent
answers `{ id, name, presence }`, prints that a device enrolled, and is **strict** from then on.
400 for a bad name or a point that isn't on the curve, 409 when 16 devices are enrolled, 403 for a
device session (only the pairing token enrolls). `GET /api/devices` lists the devices (id, name,
enrolled, last seen, whether it has a presence key), never a key.

### Device sessions

`POST /api/device/challenge` with `{ "deviceId" }` answers `{ "nonce" }` (32 random bytes,
base64url, good once for 30 seconds; it is the same for an unknown id). The device signs
`"coderemote-device-1\0" || nonce || channel` with its device key, where `channel` is the sealed
session id (`X-E2E-Session`), or the text `lan` over the LAN listener, and sends
`POST /api/device/session` with `{ "deviceId", "nonce", "signature" }`. The signature is ECDSA with
SHA-256, 64 bytes (`r || s`) in base64url. The answer is `{ "token", "expiresIn" }`: a random
session token valid for an hour, sent as `Authorization: Bearer` from then on. Anything wrong is a
plain 401 that says not which part. Sessions live in the agent's memory; after a restart the
device signs in again, which needs no user action. A 401 with `code: "device_session"` means
exactly that.

### Strict mode

Once a device is enrolled, a request that carries only the pairing token gets 401 with
`code: "device_required"`, except `POST /api/devices`. The mode lasts across restarts and after the
last device is revoked; only `coderemote rotate-token` ends it (and removes every device).
`coderemote devices` lists the devices, `coderemote devices revoke <id>` removes one: its sessions,
tickets and open sockets end at once. A device cannot revoke (403); `DELETE /api/devices?id=` is for
the local credential.

The CLI reaches a running agent with `Authorization: Local <secret>` on the loopback listener
(the secret is in `~/.coderemote/local-secret`); the LAN listener never accepts it.

### Presence

A device proves its owner is there with its presence key (Face ID or the passcode). The agent keeps
a *level* and a *grant window* for the folder it shares:

| Level | Needs a grant |
| --- | --- |
| `none` | nothing |
| `terminal` (default) | opening a terminal socket, `agents/prompt`, `agents/keys`, `agents/sessions` (launch), `builds` (start) |
| `terminal+writes` | the above, and `fs/write`, `fs/mkdir`, `fs/rename`, `fs` (delete), git commit, discard, pull, push, checkout and stash, `ports/kill`, `term` (kill), `agents/stop`, `agents/answer`, `preview/share`, `builds/install` |

A guarded request without a grant gets 403 with `code: "presence_required"`; a terminal socket gets
`403` on the upgrade, and a sealed one is closed with 4403. Reading, staging and fetching are free.

`POST /api/device/presence/challenge` (a device session) answers `{ "nonce" }`, good once for 60
seconds. The device signs `"coderemote-presence-1\0" || nonce || SHA256(session token)` with the
presence key and sends `POST /api/device/presence` with `{ "nonce", "signature" }`; the answer is
`{ "grantedFor": seconds }`. The grant belongs to the device and lasts the window, so a session
renewed inside it keeps it. A device with no presence key gets 409 and cannot run guarded actions.

The window is 5 minutes (default), 30 minutes or 1 hour. `PUT /api/device/policy` with
`{ "level"?, "window"? }` (the window in seconds) changes them: tightening (a higher level, a
shorter window) needs a session, relaxing needs a grant (else 403 `presence_required`), and the
computer's `coderemote devices policy <level> [--window 5m|30m|1h]` needs neither. Any other value
is a 400.

## Shared folder

The agent shares one folder, the directory `coderemote up` runs in (or `--root DIR`).
Every file path must resolve inside it, symlinks included: `..`, absolute paths elsewhere and
links pointing outside get 403, and so do missing paths outside, so their existence can't be probed.
Paths may be absolute or relative to the root. The root itself can't be deleted or renamed.
New terminals start in the root and a `cwd` outside it is refused. The shell itself is not
sandboxed: it runs with your user's permissions, like any terminal.

## Files

Errors return `{ "error": string, "code"?: string }`
with 400 (bad input), 401, 403 (outside the shared folder, `EACCES`/`EPERM`), 404 (`ENOENT`) or 500.

| Route | Request | Response |
| --- | --- | --- |
| `GET /api/info` | | `{ protocol, minClientProtocol, version, hostname, platform, root, user, shell, lan, agentId, tunnel, e2e, devices }` (see [Compatibility](#compatibility), [Local network](#local-network)) |
| `GET /api/fs/list?path=` | | `{ path, entries: [{ name, type, size, mtime, target? }] }` |
| `GET /api/fs/stat?path=` | | `{ path, name, type, size, mtime, target? }` |
| `GET /api/fs/read?path=` | | raw bytes; one `Range: bytes=…` gets 206 with that part (416 past the end), so media streams; video and audio files carry their media type |
| `PUT /api/fs/write?path=` | raw bytes | entry; written atomically via temp file + rename |
| `POST /api/fs/mkdir?path=` | | `{}` (recursive) |
| `POST /api/fs/rename` | `{ from, to }` | `{}` |
| `DELETE /api/fs?path=` | | `{}` (recursive) |

`type` is `dir | file | symlink | other`; for symlinks `target` is the resolved kind or `broken`.
`mtime` is milliseconds since the epoch.

### Search

`GET /api/fs/search?q=&include=&exclude=&case=1&word=1&regex=1&limit=` searches every file in the
shared folder, like an editor's Find in Files (added within v4: older agents answer 404).

- `q`: the text to find, literal unless `regex=1` (then a regular expression). `case=1` matches
  case, `word=1` whole words only. At most 1000 characters.
- `include`, `exclude`: comma-separated patterns of files to search or skip, matched against the
  path relative to the root. A pattern without wildcards matches any path containing it (`src/`,
  `Server`, case-insensitive); a glob (`*`, `**`, `?`, `{a,b}`) matches the path or one of its
  folders, anywhere unless it starts with `/`. With `include` and no `q`, the answer just lists the
  files it lets through.
- `limit`: the most matching lines to return (default 500, at most 2000).

Ignore rules apply (`.gitignore` and the like), `.git` and `node_modules` are always skipped,
links aren't followed, and binary files and files over 2 MB aren't read. The search uses ripgrep
when the computer has it. It stops after 15 seconds, or when the request is dropped (a client
cancels the previous search as the user types).

```json
{
  "root": "/Users/me/project",
  "names": [{ "path": "src/server.js" }],
  "files": [
    { "path": "src/server.js", "matches": [{ "line": 12, "text": "const server = …", "ranges": [[6, 12]], "clipped": false }] }
  ],
  "truncated": false
}
```

Paths are relative to `root`, `/`-separated. `names` are files whose name matches `q` (all files
`include` lets through without `q`, up to `limit`; otherwise up to 100). `files` hold the matching
lines, 1-based `line`, at most 100 per file; `text` is the line without its indentation, clipped to
240 characters around the first match (`clipped`), and `ranges` are `[start, end)` of each match in
it, in UTF-16 code units. `truncated` says there were more results than returned, or the search ran
out of time. 400 for a missing query or an invalid regular expression.

## Git

Repositories are found by scanning the shared folder up to 4 levels deep (hidden folders,
`node_modules` and build output are skipped; repositories inside another one are found too). `repo` is a repository's
absolute path; file paths are relative to it and must stay inside it. Git never prompts:
pull/push use the machine's existing credentials or fail. Git failures return 409 with git's message.

| Route | Request | Response |
| --- | --- | --- |
| `GET /api/git/repos` | | `{ repos: [{ path, name, branch, changes, ahead, behind }] }`: `changes` is the number of changed files, `ahead`/`behind` the commits to push/pull (null when git can't tell; older agents omit them) |
| `GET /api/git/status?repo=` | | `{ branch, upstream, ahead, behind, files: [{ path, index, worktree, origPath?, conflicted? }] }` |
| `GET /api/git/diff?repo=&path=&staged=1&untracked=1` | | `{ text, truncated }` |
| `POST /api/git/stage` | `{ repo, files }` | status |
| `POST /api/git/unstage` | `{ repo, files }` | status |
| `POST /api/git/discard` | `{ repo, files }` | status; untracked files are deleted |
| `POST /api/git/commit` | `{ repo, message }` | `{ hash, short, subject, author, date, refs }` |
| `POST /api/git/commit-message` | `{ repo, agent?, model? }` | `{ message, agent, staged }`: a drafted message (see below). Added within v4: older agents answer 404 |
| `GET /api/git/log?repo=&limit=` | | `{ commits: [commit] }` |
| `GET /api/git/show?repo=&commit=` | | `{ text, truncated }` |
| `POST /api/git/pull` | `{ repo }` | `{ output }` (fast-forward only) |
| `POST /api/git/push` | `{ repo }` | `{ output }` |
| `POST /api/git/fetch` | `{ repo }` | `{ output }` (every remote, pruned). Added within v4 after `commit-message`, like the routes below: older agents answer 404 |
| `GET /api/git/branches?repo=` | | `{ branches: [{ name, remote, current, upstream, date, subject }] }`: local branches, then remote ones not already tracked by a local branch, most recent commit first; `date` in ms |
| `POST /api/git/checkout` | `{ repo, branch, create? }` | status. A remote branch (`origin/x`) switches to a local `x` tracking it, made if missing; `create` makes `branch` from the current commit. 400 for a name git refuses |
| `GET /api/git/stashes?repo=` | | `{ stashes: [{ index, message, date }] }`, newest (index 0) first |
| `POST /api/git/stash` | `{ repo, message?, untracked? }` | status. Stashes every change, untracked files too unless `untracked: false`; 409 when there is nothing to stash |
| `POST /api/git/stash/apply` | `{ repo, index, pop? }` | status. `pop` drops the stash once it applied; 409 (git's message) on a conflict |
| `POST /api/git/stash/drop` | `{ repo, index }` | status |

`index`/`worktree` are porcelain letters: `.` unchanged, `M`, `A`, `D`, `R`, `?` untracked.

`commit-message` drafts a message with a coding agent installed on the computer, on the user's
own plan: Claude Code (`claude -p`, Haiku, no tools, no MCP servers, a short system prompt, no saved session, run outside the repository), else Codex (`codex exec
--ephemeral`, read-only, its first listed model). `agent` (`claude` or `codex`) picks one, and
`model` that agent's model (a Claude Code alias such as `opus`, or a Codex model id). It describes the staged changes,
or every change when nothing is staged (`staged` says which), and follows the style of the
repository's recent commit subjects, as a summary line, a blank line and a short body; lockfiles and other generated files are left out of the diff,
which is cut at 24k characters. Nothing is committed. 409 `ENOAGENT` when neither agent is
installed, 409 when there is nothing to commit, 502 when the agent fails, 504 after 2 minutes.
The agent's hooks are skipped (`CODEREMOTE_NO_HOOK=1`), so the run never shows as a session.

## Terminal

| Route | Response |
| --- | --- |
| `GET /api/term` | `{ sessions: [{ id, shell, pid, title, createdAt, attached }] }` |
| `DELETE /api/term?id=` | `{}` (kills the session) |

WebSocket `GET /api/term/ws?cols=&rows=&cwd=` starts a login shell in a PTY;
`GET /api/term/ws?id=` reattaches to a live session. Sessions outlive their sockets, so a
phone that drops off the network can reattach, and the server replays up to 256 KB of scrollback.

Server to client:
- text `{ "type": "session", "id", "shell", "replay" }` first, on every attach
- binary: when `replay` > 0, the next binary frame is that many bytes of scrollback. Clients
  render it but must not answer terminal queries inside it (DA, XTVERSION, window size…):
  the program that asked is long gone and the answers would land in the shell as typed text.
- binary: PTY output (UTF-8)
- text `{ "type": "exit", "code" }` and then close, when the shell exits

Client to server:
- binary: raw keyboard input
- text `{ "type": "input", "data": string }`, an alternative to binary
- text `{ "type": "resize", "cols", "rows" }`

## Ports

TCP ports the agent's user is listening on (via `lsof`, or `ss` on Linux without it), so a
client can see which dev servers are up and stop one. Other users' processes are never listed.
Added without a protocol bump: older agents answer these routes with 404.

| Route | Request | Response |
| --- | --- | --- |
| `GET /api/ports` | | `{ ports: [{ port, addresses, pid, name, command, cwd, session, terminal, self, agent }] }` |
| `POST /api/ports/kill` | `{ pid, force? }` | `{}`; `SIGTERM`, or `SIGKILL` when `force` is true |

One entry per process and port, sorted by port. `addresses` are the bound addresses
(`127.0.0.1`, `::1`, `*` for all interfaces). `command` is the full command line and `cwd` the
process's working directory (null when unreadable). `session` is the id of the terminal session
the process was started from (it descends from that session's shell), or null. `terminal` is
true when the process has a controlling terminal: something run in a shell (`npm run dev`), as
opposed to apps, daemons and system services. Older agents omit it. `self` marks the
agent's own port; `agent` marks any coderemote agent (`coderemote up`), this one included, so
clients can warn before stopping one.

Only a process listening right now can be stopped: any other pid gets 404, and the agent
refuses to stop itself (403).

## Preview

Opens a local port (a dev server) on the phone. The agent forwards it through a second, private
dev tunnel of its own, so changing which ports are forwarded never touches the agent's tunnel.
Agents running without a tunnel, and agents from before these routes, answer 404.

| Route | Request | Response |
| --- | --- | --- |
| `GET /api/preview` | | `{ ports: [{ port, url, sharedUntil, install? }], token, expiresAt }` |
| `POST /api/preview` | `{ port }` | same; forwards the port (502 when the tunnel can't) |
| `DELETE /api/preview?port=` | | same; stops forwarding it, and sharing it |
| `POST /api/preview/share` | `{ port, hours }` | same; anyone with the port's `url` can open it, without signing in, for 1-720 hours (404 when the port isn't forwarded) |
| `DELETE /api/preview/share?port=` | | same; the port is private again |

`url` is the port's public address (`https://<tunnel>-<n>.<region>.devtunnels.ms`). The tunnel
reaches the dev server through a local proxy that records its traffic (see below), so `<n>` is
the proxy's port, not the dev server's; `port` is always the dev server's. Adding or
removing a port restarts the preview tunnel's host, which takes a few seconds and briefly drops
the other previews. `token` is a connect token for the preview tunnel (null until a port has been
forwarded) and `expiresAt` its expiry in milliseconds since the epoch. Load a preview by sending
`X-Tunnel-Authorization: tunnel <token>` with the first request; the relay answers with a
session cookie for that port's host, which carries the page's own requests after that.

`sharedUntil` is when a public share of that port ends (milliseconds since the epoch), or null
when only the owner can open it. A share covers that one port of the preview tunnel, never the
agent's own tunnel; the relay ends it on time by itself. Shares end with the agent: its next
run starts a fresh preview tunnel.

### Requests

The proxy keeps the latest 200 requests of each previewed port, from the agent's start, also
after the preview is closed. Bodies up to 64 KB are kept (decompressed); WebSockets pass through
and only their handshake is recorded.

| Route | Response |
| --- | --- |
| `GET /api/preview/requests?port=&after=` | `{ requests: [summary] }`, oldest first; `after` skips ids up to it |
| `GET /api/preview/request?port=&id=` | summary plus `request` and `response`: `{ headers, body }` |
| `DELETE /api/preview/requests?port=` | `{}`; forgets the port's requests |

A summary is `{ id, time, method, path, status, duration, error, contentType, requestSize,
responseSize }`: `time` in milliseconds since the epoch, `duration` in milliseconds (null while
the response streams), `status` null until it starts. `error` says why the proxy answered 502
(e.g. nothing listening on the port). A `body` is `{ size, truncated }` plus `text` for textual
content types or `base64` for the rest, both left out when it was too large. Ports never
previewed answer 404.

## Agents

Coding-agent sessions running on the computer (Claude Code today), so a client can see which
ones are working, waiting or done, read what they did, and answer their permission prompts and
questions. Sessions reach the agent through `coderemote hook`, which Claude Code runs for each
hook event once `coderemote setup claude` has installed the Code Remote plugin. Added without a
protocol bump: older agents answer these routes with 404.

A session reaches the agent that started its terminal (Claude Code inherits
`CODEREMOTE_AGENT_PORT` and `CODEREMOTE_TERM_ID` from it), else the running agent whose shared
folder is the longest prefix of its working directory. Sessions in folders no agent shares are
dropped. Ended sessions are forgotten 24 hours after they end. The list outlives the agent (it is
saved in `~/.coderemote/agent-sessions/<port>.json`): after a restart, sessions that ran in its
terminals are `ended` (the terminals stopped with it, so they can be resumed), others come back
`idle` until their next hook event, and Claude Code sessions read their timeline again from the
transcript (with new `seq` numbers above the old ones), so clients reload it.

| Route | Request | Response |
| --- | --- | --- |
| `GET /api/agents/sessions` | | `{ sessions: [session] }`, most recent activity first |
| `GET /api/agents/timeline?session=&after=&limit=&before=` | | `{ entries: [entry], next, more, requests: [request] }`; `after` skips entries up to that `seq`, `limit` keeps the newest that many, `before` only those older than that `seq` (the page before one already held), and `more` is true while older entries are left. An agent that predates these returns every entry and no `more` |
| `POST /api/agents/answer` | see below | `{}`; 404 for an unknown request, 409 once it is resolved |
| `GET /api/agents/setup` | | `{ claude, plugin, codex, codexPlugin, codexModels }`: whether Claude Code, Codex and their Code Remote plugins are installed, and the models Codex offers, see [Starting sessions](#starting-sessions) |
| `POST /api/agents/sessions` | `{ agent?, cwd?, model?, permissionMode?, resume?, cols?, rows? }` | `{ terminal, session }`; starts Claude Code, see [Starting sessions](#starting-sessions) |
| `POST /api/agents/prompt` | `{ session, text, attachments? }` | `{ prompt }`; see [Prompts and keys](#prompts-and-keys) |
| `GET /api/agents/commands?session=` | | `{ commands: [command] }`; 404 for an unknown session, see [Commands](#commands) |
| `GET /api/agents/history?session=` | | `{ sessions: [earlier] }`; 404 for an unknown session, see [History](#history) |
| `POST /api/agents/keys` | `{ session, action, command?, args? }` | `{}` |
| `POST /api/agents/stop` | `{ session }` | `{}`; see [Stopping and forgetting](#stopping-and-forgetting) |
| `POST /api/agents/forget` | `{ session }` | `{}`; see [Stopping and forgetting](#stopping-and-forgetting) |
| `POST /api/agents/uploads` | the file's bytes | `{ id, name, type, size }`; see [Uploads](#uploads) |
| `GET /api/agents/uploads?id=` | | the upload's bytes, with its media type; 404 once it is gone, see [Uploads](#uploads) |

A session is `{ id, agent, cwd, title, state, terminal, startedAt, lastActivityAt, pending,
starting, error, capabilities, permissionMode, model }`.
`agent` is `"claude"` or `"codex"`. `capabilities` is `{ approvals, alwaysAllow, keys }`: `approvals`
`"parallel"` (Claude Code: its own prompt stays open alongside, whichever side answers first wins)
or `"presence"` (Codex: its own prompt shows only once the agent declines, so the agent holds a
request for clients only while nobody is at the computer, see [Requests](#requests));
`alwaysAllow` says whether "allow and remember" (`suggestion`) is possible. Older agents omit it. `title` is the first line of the first prompt (80 characters at most), or
the folder's name before there is one. `state` is `running`, `waiting` (on a request), `idle`
(the turn ended) or `ended`. `terminal` is the id of the terminal session it runs in (see
[Terminal](#terminal)), or null when it was started outside the agent. `pending` counts its
unresolved requests. `starting` is true for a session started from a client that Claude Code
hasn't reported yet; `error` says why such a session ended without starting (else null). Older
agents omit both. Times are milliseconds since the epoch.

`permissionMode` is Claude Code's permission mode as its `--permission-mode` names it (`manual`,
`acceptEdits`, `plan`, `auto`, `bypassPermissions`, `dontAsk`), and `model` the model id that
answered last (or the alias just picked with `/model`); either is null until the agent knows it,
and older agents omit them. The mode comes from the hooks and, between them, from the footer of
the session's terminal, so it also follows Shift+Tab pressed at the computer.

Entries are append-only, numbered by `seq` (increasing per session), and the agent keeps the
latest 500 of each session. Each is `{ seq, time, kind, ... }`:

| `kind` | Fields |
| --- | --- |
| `prompt` | `text`; `images` (optional): `[{ id, type }]`, the images that came with it, as uploads (see [Uploads](#uploads)), which its `text` names `[Image #1]`, `[Image #2]`… in order. Images a client attached, and those in Claude Code's transcript when the agent reads it; older agents omit it. `files` (optional): `[{ id, name, type }]`, the other files a client attached (a video, a PDF), as uploads; Claude Code gets their paths, which `text` leaves out. Older agents omit it and leave the paths in `text` |
| `assistant` | `text`; `thinking: true` for the thinking Claude Code shows between tool calls (read from its transcript, as the Claude apps show it). A session's `title` is Claude Code's own name for the conversation once it has one, else its first typed prompt (never a `<task-notification>`) |
| `tool` | `toolUseId`, `name`, `input` |
| `tool_result` | `toolUseId`, `name`, `output` (string), `error` (bool), `truncated` (bool), `duration` (ms, or null) |
| `request` | `request` (the request object below) |
| `request_resolved` | `request` (id), `outcome`: `allowed`, `denied`, `answered`, `withdrawn`, `expired` or `deferred`; `by`: `phone`, `computer` or `agent` |
| `turn_end` | `duration` (ms); `error: true` and `text` (the agent's message) when the turn failed, e.g. Codex with a model the account can't use |

`output` keeps the first 16 KB of a tool result; `truncated` says there was more.

### Starting sessions

`POST /api/agents/sessions` runs `agent` (`claude`, the default, or `codex`) in a new terminal.
For Claude Code: (see [Terminal](#terminal); it
ends when Claude Code exits) through a login shell, so it finds `claude` on the user's PATH, with
the classic renderer (`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`): fullscreen rendering can fail to
start while no client is attached to the terminal.
`cwd` is a folder inside the shared folder (default: the shared folder itself), `model` a model
name or alias, `permissionMode` one of `manual`, `acceptEdits`, `plan` or `auto`, and `resume`
the id of an `ended` session to continue (409 for one that is still open). A new session gets its
id from the agent (`--session-id`), so `session` is already the one later events report; it
starts with `starting: true` and ends with an `error` if Claude Code reports nothing within 15
seconds (usually because the plugin isn't installed: `coderemote setup claude`). A resumed conversation that comes back under another id replaces it: the socket sends
`{ "type": "session_removed", "session": id }` for the old one. Sessions started here may read
the uploads folder (see [Uploads](#uploads)) without asking. 400 with `code: "ENOCLAUDE"` when
`claude` isn't installed, and with `code: "ENOPLUGIN"` when Claude Code lacks the Code Remote
plugin (`coderemote setup claude`), without which the session would never show up.

For Codex, `model` is passed with `-m` and `resume` as `codex resume <id>`; `permissionMode` is
ignored, and `approvalPolicy` (`on-request`, the default, or `never`) is passed with `-a`: without
it recent Codex rejects every escalation instead of asking, so no request would reach anyone; and the uploads folder isn't added (Codex's
`--add-dir` would make it writable; its sandbox reads it anyway). Codex picks its own session id,
and reports a session only once it gets its first prompt: its placeholder stays `idle` (and
`starting`), with no start timeout, ready to be typed into, and is replaced by the session that
prompt creates (`session_removed` with `replacedBy`; prompts sent to the placeholder are confirmed
under the new id).
`code: "ENOAGENT"` when `codex` isn't installed, `ENOPLUGIN` without `coderemote setup codex`
(whose hooks must also be trusted once with `/hooks` in Codex).
`GET /api/agents/setup` tells the same ahead of time (`claude plugin list`, checked at most every
30 seconds; any hook event counts as proof), so a client can explain the setup up front.
Its `codexModels` are `{ id, name, description }`, in the order Codex's own model picker shows
them (read from the list Codex caches in `~/.codex/models_cache.json`); `id` is what `model`
takes. It is empty when Codex isn't installed or hasn't fetched the list yet; older agents omit it.

### Prompts and keys

A session that runs in one of the agent's terminals (`terminal` set, not `ended`) can be typed
into. Others answer 409: a session started outside Code Remote can be followed but not prompted.

`POST /api/agents/prompt` pastes `text` into the session as one block (bracketed paste, so line
breaks stay in the message) and presses Enter. `attachments` are upload ids; their paths are
added on lines of their own, and Claude Code shows images among them as images. Control
characters other than newlines and tabs are dropped. While the session waits on a request (its
dialog would take the keystrokes) it answers 409. The response's `prompt` id comes back on the
socket as `{ "type": "prompt_confirmed", "session": id, "prompt": id }` once Claude Code reports
the prompt (`UserPromptSubmit`); a prompt that is never confirmed didn't reach it, for example
because the terminal had a menu open.

`POST /api/agents/keys` presses keys the agent knows by name, among the session's
`capabilities.keys` (Codex has no `cycle_mode` or `/clear`): `interrupt` (Esc, which also backs
out of a dialog and works while the session waits), `cycle_mode` (Shift+Tab, the next permission
mode), `set_mode` with `mode` (one of the `permissionMode` values: presses Shift+Tab until the
session shows that mode and returns `{ session }`, 409 when the mode doesn't come round, such as
`auto` when Claude Code's settings leave it off; not while the session waits), or `command`: `command` is a `"command"` entry of the session's [commands](#commands) (or one of
`capabilities.keys`), entered as a prompt is, with `args` (a string, control characters dropped)
after a space. Anything else is 400; the terminal itself remains for the rest. Built-in commands
don't come back as `prompt_confirmed`; custom commands and skills do arrive as prompt entries.
Older agents take only `/compact`, `/clear` and `/model` and ignore `args`.

### Commands

`GET /api/agents/commands?session=` lists what the session's coding agent accepts, read from the
files the agent itself reads on this computer, so a client can suggest them. Each command is
`{ name, kind, description, argumentHint, source, interactive }`:

- `name` is exactly what is typed. `kind` is `"command"` (starts with `/` and runs when entered,
  see [Prompts and keys](#prompts-and-keys)) or `"mention"` (starts with `$` and goes inside a
  prompt, which is sent as usual).
- `source` is `"builtin"`, `"user"`, `"project"` or `"plugin"`.
- `interactive` is true for commands that open a menu or dialog in the terminal, which needs
  keys a client can't send; clients offer to open the terminal for those.
- `description` and `argumentHint` come from the file's frontmatter. The rest of the file is
  never sent.

Claude Code: its built-in commands; commands in `~/.claude/commands` and `<cwd>/.claude/commands`
(subfolders joined with `:`); skills in `~/.claude/skills` and `<cwd>/.claude/skills` (except
`user-invocable: false`); skills synced from claude.ai as `/anthropic-skills:<name>`; and commands
and skills of enabled plugins as `/<plugin>:<name>`. Project entries win over user ones.

Codex: its built-in commands, and skills as mentions: `~/.codex/skills` (with `.system`) as
`$<name>`, `.agents/skills` in the session's folder and its parents up to the repository root,
and installed plugins as `$<plugin>:<name>` unless `config.toml` turns the plugin off.

Built-ins come first, the rest sorted by name. Older agents answer 404; clients then offer
`capabilities.keys`.

### History

`GET /api/agents/history?session=` lists up to 50 earlier conversations of the session's coding
agent in the session's folder, most recent first, without the session itself, so a client can
offer what `/resume` would: each is `{ id, title, updatedAt, branch, size }`. `id` is what
`POST /api/agents/sessions` takes as `resume`; `title` is the name the agent gave it (or the first
prompt); `updatedAt` is in milliseconds; `branch` is the git branch it was on, or null; `size` is
the bytes of its transcript. They are read from the agent's own files (Claude Code's
`~/.claude/projects`, Codex's `~/.codex/sessions`); conversations with no prompt are left out.
Older agents answer 404.

### Stopping and forgetting

`POST /api/agents/stop` closes the terminal of a session that runs in one of the agent's
terminals (`terminal` set, not `ended`), which hangs up on Claude Code or Codex; one still running
3 seconds later is killed. The session then ends as when its terminal exits. 409 for any other
session: one started outside Code Remote stops only where it runs.

`POST /api/agents/forget` drops a session from the list and withdraws its open requests; the
socket sends `{ "type": "session_removed", "session": id, "replacedBy": null }`. 409 while it runs
in one of the agent's terminals (stop it first). A session started outside Code Remote that is
still running comes back with its next hook event. Older agents answer both with 404.

### Uploads

`POST /api/agents/uploads` takes a file as the request body, with its media type in
`Content-Type` and its name, URI-encoded, in `X-Filename`. Files go to `~/.coderemote/uploads/`,
outside the shared folder so they never land in a repository, up to 100 MB each (413 above).
HEIC photos are converted to JPEG on macOS, since Claude Code reads PNG, JPEG, GIF and WebP.
Sessions started by the agent may read the folder without asking. Uploads are deleted after 7
days, and by `coderemote rotate-token`.

`GET /api/agents/uploads?id=` returns an upload's bytes, for the `images` and `files` of prompt entries.
Images the agent finds in a Claude Code transcript are kept as uploads too, with an id derived
from their content.

### Requests

A request is a prompt the session is blocked on: `{ id, session, kind, tool, input,
suggestions, questions, createdAt }`. `kind` is `permission` (may `tool` run with `input`?) or
`question` (Claude Code's `AskUserQuestion`; `questions` is its list of `{ question, header,
options: [{ label, description }], multiSelect }`). `suggestions` are the "always allow" rules
Claude Code offers for a permission, as it reports them (`permission_suggestions`), possibly
empty.

For `approvals: "parallel"` sessions the prompt stays open on the computer too: whichever side
answers first wins. When the computer
answers, the request resolves as `withdrawn` by `computer`. So does one answered somewhere the
agent can't see (Claude's own remote control): the asking tool's `PostToolUse`, a new prompt, or the
turn ending withdraws it. A request nobody answers within an
hour resolves as `expired` and is left to the computer.

For `approvals: "presence"` sessions (Codex) the computer's prompt appears only once the agent
declines, so while someone used the computer in the last 2 minutes (macOS) and no client's
presence is fresh, a request resolves at once as `deferred` by `agent` and is answered on the
computer. A client showing the machine means the person is on the phone: the request is held for it.
Otherwise it is held like any other, for at most 10 minutes, then `expired`. There is no "allow
and remember" (`suggestion` is 400).

`POST /api/agents/answer` takes `{ request, behavior, message?, suggestion?, answers? }`:

| Answer | Body |
| --- | --- |
| Allow | `{ request, behavior: "allow" }` |
| Allow and remember | `{ request, behavior: "allow", suggestion: <index into suggestions> }` |
| Deny | `{ request, behavior: "deny", message? }`; `message` tells Claude why |
| Answer a question | `{ request, behavior: "allow", answers: { "<question text>": "<label>" } }`; several labels of a multi-select question are joined with `", "`; any other text is a free-form answer |

### Live updates

WebSocket `GET /api/agents/ws` (bearer token as usual). Server to client, all text frames:

- `{ "type": "snapshot", "sessions": [session], "requests": [request] }` first
- `{ "type": "session", "session" }` when a session is new or changes
- `{ "type": "entry", "session": id, "entry" }` for every new timeline entry
- `{ "type": "request", "request" }` when a request opens
- `{ "type": "request_resolved", "session": id, "request": id, "outcome", "by" }`
- `{ "type": "session_removed", "session": id, "replacedBy": id }` when a placeholder gave way to the session Claude Code or Codex reports (see above), or with `replacedBy: null` once a session is forgotten
- `{ "type": "prompt_confirmed", "session": id, "prompt": id }` (see below)

Client to server: `{ "type": "presence", "foreground": bool, "session": id | null, "builds": bool }`.
Send `foreground: true` while the app shows this machine, at least every 20 seconds and whenever
what it shows changes: `session` is the session whose chat is open (null when none), `builds`
whether the builds are on screen. While it is fresh (30 seconds) the agent sends no push about what
it names (see [Push](#push)). A frame without `session` and `builds` (apps before they were added)
counts as showing everything. Added without a protocol bump.

### Hook delivery

`POST /api/agents/hook?agent=claude&terminal=<id>` carries a hook event's JSON input as the body
(`agent=codex` for Codex, whose hook payloads use the same field names). Codex runs plugin hooks
with a bare environment: none of the variables above reach them, so its plugin finds the CLI
through `~/.coderemote/bin/hook` (written by each agent when it starts) and the event is routed by
folder only; a Codex session then takes over the one Codex placeholder in its folder, if there is
exactly one.
It is authenticated with `X-Coderemote-Hook: <secret>` instead of the bearer token; the secret is
in `~/.coderemote/hook-secret` and never leaves the computer, so paired devices can't post
events (401). For `PermissionRequest` the response holds until the request resolves, and its
body is the hook's output (empty when the computer should decide); other events answer `{}`.

## Builds

Builds an Xcode project in the shared folder for the developer's own devices and installs it on
the phone over the air. It needs Xcode on the computer, signed in to an account that can sign for
the project's team, and a phone in that team's development profile (one the app was run on from
Xcode). Agents from before these routes answer 404.

| Route | Request | Response |
| --- | --- | --- |
| `GET /api/builds/schemes?path=` | | `{ container, kind, schemes }`: the `.xcworkspace` (`kind: "workspace"`) or else `.xcodeproj` directly in that folder; 404 when there is neither |
| `POST /api/builds` | `{ path, scheme, configuration? }` | build; starts archiving (`configuration` defaults to `Debug`); 409 while another build runs |
| `GET /api/builds/current?after=` | | build, with `log` and `next`; 404 before any build |
| `POST /api/builds/cancel` | | `{}`; 409 when no build runs |
| `POST /api/builds/install` | | `{ url, expiresAt }`; 409 without a successful build, or without a tunnel |

A build is `{ id, path, scheme, configuration, state, step, startedAt, endedAt, error, app }`.
`state` is `running`, `succeeded`, `failed` or `cancelled`; `step` is `archiving` or `exporting`.
It archives for generic iOS devices, then exports a development-signed `.ipa`, letting Xcode
manage signing (`-allowProvisioningUpdates`). `error` says why a build failed: its compiler errors
(`file:line:col: error: …`, at most 20), else xcodebuild's own errors or last lines, led by what to
do in Xcode when signing was the problem. `app` is `{ bundleId, version, name, size }` once it
succeeded. `log` holds xcodebuild's output lines after line `after` (the last 5,000 are kept);
pass `next` as `after` to get only new ones. Only the latest build is kept. When a build ends
(but isn't cancelled), registered devices get a `build` push.

`url` is an `itms-services://` link to install the latest successful build; opening it on the
phone asks to install the app. iOS fetches its manifest and `.ipa` without any headers, so they
are served without authentication at a random path through the preview tunnel (see
[Preview](#preview); forwarding them restarts the preview host, so other previews drop for a few
seconds). A link works for 10 minutes or until its `.ipa` has been downloaded once; then its path
answers 404, and the share ends when no link is left. Each call makes a new link. While links
live, the share is listed by `GET /api/preview` with `install: true` (its `port` is the agent's
own install server); `DELETE /api/preview?port=` or `DELETE /api/preview/share?port=` on it ends
every link at once. Agents started
with `coderemote serve` have no tunnel and answer 409.

## Push

Notifications on the phone when a session needs an answer or finishes a long turn, through a
relay that holds the APNs key ([`apps/push-relay`](../../apps/push-relay)) and stores nothing.
The app registers each device with the relay, which returns a ticket bound to the device token;
only a matching ticket lets the agent push to that token. Added without a protocol bump.

| Route | Request | Response |
| --- | --- | --- |
| `PUT /api/push/device` | `{ relay, token, environment, ticket, key, keyId, kinds }` | `{}`; adds or replaces the registration for `token` |
| `DELETE /api/push/device?token=` | | `{}` |
| `POST /api/push/test` | `{ token }` | `{}` once the relay accepted it; 404 for an unregistered token, 502 when the relay or APNs refused |

`relay` is the relay's base URL, `environment` `production` or `development` (APNs sandbox),
`key` a base64 AES-256 key the app generated for this machine and `keyId` its name, which comes
back in every push so the app can pick the key. `kinds` is `{ requests: bool, finished: bool }`.
Registrations are kept across restarts in `~/.coderemote/push/<port>.json` and deleted by
`coderemote rotate-token`, or when APNs reports the token gone.

The agent pushes for a new request, when a turn that ran 30 seconds or more ends (its `body` the start of the turn's last reply, as plain text clipped to 180 characters, then a line saying how long it took), when a build ends, and to replace
the notification of a request resolved elsewhere (same `apns-collapse-id`, the request id). It
pushes nothing about a session while a client's fresh presence names that session, and nothing
ever about a session started outside Code Remote (not in one of the agent's terminals). Nothing about builds
while a client's presence has `builds: true`.

Every push has a generic `aps.alert`, `mutable-content: 1`, a `category` (`PERMISSION`,
`QUESTION`, `DONE`, `BUILD` or none), `thread-id` (the session id, when there is one), and two custom keys: `k`, the
`keyId`, and `e`, base64 of a 12-byte nonce, the AES-256-GCM ciphertext and its 16-byte tag. The
plaintext is JSON `{ kind, title, body, session, request?, build?, question?, options? }` (`kind`:
`request`, `finished`, `resolved`, `build` or `test`; a `build` note carries the build's `id` as
`build`, comes with category `BUILD`, and follows the `finished` setting, see [Builds](#builds)). `question` and `options` (its labels) come with a
request that is one single-choice question, which can be answered from the notification; so the
relay and APNs never see a command, prompt or session title.
