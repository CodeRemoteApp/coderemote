# Code Remote protocol v4

The agent listens on `127.0.0.1` and is reachable remotely only through a Dev Tunnel
(`https://<tunnel>-<port>.<region>.devtunnels.ms`). The agent's bearer token is always
required. By default the tunnel is also private: the relay admits only the dev tunnels account
that owns it (see [Tunnel sign-in](#tunnel-sign-in)). `coderemote up --allow-anonymous` drops
that second layer and leaves the token as the only boundary.

Every request carries:

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer <token>` |
| `X-Tunnel-Skip-AntiPhishing-Page` | `true` (skips the Dev Tunnels browser interstitial) |

## Pairing

The agent prints a QR code for `vsremote://pair?url=<https base url>&token=<token>`.
`coderemote rotate-token` invalidates every paired device.

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
| `GET /api/info` | | `{ protocol, hostname, platform, root, user, shell }` |
| `GET /api/fs/list?path=` | | `{ path, entries: [{ name, type, size, mtime, target? }] }` |
| `GET /api/fs/stat?path=` | | `{ path, name, type, size, mtime, target? }` |
| `GET /api/fs/read?path=` | | raw bytes |
| `PUT /api/fs/write?path=` | raw bytes | entry; written atomically via temp file + rename |
| `POST /api/fs/mkdir?path=` | | `{}` (recursive) |
| `POST /api/fs/rename` | `{ from, to }` | `{}` |
| `DELETE /api/fs?path=` | | `{}` (recursive) |

`type` is `dir | file | symlink | other`; for symlinks `target` is the resolved kind or `broken`.
`mtime` is milliseconds since the epoch.

## Git

Repositories are found by scanning the shared folder up to 4 levels deep (hidden folders,
`node_modules`, build output and nested repositories are skipped). `repo` is a repository's
absolute path; file paths are relative to it and must stay inside it. Git never prompts:
pull/push use the machine's existing credentials or fail. Git failures return 409 with git's message.

| Route | Request | Response |
| --- | --- | --- |
| `GET /api/git/repos` | | `{ repos: [{ path, name, branch }] }` |
| `GET /api/git/status?repo=` | | `{ branch, upstream, ahead, behind, files: [{ path, index, worktree, origPath?, conflicted? }] }` |
| `GET /api/git/diff?repo=&path=&staged=1&untracked=1` | | `{ text, truncated }` |
| `POST /api/git/stage` | `{ repo, files }` | status |
| `POST /api/git/unstage` | `{ repo, files }` | status |
| `POST /api/git/discard` | `{ repo, files }` | status; untracked files are deleted |
| `POST /api/git/commit` | `{ repo, message }` | `{ hash, short, subject, author, date, refs }` |
| `GET /api/git/log?repo=&limit=` | | `{ commits: [commit] }` |
| `GET /api/git/show?repo=&commit=` | | `{ text, truncated }` |
| `POST /api/git/pull` | `{ repo }` | `{ output }` (fast-forward only) |
| `POST /api/git/push` | `{ repo }` | `{ output }` |

`index`/`worktree` are porcelain letters: `.` unchanged, `M`, `A`, `D`, `R`, `?` untracked.

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
| `GET /api/ports` | | `{ ports: [{ port, addresses, pid, name, command, cwd, session, self, agent }] }` |
| `POST /api/ports/kill` | `{ pid, force? }` | `{}`; `SIGTERM`, or `SIGKILL` when `force` is true |

One entry per process and port, sorted by port. `addresses` are the bound addresses
(`127.0.0.1`, `::1`, `*` for all interfaces). `command` is the full command line and `cwd` the
process's working directory (null when unreadable). `session` is the id of the terminal session
the process was started from (it descends from that session's shell), or null. `self` marks the
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
| `GET /api/preview` | | `{ ports: [{ port, url, sharedUntil }], token, expiresAt }` |
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
