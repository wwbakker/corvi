# Phase 3 — renderer-owned vs server-owned screen state

Throwaway spike under `spike/screen/`. It adds the real xterm packages the eventual implementation
needs anyway (`@xterm/xterm`, `@xterm/headless`, `@xterm/addon-serialize`, latest) to the root
devDependencies; no product code changed. Raw evidence: `spike/screen/evidence.txt`.

`bash spike/screen/run.sh` → **29 assertions passed**: every restore-fidelity check, the metric
sanity checks, the real-page smoke, and the leftover check.

## Verdict

**Renderer-owned.** Both variants restore with equal, byte-for-byte fidelity; renderer-owned wins
because Corvi has one live client and no multiclient, so a server-side emulator is a second copy of
the screen that costs memory and CPU for no fidelity. The server stays a byte relay with the
256 KiB replay buffer it already has.

## The stream and the checks

`spike/screen/record.ts` records one real pty byte stream (`stream.bin`, **621 486 bytes**) from
`emit.ts`: 9 000 lines of scrolling (past the host buffer), SGR colours/attributes, wide and emoji
cells, cursor moves, an escape written in two pieces, an alternate-screen top-shaped TUI, a real
`top -b -n1` capture, and a scrolling tail. It is fed in **7-byte chunks** so escapes and UTF-8
sequences split across writes.

Restore is compared against a reference terminal fed the whole stream, by cursor, scroll
(`baseY`/`viewportY`), every row's text (scrollback included), and the full serialization. All pass
for both variants, including the real browser page.

## What each variant costs

The serialization itself is the same work wherever it runs (same core). The difference is *where
the terminal lives, who pays for it, and when it serializes*:

| | renderer-owned | server-owned |
| --- | --- | --- |
| restore fidelity (cursor/scroll/rows/serialized) | all pass | all pass |
| real browser page restore | pass | (not built; core is the same) |
| who holds the buffer | the page's xterm | a server `@xterm/headless` per session |
| snapshot taken | on disconnect/idle | on every connect |
| snapshot bytes @ 5 040 rows | 292 279 (mid-stream) | 277 961 |
| snapshot bytes @ 50 040 rows | 2 830 729 (2.7 MB) | 2 830 729 (2.7 MB) |
| snapshot time @ 5 040 rows | 17.07 ms | 17.07 ms |
| snapshot time @ 50 040 rows | 206.84 ms | 206.84 ms |
| extra memory @ 50 040 rows | +201.4 MB RSS (headless core) | +201.4 MB **server** RSS per session |
| snapshot-on-connect latency | n/a (not on the connect path) | 17.77 ms @ 5 k, ~207 ms @ 50 k |
| server CPU for an idle terminal | ~0 (relays bytes) | the core runs for every byte |

The renderer-owned snapshot is taken when the client disconnects or goes idle, not when one
connects; the connect path is a snapshot write plus `attach since`. The server-owned cost is paid
per live session, for every byte, on the server — the exact thing Corvi wants to keep cheap.

## Decision details

- **Where snapshots live.** The page holds the live buffer. On disconnect/idle it serializes with
  `@xterm/addon-serialize` (+ the absolute-cursor correction) and hands the string to the server to
  hold for the session in memory (optionally persisted under the session's state). The host's
  256 KiB replay buffer covers bytes after the snapshot.
- **Size cap.** Cap the stored snapshot (a starting point: 1 MiB/session) by serializing only the
  most recent rows (`serialize({ scrollback: N })`) when the buffer is larger. Scrollback default
  5 000 (max 50 000, as the plan proposes). At 50 k rows a full snapshot is ~2.7 MB and ~207 ms, so
  a 1 MiB cap already implies truncating to roughly the last ~18 k rows — measured, not guessed.
- **The `attach since` contract.** The client's high-water offset is the number of pty bytes it has
  applied (the host's `lastSeq` it has consumed). It stores that with the snapshot and, on
  reconnect, writes the snapshot then calls `attach(since = highWater)`. The host replies with
  `oldestSeq`/`truncated`; if `truncated`, bytes before the snapshot's offset were already lost.
  Proven with the Phase 1 host: with ~625 KB produced and a 256 KiB buffer,
  `attach(since = 0)` → `truncated: true, oldestSeq = 362 838`, while
  `attach(since = oldestSeq + 10)` → `truncated: false` (`contract.*`).
- **The absolute-cursor fix.** The current addon emits relative cursor moves, which are only right
  when the target has the same geometry; the spike appends an explicit `\x1b[row;colH` and verifies
  the restored serialization equals the reference's. The real implementation should keep that
  explicit move (and re-check it when the addon changes).

## What a hard kill loses

With no snapshot, both variants are limited by the host's replay buffer: of 621 486 bytes,
**359 342 (58%) are before `oldestSeq`** and cannot be replayed (`hardKill.losesBytesWithoutSnapshot`).
The renderer-owned snapshot at disconnect is precisely what preserves those earlier rows; a
server-owned design preserves them only if the server serializes before the crash too. Neither
scheme survives a hard kill with no prior snapshot.

## Why not server-owned

Server-owned is the right call when several clients watch one session, when the server must answer
scrollback/search without a client, or when the client cannot be trusted to hold state. Corvi's
decision record says the opposite: **one live client, no multiclient**. Against that, a
server-owned emulator is a second screen copy that costs ~200 MB per 50 k-row session and ~207 ms
per connect, and makes the server process every byte. It restores no better. The spike kept it
minimal on purpose (a long-lived terminal, serialize-on-connect) and did not build a persistent
server loop.

## Deferred / not proven

- **Images and links** were not exercised: the image addon is not in the repo, and the serialize
  addon's handling of links/images needs its own check before relying on it.
- **Restoring into a different geometry** (resize between snapshot and restore) is not covered; the
  addon recommends same-size restore, and the absolute-cursor move should be re-checked there.
- **Real page memory** was measured on the headless core (RSS); a browser `performance.memory` read
  would be a better renderer-owned figure.
- **Snapshot storage/eviction**, the 1 MiB cap tuning, and periodic (not only disconnect) snapshot
  cadence are policy decisions left to the implementation.
- The 5 k vs 50 k default scrollback and whether snapshots persist across a machine reboot remain
  open (the plan's open question 4).

## Files

| File | Purpose |
| --- | --- |
| `spike/screen/emit.ts` | the content generator, run inside the recorded pty |
| `spike/screen/record.ts` | records `stream.bin` from a real pty |
| `spike/screen/stream.bin` | the committed recorded stream (621 486 bytes) |
| `spike/screen/xterm.ts` | shared headless-terminal adapter, snapshot (+ absolute cursor), restore |
| `spike/screen/run.ts` | both variants' fidelity, snapshot/memory metrics, `attach since` contract |
| `spike/screen/page-entry.ts` | real `@xterm/xterm` restore check, bundled for the browser |
| `spike/screen/page-smoke.ts` | Playwright smoke: restore in Chromium and compare to headless |
| `spike/screen/run.sh` | `set -euo pipefail`, 29 assertions, leftover check |
| `spike/screen/evidence.txt` | raw run output |
| `spike/screen/RESULTS.md` | this file |

`bun run typecheck` and `bun run lint` pass.
