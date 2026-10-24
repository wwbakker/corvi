# Server-owned screen state

Status: accepted and implemented. Supersedes
[renderer-owned screen state](renderer-owned-screen.md).

## Why the pivot

The renderer-owned design made the page's snapshot cadence the only thing that captured screen
state, and that cadence has nothing to capture while a full-screen program keeps output flowing. A
continuously-updating TUI never went idle, the switch-time snapshot deferred on in-flight writes,
and the host's then-256 KiB ring held only the program's **incremental, cursor-addressed** bytes.
Returning to a busy window replayed those bytes onto a blank screen and drew the update block with
no base — the failure the user hit on a long-running pi subagent (only the "Working" panel and the
input box survived).

The alternative's cost was overstated by the spike's 50,000-row stress number. Measured
`@xterm/headless` 6.0.0: a cell is `Uint32Array(3 * cols)` = **12 bytes** (one word code point,
one packed foreground, one packed background/SGR flags). At Corvi's default **5,000**-row
scrollback that is ~7–15 MB per session plus ~0.5 KB a line; the ~200 MB figure was 350 columns ×
50,000 rows.

## The design

| Decision | Reason and boundary |
| --- | --- |
| A headless xterm per `(sessionId, incarnation)` owns the screen; the hub feeds it every host byte | The server is the one participant always there. A second emulator costs ~12 bytes a cell and makes a resume exact, with no cadence to tune and no page round trip. |
| The screen is created when the **host window opens**, and stays warm for the life of its session | A window with no page (a subagent, an action command) is fed from its startup, so a page arriving later gets a serialize-and-send rather than a rebuild from the ring tail. There is no timed release and no deferred first view. |
| The hub owns the single host attachment for the life of the screen, not only while a page is attached | The screen must be current when a page arrives; the ring's incremental bytes cannot rebuild the base. |
| A page receives a serialized snapshot and then the live bytes; it sends only input and `resize` | The page is a renderer. Server→page control is `snapshot` (the replay), `reset` (an empty screen), `exit` (the session is gone) and `detached` (another page took the one live client); binary frames are output. The page sends binary keystrokes and `{type:"resize"}`. The server owns the byte offset. |
| While the hub serializes, the bytes after its cutoff are **held**, then replayed in order | The snapshot is taken at a cutoff; the held bytes are fed to the screen and sent after the subscriber is registered, so none is lost or doubled. |
| One live client per hub, claimed **synchronously** | The guard and the claim are one step. A second attach racing the serialize window is queued (newest wins) and served after the in-flight serialize; only a disposed hub is refused, with `exit`. |
| The screen's applied high-water is **monotonic** | A ring byte that lands behind a seeded offset must not pull the offset back, or the regressed high-water would be persisted and the next resume would replay bytes already covered. |
| A host-ring gap is the only reason to **reprint** the screen | The reprint is issued after the snapshot and the held bytes, so it streams to the page. It is best-effort: a program that does not repaint on `SIGWINCH` leaves the seeded view torn until its next full paint. |

## Persistence

The store (`apps/server/src/terminals/server/snapshots.ts`) holds one record per `(sessionId,
incarnation)`: the serialized screen `data`, the host byte offset `highWater` it covers, and
`savedAt`. It is loaded on start, persisted atomically, capped at 1 MiB per screen and 16 MiB in
total.

- Every screen is persisted uniformly. The hub writes a **dirty** screen on a 5 s cadence —
  serializing a 5,000-row screen is ~18–20 ms and only changed screens are written — and
  synchronously in `flushScreens()`, which the shutdown handler calls before
  `closeAttachments()`. Several due screens are written in one store rewrite.
- `serialize()` trims the oldest scrollback to the cap and flags `truncated`; `""` means a
  genuinely empty screen only. An over-cap screen is never the empty sentinel: the page would read
  it as a blank `reset`, and `forgetSnapshot` would drop the deep screen the cap protects.
  Forgetting runs only for a genuinely empty screen; an oversized or failed serialize keeps the
  previous entry and waits for the next cadence rather than re-serializing on every sweep tick.
- On creation a screen **seeds** from the stored record (`screen.seed(data, highWater)`) and the
  host attaches from that offset, so one server's resume is exact.
- **Gap policy.** When the host's ring has already evicted past the stored offset there is a hole
  between it and the ring's oldest byte. The screen keeps its deep history and the ring's
  incremental bytes land on top, rather than rebuilding from the ring and forfeiting the history
  the store exists for. The cost: those bytes address a screen state from an older offset, so a TUI
  that never fully redraws can look scrambled until its next paint. The hedge is the best-effort
  gap reprint below. The alternative — drop the seed and reset to a clean ring tail — would avoid
  the torn state but lose the deep history; the measured reprint makes that worth revisiting, but
  it is not changed in this change.

