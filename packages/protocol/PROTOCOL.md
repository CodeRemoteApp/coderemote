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
