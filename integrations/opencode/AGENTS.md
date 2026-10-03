# @corvi/opencode

## Owns

opencode's agent-state reporter: `src/agent-state.ts`, the opencode plugin that publishes Corvi's
agent protocol (the status facts of docs/manual/terminals.md, via `corvi status`) from opencode's
event stream — working/waiting, the agent's name, the session's title, and the first sentence of
the last answer. It runs inside opencode, not inside Corvi: `bun run extension:install:opencode`
symlinks the entry file into opencode's plugin directory (`scripts/extension.ts` owns the
mechanics). The plugin is the current `{ id, server }` module form; opencode's core-v2
`{ id, setup }` surface cannot be a reporter (no event subscription).

- `./cli-guide`: the CLI guide — the compact `corvi` pointer the system prompt gets behind the
  pane gate (`CORVI_CHANGE_ID`), so nothing appears outside Corvi. Its text is deliberately
  duplicated in `integrations/pi/src/cli-guide.ts` (the two extensions share no code) and pinned
  equal by `test/cliGuide.test.ts`.
- `./node/log`: the extension log sink — Corvi's own errors (a failed command, a failed publish)
  are appended to the app log (`CORVI_LOG`) rather than written to the pane's screen, which Corvi
  parses and persists. Duplicated in `integrations/pi/src/node/log.ts` and pinned equal by
  `test/integrationLog.test.ts`.

## Does not own

Corvi's reader for the protocol (`@corvi/agents/presenter`), the vocabulary itself (stated in
docs/manual/terminals.md), or pi's reporter (`integrations/pi`). The two reporters deliberately
share no code: each is loaded by its agent outside Corvi's module graph.

## Public entrypoints

- `@corvi/opencode/agent-state`: the plugin module opencode loads (default export) and its pure
  helpers (`firstSentence`, `trackAnswer`).
- `@corvi/opencode/cli-guide`: the guide module and its pure half (`guideText`, `applyGuide`).

## Dependencies

Type-only on `@opencode-ai/plugin` (opencode provides the module at runtime). No `@corvi/*`
packages; the only Node built-in is `node:fs` (the log sink's synchronous append). Publishing is
the `BunShell` opencode hands the plugin (`input.$\`corvi …\``), fire and forget.

## Verification

`bun run typecheck`, `bun run lint`, `bun run boundaries`, `bun run test`.
