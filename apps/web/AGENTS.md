# @corvi/web

## Owns

The browser application and the browser platform adapter: the page composition root
(`src/app-root/**`), the client halves of the features (`src/*/client/**`, `src/wizard`,
`src/integrations/*/client.tsx`), the client registry that binds the included integrations'
components (`src/integrations/client.tsx`), and the public host contract the desktop app
implements (`./host`, `./chrome`).

The bundle is built ahead of time by `src/node/build.ts` (`bun run build:web`,
`bun run dev:web`) into `apps/web/dist`; the server serves that directory.

## Does not own

The server, its routes, capabilities or storage. Shared vocabulary comes from
`@corvi/contracts` (including the capability and integration surfaces) and `@corvi/changes`;
the browser half imports no server module by value.

## Public entrypoints

- `./host`: the host capability vocabulary (`HostNotice`, `CorviHost`, `HostPlatform`)
- `./chrome`: the window chrome geometry the desktop host and the page share
- the built page in `apps/web/dist` (not an importable entrypoint)

## Dependencies

`@corvi/client`, `@corvi/contracts`, `@corvi/changes`, `@corvi/terminals`, plus `effect`,
`react`, `react-dom`, `@xterm/*` and `esbuild` (the build only). No Node built-ins outside
`src/node/`.

## Verification

`bun run typecheck`, `bun run lint`, `bun run boundaries`, `bun run test`.