## Lifecycle

- A screen is **warm for the life of its session**. Every host window attaches at open, whether or
  not a page is looking, and stays fed until the session exits. There is no `subagentId` split, no
  reprintable/persisted classification, no deferred first-view attach, and no timed unattended
  release. A subagent, an action command and an interactive shell all take the same path.
- A first view is a serialize-and-send of the warm screen. The page gets the snapshot immediately;
  a gap reprint, if one is needed, follows it.
- A session exit persists the screen and keeps it for a `keepOpen` window (the frozen-viewing
  feature); everything else is evicted. The windows layer prunes the store down to live + kept
  incarnations on its poll.
- The host's own idle timeout is disabled while the server holds its connection, so the host idles
  once the server exits.
- If the host connection dies while the server lives, the sweep persists the last screen, tells any
  attached page the session ended, and drops the hub unless a kept-open window still wants the
  frozen screen. This is a stopgap for host-death re-adoption, not a full reconnection design.

## The gap reprint

A host attach reports `truncated` when the resume offset is behind the ring's oldest byte. That sets
`needsReprint` on the hub. The serve path is always:

1. flush the pending bytes, take the cutoff and hold later bytes;
2. wait for the screen to apply the cutoff;
3. serialize, send the snapshot, register the subscriber and drain the hold;
4. only then issue the pty jiggle in the background.

The jiggle shrinks the pty by one column and grows it back to the latest desired grid, tracking the
headless screen. It never waits for the output to go quiet, and the snapshot never waits for the
jiggle. The shrink output is streamed too, so the page can briefly show the one-column-narrower
view; the final grow reprint at the desired grid is what it converges to. A resize during the
jiggle wins: the grow reads the latest desired grid, and the screen is matched to it afterwards.

The reprint runs once per gap. A second page attaching while it is in flight supersedes the first
normally and receives the ongoing reprint bytes; it does not start a second reprint. The reprint is
counted only when the jiggle actually completed, not when it was merely issued, and a straggler from
a reset attachment cannot bump the counters.

### What the reprint actually does

The old record claimed “pi re-emits its whole conversation (measured: 8.7 MB, ~5060 lines)” and used
that as the rationale for the removed first-view reprint design. The committed probe
(`bun scripts/probe-sigwinch.ts`) runs the real binaries in a private host under a temporary
HOME/XDG/state, with an allowlisted session environment and no user config, credentials or
sessions. It applies the exact gap jiggle, **120×40 → 119×40 → 120×40**, and measures the host byte
delta and serialized screen before/after:

- **pi 1.0.3 startup** (`--offline --no-session`): **0 host bytes**; screen unchanged at 2256
  serialized bytes, 40 rows.
- **pi 1.0.3 history** (`--offline --session <temp synthetic 200-message file>`): **0 host bytes**;
  screen unchanged at 4164 serialized bytes, 40 rows.
- **opencode 1.18.34 startup** (`--pure`): **0 host bytes**; screen unchanged at 6712 serialized
  bytes, 40 rows.
- An earlier ad-hoc variant once measured 29 host bytes on pi-history; it did not reproduce, so the
  committed script records 0. The **active-turn case is unmeasured**: an isolated instance needs a
  disposable model/provider, which was not available without touching user credentials or sessions.
  That is a follow-up.

So the reprint is **best-effort, not a repair guarantee**. A gap can leave a torn screen until the
program's next full paint. The 8.7 MB claim is not a current measurement and does not justify any
behavior in this design.

## Measurements

From `scripts/bench-screens.ts` with the synthetic continuously-painting TUI, unviewed screens, and
the trace/cadence shortened to 1 s so one run observes several passes. All numbers are server-only;
the host is not sampled (its pty processes are additional).

