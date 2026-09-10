# Effect conventions

> **Kind:** guide · **Status:** active

This is the standing contract for server-side `src/` code. It exists so that changes land as
one coherent whole instead of one accent each. If a change needs to break a rule here, it says
so first and this file is changed — the code follows the file, never the other way round.

The rewrite that first wrote these rules down, and the rulings it produced, are recorded in
[`../decisions/effect-migration.md`](../decisions/effect-migration.md).

## Scope

Server-side `src/` only. Excluded, deliberately:

- `src/terminalProxy.ts` — the WebSocket bridge stays as-is; it is proxy plumbing, not logic.
- `src/web/**` — the React UI never sees Effect.
- `src/origin.ts` — the sync guard stays as-is.
- `src/platform.ts` — platform detection stays as-is.
- Purely synchronous code (pure string logic, pure data shaping) — no effect wrapper buys
  anything there.

## Style

- Sequential effectful code is written with `Effect.gen` and `yield*`; composition chains use
  `pipe`. Do not nest `Effect.map`/`Effect.flatMap` towers inside a `gen` block — pick one.
- Errors are **typed values in the `E` channel**. Never `throw` across a module boundary; never
  `Effect.die` to express a domain failure. Genuinely unexpected failures (a broken invariant,
  a corrupted runtime state) remain untyped defects and are allowed to die.

## Naming

A server function is named for what it does, never for the fact that it returns an Effect. There
is no `Effect` suffix: `readChange`, `createChange`, `sh`, `swr`. When a synchronous sibling of
the same operation exists, it takes the `Sync` suffix and the plain name stays with the Effect
one — `readFile`/`readFileSync`, `reloadConfig`/`reloadConfigSync`,
`settingsView`/`settingsViewSync` — so a name means the same thing whether or not the caller can
wait.

## Error taxonomy (`src/effect/errors.ts`)

One small sealed tagged set, shared by every module. **No per-module error hierarchies beyond
this** — if a failure does not fit, it is a defect, or it fits one of these with a message.

| Error          | Meaning                                   | Carries                                          |
| -------------- | ----------------------------------------- | ------------------------------------------------ |
| `NotFoundError`  | the thing asked about does not exist      | human-readable message (maps 404)                |
| `BadRequestError`| the request itself is wrong               | human-readable message (maps 400)                |
| `ConflictError`  | the state forbids it (409)                | message, optional `needsForce` payload           |
| `CliError`       | an external CLI failed                    | `tool`, `command`, `stderr`, exit code           |
| `DecodeError`    | Schema validation failed                  | message, `source`: request body / file / CLI JSON|

Each error carries the human-readable message the old `throw new Error(...)` had — the strings
users saw before are the strings users see after. `errors.ts` holds data types and message
formatting only; it knows nothing about HTTP.

## Services (`src/effect/tags.ts`)

A `Workspace` service `Context.Tag` carries the workspace config object (the `Workspace` type
in `src/config.ts`) through a request, replacing the ambient `AsyncLocalStorage` that preceded
it.

Code that may legitimately run outside a request scope (startup, caches) uses
`Effect.serviceOption(Workspace)` and falls back to **exactly the old behavior**: `undefined`
workspace, empty env override. No tag lookup may fail where the old ambient context returned
`undefined`.

## Concurrency

- Hand-rolled queues and counters become `Effect.makeSemaphore` / `Effect.forEach` with an
  explicit concurrency.
- Timeouts are `Effect.timeout` with interruption, and whatever the effect spawned must be
  **killed on interruption** — a timed-out `git` that keeps running is a leak, not a timeout.

## Schemas

- Effect Schema (`effect/Schema`) parses: `change.json`, `config.json`, request bodies, and CLI
  `--json` output. Decode failures become `DecodeError`.
- Deliberate tolerance stays, but is **explicit**: a documented silent fallback becomes
  `Schema.decode(...)` piped through `Effect.orElseSucceed` (or the equivalent combinator) with
  a comment saying which README behavior it preserves. Never a bare `as` cast — that is what
  the tolerance rules exist to prevent.

## Verification (every task, before reporting done)

```sh
bun run typecheck && bun run lint && bun test
```

Green means: typecheck passes, lint passes, and `bun test` shows **only** the known
`test/webkit.test.ts` failure (Playwright WebKit cannot launch here). Workers never run
`git commit`; the coordinator commits.
