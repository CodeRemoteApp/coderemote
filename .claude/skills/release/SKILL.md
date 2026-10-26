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

## 3. Tag and push

```sh
git tag -a <tag> -m "coderemote <version>"
git push <remote> <tag>
```

Push only the tag, never `--tags` or `--follow-tags` (other local tags must not be published).

## 4. Follow the workflow

Find the run the tag started and wait for it (it takes a few minutes on macOS runners):

```sh
gh run list --workflow publish-npm.yml --limit 5 --json databaseId,headBranch,status,conclusion,url
gh run watch <databaseId> --exit-status
```

Match the run by `headBranch` equal to the tag. If it fails, show the failing step's log
(`gh run view <id> --log-failed`) and stop; don't retry or delete the tag on your own. A tag
that never published can be removed with the user's go-ahead
(`git push <remote> :refs/tags/<tag>` and `git tag -d <tag>`).

## 5. Verify on npm

The tarball can take a few minutes to reach npm's CDN after the version appears.

```sh
npm view coderemote@<version> version dist-tags --json
```

Then confirm `curl -s -o /dev/null -w '%{http_code}' https://registry.npmjs.org/coderemote/-/coderemote-<version>.tgz`
returns 200, polling with a background `until` loop (no foreground sleep) for up to ~10 minutes.

## 6. GitHub release

```sh
gh release create <tag> --verify-tag --generate-notes --title "coderemote <version>" [--prerelease]
```

Add `--prerelease` when `distTag` is `next`.

## 7. Report

One short summary: the version, the previous one, the npm link
(`https://www.npmjs.com/package/coderemote/v/<version>`), the GitHub release link, and the
install command (`npm install -g coderemote`, or `coderemote@next` for a prerelease).
