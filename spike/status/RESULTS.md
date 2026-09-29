# Phase 2 — the agent-status channel

Throwaway spike. Everything is under `spike/status/` and uses the Phase 0/1 host
(`spike/terminal-host/`). Nothing in `apps/` or `packages/` was edited — the consumer imports the
**real** presenter (`apps/server/src/terminals/server/presenter.ts`, which merges the real
`agentsWindowPresenter`) and the real notification-edge rule (copied from
`apps/server/src/capabilities/watch.ts`, which has no entry point to import). Raw run output:
`spike/status/evidence.txt`.

`bash spike/status/run.sh` → **25 shell assertions passed** and **8 OSC-parser unit tests pass**;
no host, temp dir or lock left behind. `survive.sh` (57) and `run-adoption.sh` (22) still pass.

## The recommendation

**Adopt the CLI/HTTP channel as the replacement for `@agent_*`**, with `CORVI_SESSION_ID` +
`CORVI_SESSION_INCARNATION` (env) as identity and a `corvi status` call (or a direct POST) carrying
`{status, name, sessionName, message}`. Keep the env identity; defer a per-window token to the
remote/auth case. Treat OSC as a fallback/complement, not the primary channel.

Reasons: typed/validated/testable; the agent pushes, so the server need not call back; a small,
local change to each reporter's single publish function; and the whole path is proven through the
real presenter and edge rule.

## Identity

The host seeds every pty with `CORVI_SESSION_ID=<id>` and `CORVI_SESSION_INCARNATION=<n>` at open;
a caller's `env` is applied first and the host's identity wins over it (asserted:
`identity.hostSeedsEnv`, `identity.hostWinsOverCallerEnv`). A reporter inside the pty reads its own
id and incarnation (`http.reporterInsidePtyUsesHostEnv`). The reporter never has to guess from tmux.

## Transport (a): corvi CLI / HTTP — the recommended channel

A reporter shells out to a `corvi`-like CLI (`spike/status/corvi-status.ts`) that reads
`CORVI_SESSION_ID` and `CORVI_SESSION_INCARNATION` from its environment and `POST`s to a stub
endpoint. The CLI writes **nothing** to the pty: asserted from *inside* the pty, where the reporter
runs the CLI and prints the captured byte count (`http.cliWritesNothingToPty` → `CLI_BYTES=0`).

The store is keyed by `(sessionId, incarnation)`:

- **kill a session that reported** → its status is reaped on the next read and it is not presented
  (`http.statusGoneOnKill`);
- **reopen the same id** (new incarnation) → no previous incarnation's status is presented
  (`http.reopenNoStale`);
- an **explicit `clear`** returns the window to a terminal (`http.explicitClear`);
- a **plain shell** with no status presents as a terminal (`http.plainShellIsTerminal`).

Earlier "clear on session end" was only proven for OSC; the HTTP lifecycle is now proven for real
above, which matters because HTTP is the recommendation.

## Transport (b): OSC

A reporter emits `ESC ] 1337 ; corvi = <base64 json> BEL` on its own pty, surrounded by
alternate-screen noise. The host parses it out, **strips it** before forwarding (`osc.stripped`),
records it on the session (`session.list[].status`), and clears it on exit
(`osc.clearedOnSessionEnd`). A held partial introducer is **flushed on exit** rather than swallowed
(`osc.carryFlushedOnExit`).

The parser is now a separate, unit-tested module (`spike/terminal-host/osc.ts`, 8 tests):

- a split introducer and a split payload are held and completed;
- a malformed introducer followed by a **valid sequence** still yields the valid status;
- a non-base64 introducer (e.g. ordinary output) resyncs and forwards the text;
- an **oversized unterminated** introducer forwards the rest instead of swallowing the chunk, and
  still lets a later valid sequence through.

## Payload schema and validation

Both transports carry the same small object and validate it at the boundary:

```
{ status: "working" | "waiting" | "clear",
  name?: string,          // the agent ("pi", "opencode")      cap 120
  sessionName?: string,   // the session's name, the label     cap 120
  message?: string        // the last answer, the note         cap 400
  incarnation: number }   // HTTP only; OSC gets it from the session
```

An unknown `status`, a non-string field, or a non-integer incarnation is rejected (HTTP `400`, OSC
dropped); strings are truncated to the caps. `sessionName` feeds `@agent_session_name`, so the label
path through the real presenter is exercised (`http.labelFromSessionName`,
`osc.labelFromSessionName`).

### Trust model (both channels)

