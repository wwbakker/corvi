# Phase 2 — the agent-status channel

Throwaway spike. Everything is under `spike/status/` and uses the Phase 0/1 host
(`spike/terminal-host/`). Nothing in `apps/` or `packages/` was edited — the consumer imports the
**real** presenter (`apps/server/src/terminals/server/presenter.ts`, which merges the real
`agentsWindowPresenter`) and the real notification-edge rule (copied from
`apps/server/src/capabilities/watch.ts`, which is 12 lines and has no entry point to import).
Raw run output: `spike/status/evidence.txt`.

`bash spike/status/run.sh` → **all 15 assertions passed**; no host, temp dir or lock left behind.

## The shape proven

### Identity first

The host seeds every pty with `CORVI_SESSION_ID=<id>` and `CORVI_SESSION_INCARNATION=<n>` at open
(a caller may pass extra `env`, but the host's identity wins). Proven, not assumed:
`spike/status/run.ts` opens a session whose command prints `$CORVI_SESSION_ID`, and a session
whose command runs the CLI — both see the host's value (`identity.hostSeedsEnv`,
`http.reporterInsidePtyUsesHostEnv`).

**Recommendation:** keep the env. It is free (the pty already carries an environment), needs no
lookup, and works exactly where the reporter runs. A **per-window token** would only be needed if
the session id must be unguessable (auth) or if the mapping must be revocable without restarting
the pty; neither is required by the current model. Note it as the extension point for the remote
case, not the default.

### Transport (a): corvi CLI / HTTP

A reporter shells out to a `corvi`-like CLI (`spike/status/corvi-status.ts`) that reads
`CORVI_SESSION_ID` from its environment and `POST`s `{sessionId, status, name, message}` to a stub
endpoint. The consumer reads the endpoint and merges it through the real presenter. The CLI writes
**nothing** to the pty (asserted: empty stdout), so the terminal is untouched.

Exercised end to end: two sessions report independently (`s1` pi working, `s2` opencode waiting);
`working → waiting` fires the notification edge exactly once and never again for a repeated
`waiting`; `clear` returns the window to a plain terminal; killing a session removes it from the
presented list; a plain shell with no status presents as a terminal.

### Transport (b): OSC

