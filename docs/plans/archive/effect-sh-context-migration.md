# Migration report: src/sh.ts and src/context.ts → Effect

> **Kind:** plan · **Status:** implemented

## Files changed

- `src/sh.ts` — rewritten on Effect (`Effect.gen`/`yield*`), Promise facades kept.
- `src/context.ts` — workspace Effect reads added; AsyncLocalStorage kept as the Promise-era bridge.

## New Effect APIs (src/sh.ts)

- `shEffect(cmd, cwd?): Effect<Result, CliError>` — `Result` is the existing
  `{ code, stdout, stderr }`. Non-zero exit codes remain a **successful** Result; a spawn-level
  failure (missing tool / missing cwd) still returns a successful Result with `code: 127` and
  `stderr = message`, exactly as before. The `E` channel only ever carries a timeout `CliError`
  (see below).
- `shOrThrowEffect(cmd, cwd?): Effect<string, CliError>` — fails with `CliError` whose `message`
  is byte-identical to the old throw: `` `${cmd.join(" ")} failed: ${r.stderr || r.stdout}` ``
  (`Data.TaggedError` leaves `message` empty, so it is set explicitly; taxonomy rule: carry the
  old human-readable string).
- Concurrency: the hand-rolled `slot()` counter/queue is gone. One module-level
  `Effect.makeSemaphore(Number(process.env.IWE_PARALLEL ?? 8))`, used as
  `gate.withPermits(1)(...)` — release is guaranteed on failure and on interruption.
- Trace: module `Map` preserved and mutated inside the effect, same `traceKey` grouping, same
  `Bun.nanoseconds()` timing and `resourceUsage` cpu/wall accumulation, gated on `IWE_TRACE`.
  `stripAnsi` unchanged. Verified byte-comparable via the existing tests and a live run.

## Sanctioned behavior change: timeouts

`shEffect` wraps the spawn in `Effect.timeout`:

- default **120 seconds**, override with `IWE_CLI_TIMEOUT` (seconds, `0` disables entirely);
- on timeout (or any interruption, e.g. shutdown) the child is killed via `proc.kill()` — the
  `Effect.onInterrupt` hook sits on the read effect itself, the effect the interruption actually
  lands on (verified live: `sleep` is gone after both timeout and manual interrupt);
- the effect fails with `CliError { tool, command, exitCode: 124, stderr = message }` where
  `message = `${cmd.join(" ")} timed out after ${seconds} seconds``.

Today a hung CLI hangs the server forever; that is the one sanctioned change, noted per task
instructions.

## Promise facades (marked TODO-MIGRATE)

- `sh(cmd, cwd?)` — same signature, never rejects (callers branch on `code`). The timeout
  `CliError` is converted *inside* the Effect (via `Effect.catchAll`, since `Effect.runPromise`
  rejects a typed failure as a bare Error and would lose the fields) into
  `{ code: 124, stdout: "", stderr: timeout message }`.
- `shOrThrow(cmd, cwd?)` — unchanged: throws `new Error(\`${cmd.join(" ")} failed: ...\`)`,
  which now also covers a timeout (exit 124).
- `trace` — unchanged export (the Map). `json` — untouched, still generic and tolerant.

## src/context.ts

- The workspace now lives in the `Workspace` tag (`src/effect/tags.ts`, already present).
- New Effect reads: `currentWorkspaceEffect` and `currentEnvEffect`. They read
  `Effect.serviceOption(Workspace)` and, when no service was provided, fall back to the ambient
  `AsyncLocalStorage` — so `withWorkspace`-scoped Promise-era callers and service-provided
  Effect routes both work, and outside any scope the result is exactly the old behavior
  (`undefined` workspace, empty env override, `~` expansion preserved).
- Sync exports `withWorkspace`, `currentWorkspace`, `currentEnv` kept with their exact
  signatures (marked TODO-MIGRATE); `test/cache.test.ts` (which calls `currentEnv()`,
  `withWorkspace`, and Promise `sh` under ALS) passes unmodified.

## Verification

`bun run typecheck` ✓, `bun run lint` ✓, `bun test` → 108 pass, 1 fail, and the 1 fail is the
known baseline `test/webkit.test.ts` (Playwright WebKit cannot launch on this machine). Nothing
new. Note: the worktree is shared and other workers were editing `src/config.ts`,
`src/changes.ts`, `src/settings.ts`, `src/schemas/` concurrently; their in-flight states
transiently broke typecheck mid-run, but the final verification above ran clean with everyone's
landed state. No git commits made.