The status is **untrusted data from inside the pty**. Any process running in the pty can report for
its session — and, exactly as with tmux pane options, can read `CORVI_SESSION_ID` from its own
environment (or another process's `/proc/<pid>/environ`) and impersonate it. The HTTP and OSC
channels are equal here; neither is authenticated. A per-window token would be the extension point
for the remote/multi-user case, and is deferred.

## The notification edge

`attentionEdges` keys by **`${change}:${windowId}`**, as `watch.ts` does, and the notify payload
carries `change`, `window`, `label`, `note?` and `sound`. Asserted: `working → waiting` fires
exactly once and not again for a repeated `waiting` (`notifyExactlyOnce`); two windows of one change
both notify, keyed apart (`twoWindowsOneChange`); and the same window id in two changes is two
edges, not one (`crossChangeKeying`).

## Latency

| Transport | report → observed (median) | max |
| --- | --- | --- |
| CLI + HTTP (fresh CLI process per change) | **83.8 ms** | 95.7 ms |
| **direct POST** (no process spawn) | **1.6 ms** | 10.6 ms |
| OSC (write on the pty, host parses) | **1.5 ms** | 3.2 ms |

The CLI number is dominated by **spawning a Node process** (~82 ms), not HTTP. A reporter that
posts directly — or a long-lived `corvi` process — is single-digit ms, as the direct-POST figure
shows. The earlier report quoted "single-digit ms" without that measurement; both figures are now
recorded.

## Effort, typing, testability

- **Effort to change a reporter** (estimated, not wired): pi's reporter
  (`integrations/pi/src/agent-state.ts`) funnels every change through one `publish(option, value)`
  function; replacing the tmux calls with one CLI/HTTP call per transition, keeping the event
  handlers, is a small local edit. opencode's is the same shape. The spike proves the endpoint and
  consumer, not the edit.
- **Typing/testability**: the HTTP payload is a small schema-validatable object with a trivial stub.
  OSC is the same JSON behind a control sequence: the parser is unit-tested, but OSC is a shared
  terminal channel any process can spoof, and a malformed sequence is a display risk HTTP does not
  have.
- **How the reporter learns its id**: from the pty environment.

## Robustness

- **No CLI / no route to the endpoint** (sandboxed or remote): the CLI/HTTP path silently yields no
  status; the session still presents as a plain terminal (proven fallback).
- **The server cannot call back to the agent**: irrelevant — the agent pushes.
- **Remote reachability** (agent on another host, or a server it cannot reach): not built. The env
  can carry the endpoint URL and a token; that is config plus auth, deferred.
- **OSC needs no tooling at all**, but only works where the pty is, and is the unproven-at-the-TUI
  part below.

## Deliberate follow-ups (not built)

- **Heartbeat / staleness expiry.** A reporter that crashes mid-turn (or a `working` that outlives
  its turn) leaves `working` stuck forever: there is no heartbeat and no TTL, and the session record
  only clears on exit or an explicit `clear`. This is the main known gap; a heartbeat or a
  last-seen timestamp with expiry is the next step.
- **Per-window token / auth**, for the remote/multi-user case and to stop in-pty spoofing.
- **Remote reachability** of the endpoint from a sandboxed or other-host agent.

## Proven by this spike vs only by wiring the real extensions

Proven (real presenter and edge rule, fake reporter and stub endpoint): host-seeded identity
(incl. host winning over caller env); the CLI/HTTP transport with an `(id, incarnation)`-keyed
store and real kill/reopen lifecycle; the OSC transport with strip, parser recovery, and carry
flush; two sessions; two windows one change; cross-change keying; the edge exactly once; clear;
plain-shell fallback; both latencies; `sessionName` as the label.

**Not proven** (needs the real extensions or a network/lifecycle fixture):

- that pi's or opencode's extension can **emit the OSC without corrupting its TUI** (no real
  extension was run — transport b's biggest unknown);
- that the real reporter edit is as small as estimated, and that its install/update path keeps the
  endpoint address current;
- remote/sandboxed agents with no route to the endpoint (only the no-status fallback is proven);
- OSC auth/anti-spoofing against a hostile process in the same pty;
- the real `corvi status` CLI surface (reuse the server's socket vs a new HTTP endpoint).

## Files

| File | Purpose |
| --- | --- |
| `spike/status/run.ts` | orchestration: stub endpoint, sessions, both transports, checks, latency |
| `spike/status/status.ts` | status record, raw-window adapter, real-presenter merge, `change:window` edges |
| `spike/status/corvi-status.ts` | CLI stand-in (id + incarnation from env, `--session-name`) |
| `spike/status/osc-reporter.ts` | OSC-emitting reporter stand-in |
| `spike/status/run.sh` | `set -euo pipefail`, parser tests, 25 assertions, leftover check |
| `spike/status/evidence.txt` | raw run output |
| `spike/status/RESULTS.md` | this file |
| `spike/terminal-host/osc.ts` | the OSC parser (resync + validation), unit-tested |
| `spike/terminal-host/osc.test.ts` | 8 parser tests (`node --test`) |
| `spike/terminal-host/host.ts` | seeds identity, parses/strips OSC (flush carry on exit), status in `session.list` |
| `spike/terminal-host/client.ts` | `env` on open, `status` (incl. `sessionName`) in `SessionInfo` |

`bun run typecheck` and `bun run lint` pass.
