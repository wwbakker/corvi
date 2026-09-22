# @corvi/desktop

## Owns

The Electron host and the native platform adapter: the app's window and its server process
(`src/electron/main.ts`), the `contextBridge` transport for the page's host contract
(`src/electron/preload.ts`), the esbuild bundling of both (`src/electron/build.ts`), and the
installers/launchers for macOS and Linux (`src/mac.ts`, `src/linux.ts`). The `install` CLI
(`bun apps/desktop/src/install.ts install|uninstall|run`) is the package's entrypoint.

The host implements `@corvi/web`'s public host contract (`./host`) and shares the window chrome
geometry (`./chrome`) with the page.

## Does not own

The server (`@corvi/server`) or the browser application (`@corvi/web`). Desktop starts the
server as a process boundary — it spawns `apps/server/src/server.ts` and never imports it — and
builds/serves the already-built web assets through the checkout.

## Public entrypoints

- `@corvi/desktop/build`: `buildApp(outDir, root)` — bundles the main process and preload
- `@corvi/desktop/binary`: `electronBinary()`, `installedElectron()`
- `@corvi/desktop/run`: `devAppDir()`, `run()` — run the app from the checkout

## Dependencies

`@corvi/web` (the host contract), `@corvi/configuration` (product identity, paths and platform
facts), `electron`, `@electron/packager` and `esbuild`. Node built-ins are allowed
(`"node": true`); the app's own commands go through `src/exec.ts`.

## Verification

`bun run typecheck`, `bun run lint`, `bun run boundaries`, `bun run test`.