A reporter emits `ESC ] 1337 ; corvi = <base64 json> BEL` on its own pty, surrounded by
alternate-screen noise. The host parses it out of the pty stream, **strips it** before forwarding
(the client's received bytes contain none of it — `osc.stripped`), records it on the session
(`session.list[].status`), and clears it when the session exits. The same consumer, two-session,
edge, clear and plain-shell checks pass through this transport.

This required a small host addition, and the first cut had a real bug: a naive "hold the last 15
bytes" carry delayed the tail of every chunk. The parser now holds only a *genuine partial prefix*
of the introducer (`partialIntroLength`).

## What the numbers say

| Transport | report → observed (median) | max |
| --- | --- | --- |
| CLI + HTTP (spawn a fresh CLI per change) | **84.6 ms** | 96.1 ms |
| OSC (write on the pty, host parses) | **1.5 ms** | 1.9 ms |

The HTTP number is dominated by **spawning a Node CLI process** (~80 ms), not the HTTP round trip;
a reporter that posts directly, or a long-lived process, would be single-digit ms. Reported
through the CLI, the latency is well inside a human's perception of "instant" for a status change.
The OSC number is the shell writing and the host parsing on the same machine.

## Effort, typing, testability

- **Effort to change a reporter** (estimated, not wired): pi's reporter
  (`integrations/pi/src/agent-state.ts`) already funnels every change through one `publish(option,
  value)` function; replacing its tmux calls with one CLI/HTTP call per transition, keeping the
  `agent_start` / `agent_settled` / `session_start` / `session_shutdown` handlers, is a small,
  local edit. opencode's is the same shape. The spike proves the endpoint and the consumer, not
  the edit.
- **Typing/testability**: the HTTP payload is a small typed JSON object a schema can validate, and
  the stub is trivial to test. OSC is the same JSON in base64 behind a control sequence: the host
  parser is testable, but OSC is a shared terminal channel — any process in the pty can spoof it,
  and a malformed sequence is a display-corruption risk the HTTP path does not have.
- **How the reporter learns its id**: from the pty environment, seeded by the host. No lookup, no
  guessing from tmux.

## Robustness

- **The agent has no Corvi CLI / cannot reach an endpoint** (sandboxed or remote host): the CLI/HTTP
  path silently yields no status; the session still presents as a plain terminal — the fallback is
  proven, not assumed. To make HTTP work remotely, the agent needs the server URL and a token in
  its environment; the host already passes environment through, so this is config, not new
  machinery.
- **The server cannot call back to the agent**: irrelevant for both transports — the agent *pushes*.
  Nothing depends on the server initiating a connection to the pty.
- **OSC needs no tooling at all** (bytes on a stream), which is its one advantage, but it is only
  available where the pty is, and it is the unproven-at-the-TUI part below.

## Recommendation

**Adopt the CLI/HTTP channel as the replacement for `@agent_*`**, with `CORVI_SESSION_ID` (env)
as identity and a `corvi status` call (or a direct POST) carrying `{status, name, message}`.

Reasons, in order:

1. It is typed, validated and trivially testable; OSC is an untyped side channel shared with the
   terminal.
2. It pushes from the agent, so a remote or headless agent works without the server calling back.
3. It is a small, local change to each reporter's single publish function.
4. The spike proved the whole path end to end through the real presenter and the real
   notification edge.

OSC is a reasonable **fallback/complement** for an agent that cannot run a Corvi CLI and cannot
reach an endpoint, but it should not be the primary channel until it is proven inside a real
pi/opencode TUI (see below). A per-window token is deferred; the env is enough for now.

## Proven by this spike vs only by wiring the real extensions

Proven here (with the real presenter and edge rule, fake reporter and stub endpoint):

- the host seeds `CORVI_SESSION_ID`/`_INCARNATION` and a child inside the pty reads them;
- the CLI/HTTP transport: reporter → endpoint → merge → label/status/icon/note/busy/attention;
- the OSC transport: emit → host parse → strip → merge, with no OSC bytes on the display;
- two sessions independently; `working → waiting` notifying exactly once; clear on
  `clear` and on session end; a plain shell presenting as a terminal;
- report→observed latency for both transports; the terminal fallback when no status arrives.

**Not proven** (needs the real extensions, or a network/lifecycle fixture we did not build):

- that pi's or opencode's extension can **emit the OSC without corrupting its TUI** (no real
  extension was run; this is the single biggest unknown of transport b);
- that the real reporter edit is as small as estimated, and that its install/update path keeps the
  new endpoint address current;
- behavior when the agent is remote/sandboxed with no route to the endpoint (only the no-status
  fallback is proven);
- OSC authentication/anti-spoofing, and OSC parsing across every terminal feature (an OSC split
  across a chunk was handled here, but the real TUI emits far more control traffic);
- the `corvi status` CLI's real surface and whether it should reuse the server's existing socket
  rather than a new HTTP endpoint.

## Files

| File | Purpose |
| --- | --- |
| `spike/status/run.ts` | orchestration: stub endpoint, sessions, both transports, checks, latency |
| `spike/status/status.ts` | status record, raw-window adapter, real-presenter merge, attention edges |
| `spike/status/corvi-status.ts` | the CLI stand-in the reporter shells out to |
| `spike/status/osc-reporter.ts` | the OSC-emitting reporter stand-in |
| `spike/status/run.sh` | `set -euo pipefail` driver, 15 shell assertions, leftover check |
| `spike/status/evidence.txt` | raw run output |
| `spike/status/RESULTS.md` | this file |
| `spike/terminal-host/host.ts` | seeds pty identity, parses/strips OSC status, exposes it in `session.list` |
| `spike/terminal-host/client.ts` | `env` on open, `status` in `SessionInfo` |

`bun run typecheck` and `bun run lint` pass. `run-adoption.sh` (22) and `survive.sh` (57) still
pass after the host changes.
