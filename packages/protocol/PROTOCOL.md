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
  quota: { used, limit } | null }
```

`provider` names the tunnel service, `"devtunnels"` (missing from agents before 0.3.8: read it as
`"devtunnels"`). Clients group machines by `provider` and `account`, one connection each.
`account` is the signed-in dev tunnels user, e.g. `"thanh (GitHub)"`. `expiration`, `uploaded` and
`downloaded` are the service's own wording (`"30 days"`, `"1188 KB"`); the expiration is pushed
back every time `coderemote up` starts. `connections` counts clients connected to the tunnel now.
`machines` are the account's tunnels labelled `coderemote` (every agent labels its own; tunnels from
older releases are missing until their agent restarts), this one first with `current: true`.
`url` is a machine's agent address, the same as in its pairing link, so clients can tell which
ones they've paired; `online` is whether an agent hosts it now. `quota` counts every tunnel on the
account, preview tunnels included, against the most it may keep (`null` when they couldn't be
listed). Tunnels are managed on a computer signed in to the account (`coderemote tunnels`,
`coderemote tunnels delete <id>`), not through this route. The answer is cached for 15 seconds.

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
| `GET /api/info` | | `{ protocol, minClientProtocol, version, hostname, platform, root, user, shell }` (see [Compatibility](#compatibility)) |
| `GET /api/fs/list?path=` | | `{ path, entries: [{ name, type, size, mtime, target? }] }` |
| `GET /api/fs/stat?path=` | | `{ path, name, type, size, mtime, target? }` |
| `GET /api/fs/read?path=` | | raw bytes; one `Range: bytes=…` gets 206 with that part (416 past the end), so media streams; video and audio files carry their media type |
| `PUT /api/fs/write?path=` | raw bytes | entry; written atomically via temp file + rename |
| `POST /api/fs/mkdir?path=` | | `{}` (recursive) |
| `POST /api/fs/rename` | `{ from, to }` | `{}` |
| `DELETE /api/fs?path=` | | `{}` (recursive) |

`type` is `dir | file | symlink | other`; for symlinks `target` is the resolved kind or `broken`.
`mtime` is milliseconds since the epoch.

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

## Agents

Coding-agent sessions running on the computer (Claude Code today), so a client can see which
ones are working, waiting or done, read what they did, and answer their permission prompts and
questions. Sessions reach the agent through `coderemote hook`, which Claude Code runs for each
hook event once `coderemote setup claude` has installed the Code Remote plugin. Added without a
protocol bump: older agents answer these routes with 404.

A session reaches the agent that started its terminal (Claude Code inherits
`CODEREMOTE_AGENT_PORT` and `CODEREMOTE_TERM_ID` from it), else the running agent whose shared
folder is the longest prefix of its working directory. Sessions in folders no agent shares are
dropped. Sessions live in the agent's memory only: they are gone when it stops, and ended ones
are forgotten 24 hours after they end.

| Route | Request | Response |
| --- | --- | --- |
| `GET /api/agents/sessions` | | `{ sessions: [session] }`, most recent activity first |
| `GET /api/agents/timeline?session=&after=` | | `{ entries: [entry], next, requests: [request] }`; `after` skips entries up to that `seq` |
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

A session is `{ id, agent, cwd, title, state, terminal, startedAt, lastActivityAt, pending,
starting, error, capabilities }`.
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

Entries are append-only, numbered by `seq` (increasing per session), and the agent keeps the
latest 500 of each session. Each is `{ seq, time, kind, ... }`:

| `kind` | Fields |
| --- | --- |
| `prompt` | `text` |
| `assistant` | `text` |
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
mode), or `command`: `command` is a `"command"` entry of the session's [commands](#commands) (or one of
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

### Requests

A request is a prompt the session is blocked on: `{ id, session, kind, tool, input,
suggestions, questions, createdAt }`. `kind` is `permission` (may `tool` run with `input`?) or
`question` (Claude Code's `AskUserQuestion`; `questions` is its list of `{ question, header,
options: [{ label, description }], multiSelect }`). `suggestions` are the "always allow" rules
Claude Code offers for a permission, as it reports them (`permission_suggestions`), possibly
empty.

For `approvals: "parallel"` sessions the prompt stays open on the computer too: whichever side
answers first wins. When the computer
answers, the request resolves as `withdrawn` by `computer`; a request nobody answers within an
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

Client to server: `{ "type": "presence", "foreground": bool }`. Send `true` while the app shows
this machine and at least every 20 seconds; while one is fresh the agent sends no pushes
(see [Push](#push)).

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

The agent pushes for a new request, when a turn that ran 60 seconds or more ends, and to replace
the notification of a request resolved elsewhere (same `apns-collapse-id`, the request id). It
pushes nothing while the computer's user was active in the last 2 minutes (macOS only) or a
client's presence is fresh.

Every push has a generic `aps.alert`, `mutable-content: 1`, a `category` (`PERMISSION`,
`QUESTION`, `DONE` or none), `thread-id` (the session id), and two custom keys: `k`, the
`keyId`, and `e`, base64 of a 12-byte nonce, the AES-256-GCM ciphertext and its 16-byte tag. The
plaintext is JSON `{ kind, title, body, session, request?, question?, options? }` (`kind`:
`request`, `finished`, `resolved` or `test`). `question` and `options` (its labels) come with a
request that is one single-choice question, which can be answered from the notification; so the
relay and APNs never see a command, prompt or session title.
