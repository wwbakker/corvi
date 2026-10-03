# Server-owned screen state

Status: accepted and implemented. Supersedes
[renderer-owned screen state](renderer-owned-screen.md).

## Why the pivot

The renderer-owned design made the page's snapshot cadence the only thing that captured screen
state, and that cadence has nothing to capture while a full-screen program keeps output flowing. A
continuously-updating TUI never went idle, the switch-time snapshot deferred on in-flight writes,
and the host's 256 KiB ring held only the program's **incremental, cursor-addressed** bytes.
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
| The screen is created when the **host window opens**, not when a page attaches | A window with no page (a subagent, an action command) must capture its startup before the host ring can evict it. The unattended release drops a screen no page ever attaches to. |
| The hub owns the single host attachment for the life of the screen, not only while a page is attached | The screen must be current when a page arrives; the ring's incremental bytes cannot rebuild the base. |
| A page receives a serialized snapshot and then the live bytes; it sends only input and `resize` | The page is a renderer. Server→page control is `snapshot` (the replay), `reset` (an empty screen) and `exit` (the session is gone); binary frames are output. The page sends binary keystrokes and `{type:"resize"}`. The server owns the byte offset. |
| While the hub serializes, the bytes after its cutoff are **held**, then replayed in order | The snapshot is taken at a cutoff; the held bytes are fed to the screen and sent after the subscriber is registered, so none is lost or doubled. |
| One live client per hub, claimed **synchronously** | A second attach racing the serialize window is answered with the exit, not fanned out; the guard and the claim are one synchronous step. |
| The screen's applied high-water is **monotonic** | A ring byte that lands behind a seeded offset must not pull the offset back, or the regressed high-water would be persisted and the next resume would replay bytes already covered. |

## Persistence

The store (`apps/server/src/terminals/server/snapshots.ts`) holds one record per `(sessionId,
incarnation)`: the serialized screen `data`, the host byte offset `highWater` it covers, and
`savedAt`. It is loaded on start, persisted atomically, capped at 1 MiB per screen and 16 MiB in
total.

- The hub writes a **dirty** screen on a 5 s cadence — serializing a 5,000-row screen is ~17 ms and
  only changed screens are written — and synchronously in `flushScreens()`, which the shutdown
  handler calls before `closeAttachments()`. Several due screens are written in one store rewrite.
- `serialize()` trims the oldest scrollback to the cap and flags `truncated`; `""` means a
  genuinely empty screen only. An over-cap screen is never the empty sentinel: the page would read
  it as a blank `reset`, and `forgetSnapshot` would drop the deep screen the cap protects. Forgetting
  runs only for a genuinely empty screen; an oversized or failed serialize keeps the previous entry
  and leaves the screen dirty for the next cadence.
- On creation a screen **seeds** from the stored record (`screen.seed(data, highWater)`) and the
  host attaches from that offset, so one server's resume is exact.
- **Gap policy.** When the host's ring has already evicted past the stored offset there is a hole
  between it and the ring's oldest byte. The screen keeps its deep history and the ring's
  incremental bytes land on top, rather than rebuilding from the ring and forfeiting the history
  the store exists for. The cost: those bytes address a screen state from an older offset, so a TUI
  that never fully redraws can look scrambled until its next paint. The hole is bounded by the
  256 KiB ring, not by the missing span. The monotonic high-water keeps the older seqs from
  regressing the stored offset.

## Lifecycle

- The hub keeps the host attachment while the screen exists with no page, but only for a short
  grace: a screen with no page for `CORVI_SCREEN_IDLE_MS` (10 s) is **released** — persisted, its
  host attachment dropped, the hub forgotten, the shell untouched. A later attach reseeds it from
  the store and reattaches the host from the stored offset. Output does **not** postpone the
  release: the grace is the CPU bound, so a window is parsed while its startup is captured and
  while a page is looking, not forever. This is what makes several unattended agents affordable.
- The host's own idle timeout is disabled while the server holds its connection, so this
  server-side release is what frees the host's interest; the host idles once the server exits.
- A session exit persists the screen and keeps it for a `keepOpen` window (the frozen-viewing
  feature); everything else is evicted. The windows layer prunes the store down to live + kept
  incarnations on its poll.

## Load

- Host output is **coalesced per event-loop turn** into one `screen.write` and one WebSocket send,
  bounded by a per-turn byte cap; a single write per chunk would run the parser and the socket once
  per pty read.
- A page that falls far enough behind on its socket (a bounded `bufferedAmount`) is **re-synced**
  — closed so it reconnects to a fresh snapshot — rather than buffered without bound.
- The watcher's 1.5 s tick does host reads and registry reads only; the snapshot store is rewritten
  only when a screen is actually persisted (the cadence), never just because the tick ran.

## Boundaries and caveats

- "Exact" resume is **screen-content exact**: the serialize addon restores the text and the modes
  it knows (bracketed paste among them), not every parser state, and the stored offset can fall
  mid-escape. A cursor a full-screen program hid is shown again (`\e[?25h`).
- A stored screen seeded into a differently sized window **reflows**.
- `savedAt` is not refreshed on liveness, so under the total-size cap a quiet live screen can be
  evicted before a churning one.
- `apps/server/src/terminals/server/windows.ts` imports `session.ts` (for `ensureScreen`) and
  `session.ts` imports `windows.ts` (for `ensureActiveHostWindow`/`isKeptOpen`). The cycle is
  contained, but the pair is a candidate for the planned "extract the terminal plumbing into a
  package" refactor.
- The per-window token for the status/remote case, an OSC-status heartbeat/TTL, and folding the
  per-report session-list round trip onto the host push channel are separate later decisions; the
  screen store is not their home.

The screen lives in `apps/server/src/terminals/server/screen.ts`, the hub (attachment, coalescing,
unattended release, cadence, shutdown flush, subscribers) in `.../session.ts`, the persisted store
in `.../snapshots.ts`, and window creation in `.../windows.ts`. The page's
`apps/web/src/terminals/client/TerminalPane.tsx` is the renderer.
