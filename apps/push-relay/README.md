# Code Remote push relay

A Cloudflare Worker that forwards push notifications from `coderemote` agents to Apple (APNs).
Agents can't hold the app's APNs key, so they send here; the relay adds Apple's provider token
and passes the notification on.

## What it sees and keeps

- **Sees:** the device's push token, a ticket, and a notification whose content the agent
  already encrypted for the phone (AES-256-GCM with a key only the phone and that computer
  have). The visible text is a generic "A session needs your attention".
- **Keeps:** nothing. There are no storage bindings, logging is off, and the only state is the
  platform's short-lived rate-limit counters, keyed by a hash of the token.

## API

| Route | Body | Response |
| --- | --- | --- |
| `POST /v1/register` | `{ token, environment }` | `{ ticket }` |
| `POST /v1/send` | `{ token, environment, ticket, payload, pushType?, collapseId?, priority?, expiration? }` | `{ status, apnsId }`, or APNs's `{ status, reason }` with its HTTP status |

`environment` is `production` or `development` (the APNs sandbox, for debug builds). A ticket is
an HMAC of the environment and token under `RELAY_SECRET`: the app gets it once and hands it to
each agent it enables notifications on, and `send` refuses any request whose ticket doesn't match
(403) before contacting APNs. `payload` is the APNs JSON payload (at most 4 KB); `pushType` is
`alert` (default), `background` or `liveactivity`. Sends are limited to about 20 per minute per
token (429). APNs's 410 `Unregistered` and 400 `BadDeviceToken` come back as they are, so the
agent can drop the registration.

## Deploy

```sh
npm install
npx wrangler login
npx wrangler secret put APNS_KEY        # paste the AuthKey_XXXX.p8 file's contents
npx wrangler secret put APNS_KEY_ID     # the key's 10-character id
npx wrangler secret put APNS_TEAM_ID    # the Apple Developer team id
npx wrangler secret put BUNDLE_ID       # the app's bundle id (the APNs topic)
npx wrangler secret put RELAY_SECRET    # e.g. `openssl rand -base64 48`; rotating it voids every ticket
npx wrangler deploy
```

For `npx wrangler dev`, put the same values in `.dev.vars` (ignored by git).

## Tests

`npm test` (also run by `npm test` at the repository root) checks tickets, signing, the
sandbox, rate limiting and APNs errors with APNs mocked; it needs no Cloudflare account.
