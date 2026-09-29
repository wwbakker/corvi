# Phase 1 — the pty and its shells survive the server

Throwaway spike. Everything is under `spike/restart/` and uses the Phase 0 host in
`spike/terminal-host/`. Nothing in `apps/` or `packages/` was touched. Raw output:
`spike/restart/evidence.txt`.

## Verdict

**The tmux property holds.** A server can be `SIGKILL`ed, the host and both shells stay alive, a
new server adopts the host, discovers the surviving sessions through `session.list`, re-associates
them with its own registry, and runs new commands in the *same* shells. An exited session is a
defined final state, not a hang; idle shutdown and host-`SIGKILL` recovery both behave.

`bash spike/restart/survive.sh` → **all 33 assertions passed**, no host process, temp dir or lock
left behind, the user's own tmux untouched.

## What the scenario proves

`spike/restart/server.ts` is a minimal server stand-in whose only durable state is a registry file
(`sessionId -> {change, window}`). Each phase is a separate OS process, so "the server died" is a
real process death and the only thing holding the shells is the host.
`spike/restart/survive.sh` drives and asserts:

1. **A starts the host**, opens `s1` (change C1 / window W1) and `s2` (C2 / W2), runs markers in
   both, writes the registry, then is `SIGKILL`ed.
2. **The host pid and both shells are alive** after A is gone (from `session.list` shell pids).
3. **B adopts** (`adopted: true`, same host pid), calls `session.list`, matches it against the
   registry, attaches to `s1`/`s2`, and runs new markers in each. The replay contains A's earlier
   markers, proving the same shells.
4. **Exit while detached**: `exit` is typed into `s2` with no client attached. The session is
   retained as `alive=false, exitCode=0`; a later `attach` replays the snapshot and delivers the
   final `exit` event (reported `attachAlive=false`, `attachExitCode=0`, `exitEvent=0`).
5. **Idle**: with the server gone but `s1`/`s2` alive, the host is still up after more than twice
   the idle period. Once no session is live, the host exits after the idle period.
6. **Host `SIGKILL`**: the shell dies with the host; a fresh server finds the dead records/socket
   (`adopted: false`), starts a fresh host with no sessions, and shuts it down.
7. **Nothing left behind**: no socket, token, pid, owner, lock, host process or temp dir.

## Semantics chosen

### What the host owns vs what the server rebuilds

The host owns exactly the things that must outlive the server:

- the **pty and its shell**, whether or not a client is attached;
- the **session record** (`id`, `cwd`, `createdAt`, pty `pid`, `alive`, `lastSeq`, `exitCode`),
  discoverable with `session.list`;
- a bounded **256 KB byte replay buffer with offsets**, so `attach {since}` resumes without
  duplication;
- the **exit** of a session, and idle shutdown.

The server owns what the host deliberately does not: the **change/window registry** (which session
id means which change and window), labels, agent status, and the re-association after a restart.
On restart the server calls `session.list`, joins the host's ids with its persisted registry, and
re-attaches. This is the split the plan describes: the daemon knows sessions, the server knows the
product.

### Session-exit retention

A dead session is **retained**, not deleted: `alive=false`, `exitCode`, `exitedAt`, and its
replay buffer stay. `attach` to it replays the buffer and then sends `{type:"exit", id, exitCode}`
after the `ok` reply, so the connecting client gets a defined final state rather than a socket
that never speaks. `session.write`/`resize` to a dead session are no-ops; `session.kill` deletes
the record. At most **64 dead sessions** are retained; older ones are evicted. (A fuller version
would bound by age and/or bytes per session and expose why a record was dropped.)

### Idle rule

The host takes `--idle-ms N` (0, the default, disables it). It shuts down when, for `N` ms
continuously, there are **no client connections and no live sessions**. Any connection, request
or live session resets the clock, so an unattended terminal is never killed. The test runs with
`--idle-ms 800` to keep the proof fast; production should pick a real value (and the default is
currently "off" so a host is never surprised). A dead-but-retained session does **not** keep the
host up.

### Host `SIGKILL`

A killed host leaves its socket and records behind (the kernel does not unlink them, and there is
no clean-up handler for `SIGKILL`). The next `ensureHost` attempts to connect, fails, checks
`/proc/<pid>/cmdline` (Phase 0's `verifiedHostPid`), finds no live host, removes the records and
starts a fresh one. The shells die with the host, which is the correct trade for a crash.

## Deferred

- **Migration across an update / host kill is out of scope**: replacement kills shells. Carrying
  screen state across that is the Phase 3 question.
- **Screen state beyond a raw byte replay** (cursor, SGR, alternate screen, scrollback) is Phase 3;
  the 256 KB replay is enough to prove survival, not to restore a faithful screen.
- **Dead-session retention is capped by count only** (64) and never expires by time; a real
  implementation should age them out.
- **Host-`SIGKILL` records are cleaned lazily** by the next client, not eagerly.
- **macOS manual pass** still needed (pty/socket/macOS semantics; the same notes as Phase 0).
- The idle default (0/off) is a spike choice; the real daemon should choose a production value.

## Files

| File | Purpose |
| --- | --- |
| `spike/restart/server.ts` | minimal server stand-in + registry, one phase per process |
| `spike/restart/survive.sh` | `set -euo pipefail` driver with 33 assertions |
| `spike/restart/evidence.txt` | raw run output |
| `spike/restart/RESULTS.md` | this file |
| `spike/terminal-host/host.ts` | added `session.list`, exit retention, idle shutdown, session metadata |
| `spike/terminal-host/client.ts` | added `list()`, `attach` final-state reply, `idleMs` pass-through |

`bun run typecheck` and `bun run lint` pass.
