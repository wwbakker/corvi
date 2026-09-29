# Phase 1 — the pty and its shells survive the server

Throwaway spike. Everything is under `spike/restart/` and uses the Phase 0 host in
`spike/terminal-host/`. Nothing in `apps/` or `packages/` was touched. Raw output:
`spike/restart/evidence.txt`.

## Verdict

**The tmux property holds.** A server can be `SIGKILL`ed, the host and both shells stay alive, a
new server adopts the host, discovers the surviving sessions through `session.list`, re-associates
them with its own registry, and runs new commands in the *same* shells. An exited session is a
defined final state, not a hang; idle shutdown and host-`SIGKILL` recovery both behave.

`bash spike/restart/survive.sh` → **all 57 assertions passed**, no host process, temp dir or lock
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
4. **kill+reopen**: `session.kill` on `s4` produces a non-clean exit (signal set; observed
   `SIGHUP=1` here), the reopen gets a new incarnation, and no old-incarnation data or exit
   arrives after the reopen (`staleAfterReopen=0`).
5. **truncation**: after more than 256 KB of output, `attach` with `since: 0` reports
   `truncated: true` and an `oldestSeq > 0`.
6. **Exit while detached**: `exit` is typed into `s2` with no client attached. It is retained as
   `alive=false, exitCode=0, signal=0` (clean, unlike a kill); a later `attach` replays the
   snapshot and delivers the final `exit` event.
7. **Idle**: with the server gone but `s1`/`s2` alive, the host is still up after more than twice
   the idle period. Once no session is live, the host exits after the idle period.
8. **Host `SIGKILL`**: a normal shell dies with the host; a fresh server finds the dead
   records/socket (`adopted: false`) and starts a fresh host with no sessions. A child that
   ignores `SIGHUP` survives the host's death (and is reaped by the driver) — the honest limit.
9. **Nothing left behind**: no socket, token, pid, owner, lock, host process or orphan shell.

## Semantics chosen

### What the host owns vs what the server rebuilds

The host owns exactly the things that must outlive the server:

- the **pty and its shell**, whether or not a client is attached;
- the **session record** (`id`, `incarnation`, `cwd`, `createdAt`, pty `pid`, `alive`,
  `lastSeq`, `exitCode`, `signal`, `exitedAt`), discoverable with `session.list`;
- a bounded **256 KB byte replay buffer with offsets**, so `attach {since}` resumes without
  duplication;
- the **exit** of a session, and idle shutdown.

The server owns what the host deliberately does not: the **change/window registry** (which session
id means which change and window), labels, agent status, and the re-association after a restart.
On restart the server calls `session.list`, joins the host's ids with its persisted registry, and
re-attaches. This is the split the plan describes: the daemon knows sessions, the server knows the
product.

### Session-exit retention

A dead session is **retained**, not deleted: `alive=false`, `exitCode`, `signal`, `exitedAt`,
and its replay buffer stay. `attach` to it replays the buffer and then sends
`{type:"exit", id, incarnation, exitCode, signal}` after the `ok` reply, so the connecting client
gets a defined final state rather than a socket that never speaks. A **typed `exit`** is clean
(`exitCode=0`, `signal=0`); **`session.kill`** signals the pty and the record is retained like any
other exit, so a killed shell is distinguishable by its signal (observed `SIGHUP=1` here).
`session.write` and `session.resize` always answer `ok { applied }` (`applied:false` for a dead or
unknown id), and `session.attach` on an unknown id is an `error`, not a 5 s timeout. At most
**64 dead sessions** are retained, evicting the oldest `exitedAt` first (no time-based expiry).

### Incarnation

Every `open` of an id gets a fresh, monotonically increasing `incarnation`. Data, exit and attach
replies all carry it. Reopening a retained dead id retires the old session — its subscribers are
cleared and its late pty callbacks are dropped — so the old pty can never emit for the reused id;
the client keys its received-byte offsets on `(id, incarnation)`. The proof kills `s4`, reopens
it, and asserts `newInc > oldInc`, both markers ran, `newData`, and `staleAfterReopen=0`.

### Truncation

The 256 KB replay buffer is bounded. The `attach` reply carries `oldestSeq` (the buffer's first
offset) and `truncated` (true when the requested `since` precedes it), so a resuming client knows
it lost bytes instead of silently missing them. The proof floods 300 KB, attaches with `since: 0`,
and asserts `truncated:true` and `oldestSeq > 0`.

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
starts a fresh one. Shells die with the host **unless they ignore `SIGHUP` or were
`setsid`/`nohup`'d**: closing the pty master sends `SIGHUP` to the foreground group, and a child
that traps it keeps running with no host and no record. The proof spawns
`sh -c "trap '' HUP; sleep 300"`, `SIGKILL`s the host, and observes the child still alive; the
driver then reaps it. So "orphan cleanup" is only partly answered: a crash cannot reach such a
child, and nothing here adopts or reaps it.

## Review round 1

- **Exit signal carried**: `onExit` now keeps `signal`, and the exit event / `SessionInfo` expose
  it, so a killed shell (signal set) is distinguishable from a typed `exit` (`exitCode=0`,
  `signal=0`).
- **Incarnation**: per-id monotonic incarnation on data/exit/attach/list; reopening a retained
  dead id retires the old session so its late callbacks cannot emit for the reused id; the client
  keys received offsets on `(id, incarnation)`.
- **Truncation**: attach reports `oldestSeq`/`truncated`.
- **Defined answers**: unknown/missing `session.attach` is an `error`; write/resize answer
  `ok { applied }`.
- **Teardown/idle**: a socket `close` rejects all pending calls; an accepted connection cancels a
  pending idle shutdown (short grace re-check), closing the accept-vs-shutdown race.
- **Housekeeping**: dead sessions evict oldest `exitedAt` first; `PROTOCOL` has one module; the
  "reviewers" comment now describes the mechanism; phase B reads state from the attach reply.

## Deferred

- **Migration across an update / host kill is out of scope**: replacement kills shells. Carrying
  screen state across that is the Phase 3 question.
- **Screen state beyond a raw byte replay** (cursor, SGR, alternate screen, scrollback) is Phase 3;
  the 256 KB replay is enough to prove survival, not to restore a faithful screen.
- **Dead-session retention is capped by count only** (64, oldest `exitedAt` first) with no
  time-based expiry; a real implementation should age them out too.
- **HUP-ignoring / `setsid` orphans are not tracked.** Closing the pty master cannot reap a
  child that traps `SIGHUP`; the host has no supervision to adopt or kill it, and the proof reaps
  its own such child manually. This is the part of the plan's "orphan cleanup" item that is not
  answered.
- **Host-`SIGKILL` records are cleaned lazily** by the next client, not eagerly.
- **macOS manual pass** still needed (pty/socket/macOS semantics; the same notes as Phase 0).
- The idle default (0/off) is a spike choice; the real daemon should choose a production value.

## Files

| File | Purpose |
| --- | --- |
| `spike/restart/server.ts` | minimal server stand-in + registry, one phase per process |
| `spike/restart/survive.sh` | `set -euo pipefail` driver with 57 assertions |
| `spike/restart/evidence.txt` | raw run output |
| `spike/restart/RESULTS.md` | this file |
| `spike/terminal-host/host.ts` | `session.list`, exit retention (signal/exitCode), incarnation, truncation, idle shutdown |
| `spike/terminal-host/client.ts` | `list()`, attach final state + truncation, `(id, incarnation)` offsets, pending-call teardown, `idleMs` |
| `spike/terminal-host/protocol.ts` | the single `PROTOCOL` constant |

`bun run typecheck` and `bun run lint` pass.
