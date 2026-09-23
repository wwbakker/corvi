# @corvi/opencode

## Owns

opencode's agent-state reporter: `src/agent-state.ts`, the opencode plugin that publishes Corvi's
agent protocol (the `@agent_*` tmux pane options of docs/manual/terminals.md) from opencode's
event stream — working/waiting, the agent's name, the session's title, and the first sentence of
the last answer. It runs inside opencode, not inside Corvi: `bun run extension:install:opencode`
symlinks the entry file into opencode's plugin directory (`scripts/extension.ts` owns the
mechanics). The plugin is the current `{ id, server }` module form; opencode's core-v2
`{ id, setup }` surface cannot be a reporter (no event subscription).

## Does not own

Corvi's reader for the protocol (`@corvi/agents/presenter`), the vocabulary itself (stated in
docs/manual/terminals.md), or pi's reporter (`integrations/pi`). The two reporters deliberately
share no code: each is loaded by its agent outside Corvi's module graph.

## Public entrypoints

- `@corvi/opencode/agent-state`: the plugin module opencode loads (default export) and its pure
  helpers (`firstSentence`, `trackAnswer`).

## Dependencies

Type-only on `@opencode-ai/plugin` (opencode provides the module at runtime). No `@corvi/*`
packages, no Node built-ins: publishing is the `BunShell` opencode hands the plugin
(`input.$\`tmux …\``), fire and forget.

## Verification

`bun run typecheck`, `bun run lint`, `bun run boundaries`, `bun run test`.
