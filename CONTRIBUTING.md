# Contributing to Code Remote

Thanks for helping. Bug reports, fixes, docs and features are all welcome. By taking part you
agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

**Security issues are not filed as public issues.** See [SECURITY.md](SECURITY.md).

## Layout

| Path | What it is |
| --- | --- |
| `apps/agent` | `coderemote` CLI (published to npm): starts the agent and hosts it through a dev tunnel |
| `packages/agent-core` | the agent's HTTP + WebSocket server (files, git, terminals) |
| `packages/protocol` | wire contract shared by the agent and clients, documented in `PROTOCOL.md` |
| `plugins/claude` | Claude Code plugin: `hooks/hooks.json` runs `coderemote hook` for each session event. The repository root is its marketplace (`.claude-plugin/marketplace.json`) |
| `plugins/codex` | Codex plugin (`.codex-plugin/plugin.json`, `hooks/hooks.json` running `coderemote hook --agent codex`), listed in `.agents/plugins/marketplace.json`. Try it with `CODEX_HOME=<temp dir> coderemote setup codex --marketplace .` |

To try plugin changes without installing them, start Claude Code with
`claude --plugin-dir plugins/claude` in a folder a `coderemote serve` agent shares, with
the freshly built `apps/agent/dist/coderemote.js` first on `PATH` as `coderemote`. Bump
`version` in `plugins/claude/.claude-plugin/plugin.json` when the hooks change, so
installed copies update. Check both with `claude plugin validate .`.

## Setting up

Requirements: Node.js 20+. `coderemote up` downloads the
Dev Tunnels CLI on first use (or uses a `devtunnel` on your `PATH`).

```sh
npm install                          # agent workspaces (also builds the CLI bundle)
(cd apps/agent && npm link)          # puts `coderemote` on your PATH, linked to this checkout
```

Never commit tokens or anything from `~/.coderemote/`.

## Tests

```sh
npm test          # agent end-to-end tests (real HTTP, WebSocket and PTY)
```

They must pass before a pull request is merged. Add tests with the change: they run against
an in-process server. Automated tests must never drive a terminal
session or agent that someone is actually using: start a throwaway agent on another port.

## The npm package

`apps/agent` is published to npm as [`coderemote`](https://www.npmjs.com/package/coderemote).
`scripts/build.js` bundles the CLI together with `packages/agent-core` and `packages/protocol`
into `dist/coderemote.js` (run on `npm install`, `npm link` and `npm pack`), so the package
depends only on `node-pty`, `ws` and `qrcode-terminal`. After changing agent code, rebuild
with `npm run build -w coderemote` before trying the linked `coderemote` command.

Check what would be published with `npm pack --dry-run -w coderemote`.

Releases are cut by pushing a version tag; the tag is the version, nothing is bumped by hand:

```sh
git tag v1.1.2 && git push origin v1.1.2        # coderemote@1.1.2 on npm ("latest")
git tag v1.2.0-beta.1 && git push origin v1.2.0-beta.1   # prerelease ("next")
```

`.github/workflows/publish-npm.yml` runs the tests and publishes with npm Trusted Publishing.
For a stable release it then writes the Homebrew formula (`packaging/homebrew/formula.mjs`) for
the published tarball into [CodeRemoteApp/homebrew-tap](https://github.com/CodeRemoteApp/homebrew-tap),
using the `HOMEBREW_TAP_TOKEN` secret. CI installs a formula built from the checkout on macOS.

In Claude Code, `/release` does all of it: picks the next patch version (or the one you pass,
`/release v1.2.0`, `/release v1.2.0-beta.1`, `/release beta`), checks that `main` is clean and
pushed and that tests pass, pushes the tag and creates the
GitHub release. See `.claude/skills/release/`.

## Install scripts

`install.sh` (macOS, Linux) and `install.ps1` (Windows PowerShell 5.1 and later) are served
straight from `main`, so a change goes live when it's merged. They run `npm install -g coderemote`
with the user's Node.js 20+, or else download Node.js into `~/.coderemote/runtime/node` and
install coderemote there; `coderemote update` recognises that install (`src/update.js`). The CI
workflow installs this checkout both ways on all three systems. To try one locally without
touching your own install:

```sh
CODEREMOTE_PACKAGE="$PWD/$(npm pack -w coderemote --silent | tail -n 1)" \
CODEREMOTE_RUNTIME_DIR=/tmp/cr/runtime CODEREMOTE_PRIVATE_NODE=1 CODEREMOTE_NO_MODIFY_PATH=1 sh install.sh
```

## Changing the protocol

The agent and the app talk through the contract in `packages/protocol`. When you change it:

1. Update `packages/protocol/index.js` and `PROTOCOL.md` together.
2. Bump `PROTOCOL_VERSION` for any change an older client can't handle.

## Security-sensitive areas

Changes here get extra review; please explain the reasoning in the pull request:

- the shared-folder sandbox (`packages/agent-core/src/sandbox.js`): nothing outside the folder
  `coderemote up` runs in may be reachable
- authentication: the bearer token, the tunnel sign-in handoff (`handoff.js`)
  and pairing links
- anything that runs commands (`git.js` uses `execFile` without a shell; keep it that way)
- `coderemote hook` and the agents routes: the hook must fail open (exit 0, print nothing)
  whatever happens, and hook deliveries are authenticated by `~/.coderemote/hook-secret`,
  which never leaves the computer

## Pull requests

- Keep each pull request to one change, and match the style of the surrounding code.
- Write commit messages that say what changed and why.
- Sign off every commit (`git commit -s`) to certify the
  [Developer Certificate of Origin](https://developercertificate.org/): that you wrote the
  change or have the right to submit it under this project's license.

## License of contributions

The project is licensed under the [GNU AGPL v3.0 or later](LICENSE). By submitting a
contribution you agree that it is licensed under the same terms.