- Warm-screen estimate: **~6.5–7 MiB/screen** (the hub's cheap row/cell estimate).
- Server RSS measured-window growth while the loops fill scrollback: **~9.6 MiB/screen at 8
  screens**, **~9.0 MiB/screen at 16**; the 8-vs-16 marginal is **~8.3 MiB/screen**. This is
  measured-window growth, not per-open allocation.
- Host replay buffers add up to **N × 4 MiB** (32 MiB for 8, 64 MiB for 16) on top; pty process
  RSS is not included.
- First view of an unviewed warm screen, 8-screen run: wall **p50 ~23 ms / p95 ~26 ms**, server
  `served` time **p50 ~19 ms / p95 ~21 ms**, snapshot **~324 KB**. In the 16-screen run (n=16),
  wall was **p50 ~24 ms / p95 ~217 ms** — the ~217 ms is the worst sample, one sample of 16, not a
  stable percentile — while server `served` stayed **p50 ~21 ms / p95 ~27 ms** on the same
  ~324 KB snapshots. The wall worst sample did not appear in the server time.
- Cadence: serializing one dirty screen is **~18–20 ms**; at the production 5 s cadence that is
  about **0.2 stores/s/screen**. The benchmark's 1 s cadence is a worst-case observation, not the
  production rate.
- CPU is a worst case too: the synthetic TUI paints continuously and the cadence is shortened;
  the 8-screen run measured ~16%, the 16-screen run ~36%.

## Observability

`hubStats()` exposes hubs, attached screens, subscribers, serve/reprint/attach counters, persist
counters and timings, and a per-hub screen array with grid, buffer/scrollback rows, estimated bytes,
last serialized bytes and reprint-in-flight state. With `CORVI_TERMINAL_TRACE=1`, the sweep emits a
periodic per-hub line (default 5 s, `CORVI_TERMINAL_TRACE_MS` for tests) and attach/serve/reprint
timings; there is no HTTP endpoint for it.

## When to bound memory

There is no cap on warm screens in this change. The trigger metric is the trace's summed per-hub
`estBytes`: a follow-up should release the least-recently-viewed unattended screen after persisting
it when that sum exceeds **~256 MiB**. At the measured **~6.5–7 MiB/screen estimate** that is about
**36–40 screens**; the looser “~30 screens” figure is the ~9 MiB measured-RSS gloss, not the
estimate-based trigger. The fallback is lossy for a TUI that does not repaint on resume, so re-probe
an active agent turn before relying on it.

Memory is not the only cost. The shipped cadence is lockstep: every 5 s all due screens persist in
one 250 ms tick, each serialize costs ~18–20 ms (~0.6 s of event-loop block at ~30 screens), and
`setSnapshots` rewrites the whole store synchronously. The bench's `/api/workspaces` p95 was 7 ms at
8 screens and 61 ms at 16. A follow-up should also stagger persistence across ticks or use a longer
cadence for unviewed screens; that is an alternative to, not a replacement for, the memory cap.

## Load

- Host output is **coalesced per event-loop turn** into one `screen.write` and one WebSocket send,
  bounded by a per-turn byte cap; a single write per chunk would run the parser and the socket once
  per pty read.
- A page that falls far enough behind on its socket (a bounded `bufferedAmount`) is **re-synced**
  — closed so it reconnects to a fresh snapshot — rather than buffered without bound.
- The watcher's 1.5 s tick does host reads and registry reads only; the snapshot store is rewritten
  only when a screen is actually persisted, never just because the tick ran.

## Boundaries and caveats

- "Exact" resume is **screen-content exact**: the serialize addon restores the text and the modes
  it knows (bracketed paste among them), not every parser state, and the stored offset can fall
  mid-escape. A cursor a full-screen program hid is shown again (`\e[?25h`).
- A stored screen seeded into a differently sized window **reflows**.
- `savedAt` is not refreshed on liveness, so under the total-size cap a quiet live screen can be
  evicted before a churning one.
- The connection status (`starting terminal…`, `connecting…`, `reconnecting…`) is an absolute
  overlay, not a row in the layout: a hint that appears and disappears with the socket must not
  change the terminal grid between the connect and its snapshot.
- `apps/server/src/terminals/server/windows.ts` imports `session.ts` (for `ensureScreen`) and
  `session.ts` imports `windows.ts` (for `ensureActiveHostWindow`/`isKeptOpen`). The cycle is
  contained, but the pair is a candidate for the planned "extract the terminal plumbing into a
  package" refactor.
- The per-window token for the status/remote case, an OSC-status heartbeat/TTL, and folding the
  per-report session-list round trip onto the host push channel are separate later decisions; the
  screen store is not their home.

The screen lives in `apps/server/src/terminals/server/screen.ts`, the hub (attachment, coalescing,
gap reprint, cadence, shutdown flush, subscribers, host-loss reaper) in `.../session.ts`, the
persisted store in `.../snapshots.ts`, and window creation in `.../windows.ts`. The page's
`apps/web/src/terminals/client/TerminalPane.tsx` is the renderer.
