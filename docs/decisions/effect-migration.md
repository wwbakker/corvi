# Decision: the Effect rewrite

> **Kind:** decision · **Status:** accepted · **Supersedes:** —

The migration that rewrote server-side `src/` to Effect. The standing rules it produced live in
[`../guides/effect-conventions.md`](../guides/effect-conventions.md); this file records what was
decided and what it deliberately left alone.

## Goal: behaviour-preserving

This was a rewrite, not a redesign. None of the following changed:

- HTTP routes and their response shapes and status codes.
- SSE event semantics.
- Config fallback semantics (the silent fallbacks the README documents are kept, but made
  explicit in code — see the Schemas section of the guide).
- The bun test suite. **Tests pass unmodified except import paths.**

## Scope

The rewrite covered server-side `src/` only. Excluded deliberately:

- `src/terminalProxy.ts` — the WebSocket bridge stays as-is; it is proxy plumbing, not logic.
- `src/web/**` — the React UI never sees Effect.
- `src/origin.ts` — the sync guard stays as-is.
- `src/platform.ts` — platform detection stays as-is.
- Purely synchronous code (pure string logic, pure data shaping) — no effect wrapper buys
  anything there.

## Known baseline

`bun test` has exactly one failing test, `test/webkit.test.ts`, which fails because Playwright
WebKit cannot launch on this machine (environmental, pre-existing). Success for any task was
*that same single failure and nothing new*.

## Migration facades

A rewritten module **also exported Promise-based wrappers** over its new Effect API, each
implemented with `Effect.runPromise`, so existing callers kept compiling until the
server-wiring task swept them. This is the one part of the decision later work revisits: the
facades outlived the sweep, and a follow-up may retire them and the ambient shim they keep
alive. See item 2 of [`../plans/refactor-plan.md`](../plans/refactor-plan.md).

**Superseded (item 2 of the refactor plan): the facades and the shim are gone.** Every facade
below (`readChange`, `swr`, `commitChange`, `provision`, `sh`, ...) proved to be test-only, so
the tests now run the Effect API through `test/helpers.ts`'s `runEffect`/`runEffectWith`/`runSh`,
which provides the `Workspace` tag, and `src/context.ts` was deleted. `shEffect` computes the
subprocess environment straight from the tag (`Effect.serviceOption(Workspace)` → `envOf`). The
ruling below is kept as written; it no longer holds.

## Post-review rulings (coordinator, after the audit)

- **Promise facades kept for the test suite** (readChange, swr, commitChange, ...) outlive the
  sweep deliberately: tests are Promise-shaped by contract and the rewrite was not sanctioned to
  touch them. Their doc comments say so; they carry no `TODO-MIGRATE` marker because nothing in
  `src/` is expected to migrate off them.
- **`src/context.ts` keeps the AsyncLocalStorage shim** for the same reason — it is the seam
  between the Effect world and the Promise-shaped test helpers, not migration debt.
- **A malformed `change.json` is skipped by the listing** (and surfaces as a typed error when the
  change is asked for by id). The old code failed the whole listing; the skip is deliberate.
- **Superseded (item 2):** the facades and the ALS shim were retired once the tests were ported
  to the Effect API through `test/helpers.ts`. The rulings above record the migration as it was;
  the standing contract is [`../guides/effect-conventions.md`](../guides/effect-conventions.md),
  and the retired facades live only in this history.
