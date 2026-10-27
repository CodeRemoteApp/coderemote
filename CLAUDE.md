# coderemote

See `CONTRIBUTING.md` for setup, tests and releases.

## Rebuild after CLI changes

`coderemote-dev` is a symlink to `apps/agent/dist/coderemote.js`, the bundled CLI. It does not
pick up source edits on its own. After any change under `apps/agent` or `packages/` that the CLI
uses, run `npm run build` in `apps/agent` before saying the change is ready to try.
