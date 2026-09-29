# Phase 0 — the terminal host runs, is adoptable, and survives an update

Throwaway spike. Everything lives under `spike/`; nothing in `apps/` or `packages/` was changed.
Raw evidence (commands and outputs) is in `spike/terminal-host/evidence.txt` and
`spike/baseline/results.json`.

## Verdict

**The spike passes.** A standalone process can own `node-pty` under both runtimes Corvi ships
(system Node and Electron's Node), a new client can adopt a running host after the old client
exits, and a host whose ownership disagrees with the current checkout is replaced instead of
silently adopted. Bun remains unusable for an interactive terminal, but not in the exact shape
the plan assumed (see below).

## Environment

| | |
| --- | --- |
| Machine | Linux omarchy 7.2.5-3-omarchy, x86_64 |
| System Node | v26.8.1 (the dev-server runtime; `engines: >=24`) |
| Electron | 44.3.0, bundled Node **24.20.0** (`ELECTRON_RUN_AS_NODE=1`) |
| Bun | 1.4.2 |
| node-pty | **1.2.0-beta.15** (the version in `apps/server/package.json`) |
| node-pty build | **prebuild** (`prebuilds/linux-x64/pty.node`); **no node-gyp build** |
| tmux (baseline only) | 3.7c |

`node-pty` ships N-API prebuilds in the package (`napi_*` symbols; Electron reports `napi: 10`),
so the same `pty.node` loads in Node and Electron with no rebuild. The install script's
`node scripts/prebuild.js || node-gyp rebuild` takes the prebuild branch.

## Runtime matrix

Run with `spike/terminal-host/probe.ts` (loads node-pty, spawns `/bin/sh`, reports raw JSON).
Full output: `evidence.txt`. Times are wall-clock from spawn to the marker.

| Runtime | `exec` (output at spawn) | `interactive` (output after input) | `delayed` (later output) |
| --- | --- | --- | --- |
| Node 26.8.1 | delivered, 3.36 ms, spawn 2.26 ms | delivered at 503.8 ms | delivered |
| Electron 44.3.0 (Node 24.20.0) | delivered, 4.78 ms, spawn 3.48 ms | delivered at 504.4 ms | delivered |
| Bun 1.4.2 | delivered, 3.45 ms, spawn 2.40 ms | **missing** (saw only the 16-byte prompt) | **missing** (0 bytes) |

Node and Electron pass. **Bun's real behaviour is subtler than "never delivers output":** it
delivers whatever the pty produced synchronously at spawn (the shell prompt, or an `echo` in a
`-c` one-liner), then stops pumping the poll handle. Any output produced *later* — which is
everything a user types — never arrives. The practical conclusion is unchanged: the server must
run the terminal on Node, exactly as `apps/server/src/terminals/server/session.ts` already
guards. The plan's wording should be tightened when this lands in a decision record.

## The host and the protocol

`spike/terminal-host/host.ts` listens on a Unix socket and speaks newline-delimited JSON. It
writes three records beside the socket, all mode 0600:

- `<socket>.token` — bearer token for the handshake
- `<socket>.pid` — the host pid
- `<socket>.owner.json` — pid, checkout path, build id, protocol, runtime versions

Requests: `hello`, `host.info`, `host.shutdown`, `session.open`, `session.attach`,
`session.detach`, `session.write` (base64), `session.resize`, `session.kill`. Events: `welcome`,
`ok`, `error`, `data` (base64), `exit`. Sessions are keyed by id; each keeps its pty and a bounded
256 KB replay buffer whether or not a client is attached, so detaching never kills the shell and
re-attaching replays what it missed. `spike/terminal-host/client.ts` exposes
`ensureHost()` (spawn-or-adopt) plus `open/attach/write/resize/kill/detach`.

## What "adopt" required

1. A **fixed socket path** the next client can find (the client owns the path; the host only binds
   it).
2. A **token persisted at 0600** so a fresh process of the same user can handshake without
   restarting the host.
3. **Ownership metadata** (`checkout`, `buildId`) written by the host and compared by the client.
   This is what makes adoption safe rather than blind.
4. A host **not tied to the client's lifetime**: `ensureHost` spawns it `detached` and `unref`s
   it; `HostClient.close()` only drops the connection. The client must never kill the host on
   exit.

Adoption proof (`spike/terminal-host/run-adoption.sh`, raw output in `evidence.txt`) runs each
phase as a **separate OS process**, so "client exit" is a real exit:

- `open` (build `v1`): started host pid 117004, `ensureMs` 117.69 ms (includes host start),
  opened a shell and saw `FIRST`; the process then exited. `kill -0 117004` → alive.
- `adopt` (build `v1`, new process): `adopted: true`, `ensureMs` **12.79 ms**, same pid 117004,
  and re-attached to the *same shell* — the replay buffer showed `FIRST` and the new `SECOND` ran
  in it.
- `stale` (build `v2`, simulates an update): `adopted: false`, `ensureMs` 122.04 ms, old pid
  117004 **dead**, new host pid 117062 with build `v2`, `THIRD` ran in a fresh shell.

## Update / stale-host case

The client compares `owner.checkout` and `owner.buildId` with its own. On mismatch (or a dead
socket / failed handshake) it calls `host.shutdown` over the socket, then falls back to SIGTERM
(and SIGKILL after ~1 s) using the recorded pid, unlinks the records, and starts a fresh host. The
proof confirms the old host is gone and the new one answers with the new build id; because the
session map lived only in the old process, the old shell is gone too.

This is replacement, **not** migration — an update kills running shells. That is acceptable for
Phase 0 (Orca does the same); handing terminals across an update is a later decision if it is
wanted at all.

## Baseline (for Phase 6)

`spike/baseline/baseline.ts`, run on system Node, all paths under one `mktemp` dir with a private
tmux socket (`tmux -S <tmp>/tmux.sock`, `$TMUX` deleted, never `-L corvi`). The real server is
started with isolated `CORVI_ROOT` / `CORVI_CONFIG` / `CORVI_CACHE` / `XDG_STATE_HOME`. Method and
numbers (`spike/baseline/results.json`):

- **Part A — data plane** (`node-pty` spawning the product's `tmux -S … new-session -A … attach`):
  - input round-trip (`echo RTT_$(( n + 0 ))_END`; the marker is only emitted by the command, not
    the echoed input), 30 samples: min 2.3 ms, **median 13.41 ms**, max 20.14 ms.
  - output flood, 8,000,000 bytes of `x` through the pty: 264.1 ms, **30.3 MB/s**, completed.
- **Part B — the real server** (`node apps/server/src/server.ts`, one change, one terminal over
  the page's WebSocket endpoint):
  - server RSS idle **164.3 MB**, with one terminal **165.5 MB** (VmRSS from `/proc`).
  - WebSocket input round-trip, 20 samples: min 9.05 ms, **median 12.44 ms**, max 20.02 ms.

Honest caveats: one machine, one run each; round-trip medians include shell scheduling, so they
are an order-of-magnitude baseline, not a benchmark. The flood number is end-to-end pty throughput
including tmux's redraw. `bun run build:web` must have been run first — the server **exits** if
`apps/web/dist/index.html` is missing.

## Safety and cleanup

- Never touched the user's tmux: every call names a private `-S` socket under the run's temp dir
  and `$TMUX` is deleted. `tmux ls` after the runs still showed the user's own sessions/
  untouched.
- Hosts are shut down (`host.shutdown`, then signal fallback); `pgrep` after the runs found no
  `host.ts` and no `/tmp/corvi-spike-*` dirs remained.
- macOS was not run here. A manual pass is needed for: the `darwin-*/pty.node` + `spawn-helper`
  prebuilds (exec bit on `spawn-helper`), Unix-socket path length (~104 chars) under macOS temp
  dirs, and Electron's bundle-path resolution (`apps/desktop/src/electron/binary.ts` already
  resolves `Electron.app/Contents/MacOS/Electron`).

## Surprises / unresolved

- **Bun**: see the matrix. The repo's guard is still correct, but the comment "never delivers a
  byte of its output" is not literally true on Bun 1.4.2 / node-pty 1.2.0-beta.15 — it delivers
  the first burst and then stalls.
- **Electron needs no native rebuild**: the N-API prebuild loads unchanged under Electron 44,
  so the pty host can run on Electron's Node with no per-runtime artifact.
- **The replay buffer is what makes adoption demonstrable without a headless terminal.** A bounded
  256 KB byte buffer plus the live stream was enough to prove the same shell survived; whether the
  host or the renderer should own richer screen state is Phase 3.
- **Ordering/race**: the client polls for `<socket>.token` and the socket before connecting. The
  host writes its records before `listen`, and chmods the socket after, so a client can briefly
  see the socket before its mode is 0600. For Phase 0 this is fine (same user, private dir); a
  production host should create the socket with `umask`/before-listen chmod.
- Replace-on-update currently kills shells. Migrating them is deliberately out of scope.

## Files

| File | Purpose |
| --- | --- |
| `spike/terminal-host/host.ts` | the standalone pty-owning daemon |
| `spike/terminal-host/client.ts` | `ensureHost` (spawn-or-adopt) and the connection |
| `spike/terminal-host/pty.ts` | loads node-pty by absolute path + local types |
| `spike/terminal-host/probe.ts` | runtime matrix probe (`exec`/`interactive`/`delayed`) |
| `spike/terminal-host/prove.ts` | one adoption/stale phase per process |
| `spike/terminal-host/run-adoption.sh` | drives the open → adopt → stale proof |
| `spike/terminal-host/record-evidence.sh` | regenerates `evidence.txt` |
| `spike/terminal-host/evidence.txt` | raw Phase 0 evidence |
| `spike/terminal-host/RESULTS.md` | this file |
| `spike/baseline/baseline.ts` | the Phase 6 baseline |
| `spike/baseline/results.json` | raw baseline numbers |

`bun run typecheck` and `bun run lint` pass with these additions.
