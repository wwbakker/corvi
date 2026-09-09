# Effect conventions for the IWE rewrite

This file is the **binding contract** for every task that rewrites a `src/` module to Effect.
It exists so that forty small migrations land as one coherent rewrite instead of forty accents.
If a task needs to break a rule here, it says so to the coordinator first and this file is
changed — the code follows the file, never the other way round.

## Scope

The rewrite covers **server-side `src/` only**. Excluded, deliberately:

- `src/terminalProxy.ts` — the WebSocket bridge stays as-is; it is proxy plumbing, not logic.
- `src/web/**` — the React UI never sees Effect.
- `src/origin.ts` — the sync guard stays as-is.
- `src/platform.ts` — platform detection stays as-is.
- Purely synchronous code (pure string logic, pure data shaping) — no effect wrapper buys
  anything there.

## Goal: behavior-preserving

This is a rewrite, not a redesign. None of the following may change:

- HTTP routes and their response shapes and status codes.
- SSE event semantics.
- Config fallback semantics (the silent fallbacks the README documents are kept, but made
  explicit in code — see Schemas below).
- The bun test suite. **Tests pass unmodified except import paths.**

**Known baseline:** `bun test` currently has exactly one failing test, `test/webkit.test.ts`,
which fails because Playwright WebKit cannot launch on this machine (environmental,
pre-existing). Success for every migration task is *that same single failure and nothing new*.

## Style

- Sequential effectful code is written with `Effect.gen` and `yield*`; composition chains use
  `pipe`. Do not nest `Effect.map`/`Effect.flatMap` towers inside a `gen` block — pick one.
- Errors are **typed values in the `E` channel**. Never `throw` across a module boundary; never
  `Effect.die` to express a domain failure. Genuinely unexpected failures (a broken invariant,
  a corrupted runtime state) remain untyped defects and are allowed to die.

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

A `Workspace` service `Context.Tag` replaces the ambient `AsyncLocalStorage` in
`src/context.ts`. The tag carries the workspace config object (the `Workspace` type in
`src/config.ts`).

Code that may legitimately run outside a request scope (startup, caches, anything a CLI
subcommand could reach) uses `Effect.serviceOption(Workspace)` and falls back to **exactly the
old behavior**: `undefined` workspace, empty env override. No tag lookup may fail where the old
ambient context returned `undefined`.

## Migration facades

A rewritten module **also exports Promise-based wrappers** over its new Effect API, each
implemented with `Effect.runPromise` and marked with a line comment containing exactly:

```
TODO-MIGRATE
```

A later server-wiring task sweeps them. Until then, existing callers must keep compiling
unchanged — the wrapper preserves the old signature (including throwing `Error`s where the old
code threw, and returning old-shaped results).

## Concurrency

- Hand-rolled queues and counters (e.g. the `slot()` gate in `src/sh.ts`) become
  `Effect.makeSemaphore` / `Effect.forEach` with an explicit concurrency.
- Timeouts are `Effect.timeout` with interruption, and whatever the effect spawned must be
  **killed on interruption** — a timed-out `git` that keeps running is a leak, not a timeout.

## Schemas

- Effect Schema (`effect/Schema`) parses: `change.json`, `config.json`, request bodies, and CLI
  `--json` output. Decode failures become `DecodeError`.
- Deliberate tolerance stays, but is **explicit**: a documented silent fallback becomes
  `Schema.decode(...)` piped through `Effect.orElseSucceed` (or the equivalent combinator) with
  a comment saying which README behavior it preserves. Never a bare `as` cast — that is what
  the tolerance rules exist to prevent.

## Post-review rulings (coordinator, after the audit)

- **Promise facades kept for the test suite** (readChange, swr, commitChange, ...) outlive the
  sweep deliberately: tests are Promise-shaped by contract and the rewrite was not sanctioned to
  touch them. Their doc comments say so; they carry no TODO-MIGRATE marker because nothing in
  `src/` is expected to migrate off them.
- **`src/context.ts` keeps the AsyncLocalStorage shim** for the same reason — it is the seam
  between the Effect world and the Promise-shaped test helpers, not migration debt.
- **A malformed `change.json` is skipped by the listing** (and surfaces as a typed error when the
  change is asked for by id). The old code failed the whole listing; the skip is deliberate.

## Verification (every task, before reporting done)

```sh
bun run typecheck && bun run lint && bun test
```

Green means: typecheck passes, lint passes, and `bun test` shows **only** the known
`test/webkit.test.ts` failure. Workers never run `git commit`; the coordinator commits.
