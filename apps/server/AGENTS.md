# @corvi/server

## Owns

HTTP, SSE and WebSocket hosting, and the backend composition: the capability layer
(`src/capabilities/**`), the feature modules (`src/change`, `src/dashboard`, `src/devices`,
`src/settings`, `src/terminals`, `src/workspace`, `src/wizard` server halves), and the included
integrations (`src/integrations/**`: their server halves and the contract dispatch that exposes
them).

`src/gateway` is the local server's reverse proxy to a remote workspace's server: it resolves
`/remote/<source>/…` from the config, strips the prefix, injects the remote's device token,
streams HTTP and SSE, and bridges the terminal WebSocket. It adds no auth of its own — it sits
behind the same origin guard and, on the external listener, the same device-token authorizer. It
drops the browser's Origin/Referer/Sec-Fetch-* on the way out (the remote's own guard would
reject the local page's origin), refuses a redirect the remote tries to send it, and bounds the
WebSocket bridge's buffering.

`src/devices` owns device identity, pairing and token authentication. Pairing has two faces: the
`pairing-codes/redeem` route returns the raw token for the gateway/CLI, and `pair` puts it in the
HttpOnly cookie for the remote browser (which then bootstraps through `devices/session`). `src/remote-access` owns
the external listener's lifecycle: `src/server.ts` installs it and the settings write reconciles
it, so toggling remote access starts, stops or restarts the second loopback listener without a
process restart. It serves the same route table with an `authorize` hook that requires a device
token on every `/api/*` request, and on WebSocket upgrades, except the redeem bootstrap; the
local listener stays tokenless. A bind failure degrades to local-only and is reported through
the settings view's `remoteAccessStatus`. `src/tailscale` publishes that loopback port with
`tailscale serve` and reports the tailnet URL; it never runs `off` on a 443 tree that also holds
someone else's handler, refuses to displace a mapping that is not ours, and tracks the port it
published so unpublish still finds it after the configured port moves.

A workspace may be remote (`remote: { url, workspace, token }`) instead of a local settings
scope. `src/workspace` keeps the entry with the same per-item tolerance as any workspace and
masks both its device token and every declared extension secret at both read surfaces
(`GET /api/workspaces`, which shares the settings view's `redactSecrets`, and the settings view).
A save that hands the mask back keeps the stored token; an omitted token keeps it too, while
`token: ""` clears it (`settings/server/remoteSecrets.ts`).

Public entrypoint: `src/server.ts` (`bun run dev`, `bun run start`).

The server serves the built browser application from `apps/web/dist` (or `CORVI_WEB_DIST`) and
does not import `@corvi/web`; `bun run build:web` builds it ahead of time.

## Does not own

The browser application (that is `@corvi/web`), the desktop host, or the domain packages under
`packages/*`. Node built-ins are allowed anywhere in this application (rule `"node": true`), and
the failure/status mapping for every route lives at this boundary
(`src/capabilities/effect/http.ts`).

## Dependencies

`@corvi/contracts`, `@corvi/configuration`, `@corvi/changes`, `@corvi/repositories`,
`@corvi/terminals`, `@corvi/agents`, `@corvi/shell`, `@corvi/workflows`, `@corvi/client`, plus
`effect`, `node-pty` and `ws`. Browser dependencies (`react`, `@xterm/*`) belong to `@corvi/web`.

## Verification

`bun run typecheck`, `bun run lint`, `bun run boundaries`, `bun run test`.
