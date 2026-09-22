# @corvi/server

## Owns

HTTP, SSE and WebSocket hosting, and the backend composition: the capability layer
(`src/capabilities/**`), the feature modules (`src/change`, `src/dashboard`, `src/settings`,
`src/terminals`, `src/workspace`, `src/wizard` server halves), the included integrations
(`src/extensions/**`) and the contract dispatch that exposes them (`src/integrations/**`).

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
