# Contributing to vscoderemote

Thanks for helping. Bug reports, fixes, docs and features are all welcome. By taking part you
agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

**Security issues are not filed as public issues.** See [SECURITY.md](SECURITY.md).

## Layout

| Path | What it is |
| --- | --- |
| `apps/agent` | `coderemote` CLI (published to npm): starts the agent and hosts it through a dev tunnel |
| `packages/agent-core` | the agent's HTTP + WebSocket server (files, git, terminals) |
| `packages/protocol` | wire contract shared by the agent and clients, documented in `PROTOCOL.md` |
| `packages/VSRemoteKit` | Swift package: API client, pairing, tunnel sign-in, terminal UI |
| `apps/ios` | the iOS app |

## Setting up

Requirements: Node.js 20+, Xcode 27+, the [devtunnel CLI](https://learn.microsoft.com/azure/developer/dev-tunnels/get-started)
(`brew install --cask devtunnel`), and an iPhone for the app.

```sh
npm install                          # agent workspaces (also builds the CLI bundle)
(cd apps/agent && npm link)          # puts `coderemote` on your PATH, linked to this checkout
xcodebuild -downloadComponent MetalToolchain   # once, for SwiftTerm
cp apps/ios/Config/Local.xcconfig.example apps/ios/Config/Local.xcconfig
# set DEVELOPMENT_TEAM and BUNDLE_ID_PREFIX in Local.xcconfig (a free Apple ID works)
scripts/ios-device.sh                # build, install and launch on your iPhone
```

Never commit `Local.xcconfig`, tokens, or anything from `~/.coderemote/`.

## Tests

```sh
npm test          # agent end-to-end tests (real HTTP, WebSocket and PTY)
npm run test:kit  # VSRemoteKit unit tests
```

Both must pass before a pull request is merged. Add tests with the change: the agent tests
run against an in-process server, and the Kit tests cover parsing, encoding and auth logic.

UI changes are checked by hand on a real iPhone; describe what you tried (and add a
screenshot or recording) in the pull request. Automated tests must never drive a terminal
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

In Claude Code, `/release` does all of it: picks the next patch version (or the one you pass,
`/release v1.2.0`, `/release v1.2.0-beta.1`, `/release beta`), checks that `main` is clean and
pushed and that tests pass, pushes the tag, follows the workflow, verifies npm and creates the
GitHub release. See `.claude/skills/release/`.

## Changing the protocol

The agent and the app talk through the contract in `packages/protocol`. When you change it:

1. Update `packages/protocol/index.js`, `PROTOCOL.md`, and
   `packages/VSRemoteKit/Sources/VSRemoteKit/Protocol.swift` together.
2. Bump `PROTOCOL_VERSION` (both sides) for any change an older client or agent can't handle.

## Security-sensitive areas

Changes here get extra review; please explain the reasoning in the pull request:

- the shared-folder sandbox (`packages/agent-core/src/sandbox.js`): nothing outside the folder
  `coderemote up` runs in may be reachable
- authentication: the bearer token, the tunnel sign-in handoff (`handoff.js`, `TunnelAuth.swift`)
  and pairing links
- anything that runs commands (`git.js` uses `execFile` without a shell; keep it that way)

## Pull requests

- Keep each pull request to one change, and match the style of the surrounding code.
- Write commit messages that say what changed and why.
- Sign off every commit (`git commit -s`) to certify the
  [Developer Certificate of Origin](https://developercertificate.org/): that you wrote the
  change or have the right to submit it under this project's license.

## License of contributions

The project is licensed under the [GNU AGPL v3.0 or later](LICENSE). By submitting a
contribution you agree that it is licensed under the same terms, and you additionally grant
the project maintainer a perpetual, worldwide, non-exclusive, royalty-free license to
distribute your contribution as part of the official app builds through app stores (such as
the Apple App Store) whose terms may add restrictions the AGPL doesn't allow. Everyone keeps
the full AGPL rights to the source code.
