# @corvi/terminals

## Owns

Session and window identity, input handling, attachment and owned PTY resources.

- `./model`: the pure keyboard vocabulary — the platform word, the new-window key test, and the
  CSI-u sequences a terminal cannot encode by itself. No imports.
- `./tmux`: the tmux operations (attach argv, window listing/creating/moving, prompt paste,
  session recycling) over a `Host` the app supplies — command execution and the product's names.
- `./session`: one pty per socket, the buffer before the upgrade, the attachments this process
  owns and closes on shutdown, and the socket handlers, over a `PtySpawner` the app supplies.

## Does not own

Agent conversation identity, change transitions, notifications policy. The presenter
aggregation stays in the app (`src/terminals/server/presenter.ts`) because it composes the
agents integration; the routes stay in `src/terminals/routes.ts` because they are transport.

## Public entrypoints

- `@corvi/terminals/model`: `Platform`, `isNewWindowKey`, `csiuFor`
- `@corvi/terminals/tmux`: `make(host)`, `formatFor`, `parseWindow`
- `@corvi/terminals/session`: `makeAttachments(attachCommand, spawnPty)`

## Dependencies

`@corvi/contracts` (the raw window type) and `effect` (the tmux operations' effect types).
No Node built-ins: process execution and pty spawning are the app's ports.

## Verification

`bun run typecheck`, `bun run lint`, `bun run boundaries`, `bun run test`.
