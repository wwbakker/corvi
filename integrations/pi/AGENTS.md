# @corvi/pi

## Owns

Pi's agent-state reporter: `src/agent-state.ts`, the pi extension that publishes Corvi's agent
protocol (the `@agent_*` tmux pane options of docs/manual/terminals.md) from pi's own events —
working/waiting, the agent's name, the session's name, and the first sentence of the last answer.
It runs inside pi, not inside Corvi: `bun run extension:install:pi` symlinks the entry file into
pi's extensions directory (`scripts/extension.ts` owns the mechanics).

## Does not own

Corvi's reader for the protocol (`@corvi/agents/presenter`), the vocabulary itself (stated in
docs/manual/terminals.md), or opencode's reporter (`integrations/opencode`). The two reporters
deliberately share no code: each is loaded by its agent outside Corvi's module graph.

## Public entrypoints

- `@corvi/pi/agent-state`: the extension module pi loads (default export) and its pure helpers
  (`firstSentence`, `textOf`).

## Dependencies

Type-only on `@earendil-works/pi-coding-agent` (pi provides the module at runtime). No `@corvi/*`
packages, no Node built-ins: publishing is `pi.exec("tmux", …)`, fire and forget.

## Verification

`bun run typecheck`, `bun run lint`, `bun run boundaries`, `bun run test`.
