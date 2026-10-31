---
name: release
description: Release the coderemote CLI to npm by pushing a version tag. With no argument it bumps the patch number (v1.1.21 → v1.1.22); "/release v1.2.0" or "/release v1.2.0-beta.1" releases that exact version; "/release beta" cuts the next beta. Use only when the user runs /release or explicitly asks to release or publish coderemote.
argument-hint: "[vX.Y.Z | vX.Y.Z-beta.N | beta]"
disable-model-invocation: true
---

# Release coderemote

Releases are tag-driven: pushing a tag `vX.Y.Z` makes `.github/workflows/publish-npm.yml`
run the agent tests and publish `coderemote@X.Y.Z` to npm (prereleases go to the `next`
dist-tag). Nothing in the repository is bumped or committed. Invoking this skill is the
user's go-ahead to push the tag, so don't ask for confirmation unless a check below fails or
something looks off.

The requested version is: `$ARGUMENTS` (empty means "next patch").

## 1. Work out the version

```sh
node .claude/skills/release/next-version.mjs $ARGUMENTS
```

It reads the existing git tags and the versions on npm, and prints
`{ version, tag, distTag, previous }`, or exits 1 with the reason (invalid version, already
released, or not newer than the latest release). On failure, stop and tell the user why.

If the result is a plain patch bump but `previous` is a newer prerelease (e.g. the patch is
v1.1.22 while v1.2.0-beta.3 exists), mention that `/release v1.2.0` would promote the beta, and
continue with the patch release.

## 2. Preflight

All of these must hold; otherwise stop and report what to fix:

- The working tree is clean (`git status --porcelain` prints nothing).
- The current branch is `main`, and it matches the remote: `git fetch <remote> main` then
  `git rev-parse HEAD` equals `git rev-parse <remote>/main`. The remote is the one `main`
  tracks (`git rev-parse --abbrev-ref main@{upstream}`, e.g. `origin/main`); with no
  upstream, use the only entry of `git remote`, and ask if there are several. A release is
  always of a commit that's already pushed.
- The tag doesn't exist on the remote either: `git ls-remote --tags <remote> <tag>` is empty.
- `npm test` passes locally (the workflow runs it again, but failing here saves a round trip).
- `MIN_CLIENT_PROTOCOL` in `packages/protocol/index.js` hasn't gone up since `<previous>`
  (`git diff <previous> HEAD -- packages/protocol/index.js`). If it has, agents of this release
  tell every client older than it to update, so a client release that speaks the new protocol must
  already be installable by its users. Stop and ask the user to confirm that before tagging.
  `PROTOCOL_VERSION` going up alone is fine: older clients keep working.

## 3. Tag and push

```sh
git tag -a <tag> -m "coderemote <version>"
git push <remote> <tag>
```

Push only the tag, never `--tags` or `--follow-tags` (other local tags must not be published).

## 4. GitHub release

```sh
gh release create <tag> --verify-tag --generate-notes --title "coderemote <version>" [--prerelease]
```

Add `--prerelease` when `distTag` is `next`.

## 5. Report and stop

Don't wait for or watch the publish workflow, and don't poll npm: the user monitors those
and comes back if something fails. Find the run the tag started once (no waiting):

```sh
gh run list --workflow publish-npm.yml --limit 5 --json headBranch,url --jq '.[] | select(.headBranch=="<tag>") | .url'
```

(it can take a few seconds to appear; if it isn't listed yet, link the workflow's runs page
`https://github.com/<owner>/<repo>/actions/workflows/publish-npm.yml` instead).

Then one short summary: the version and the previous one, the workflow run link, the GitHub
release link, the npm link (`https://www.npmjs.com/package/coderemote/v/<version>`, live once
the workflow finishes and npm has processed it, usually a few minutes), and the install command
(`npm install -g coderemote`, or `coderemote@next` for a prerelease). A stable release also
updates the Homebrew formula (the workflow's `homebrew` job), after the npm publish.

If the user later reports a failed run: show the failing step's log
(`gh run view <id> --log-failed`). Don't retry or delete the tag on your own; a tag that never
published can be removed with their go-ahead (`git push <remote> :refs/tags/<tag>` and
`git tag -d <tag>`).
