# Phase 3 — renderer-owned vs server-owned screen state

Throwaway spike under `spike/screen/`. It adds the real xterm packages the eventual implementation
needs anyway (`@xterm/xterm`, `@xterm/headless`, `@xterm/addon-serialize`, latest) to the root
devDependencies; no product code changed. Raw evidence: `spike/screen/evidence.txt`.

`bash spike/screen/run.sh` → **63 assertions passed**: every restore check (pre- and post-tail, for
a normal and an alternate-screen snapshot), the independent cell/seq checks, the metric checks, the
real-page smoke, and the leftover check.

## Verdict

**Renderer-owned.** The decision stands, now on stronger evidence: both variants restore
byte-for-byte from a snapshot taken *after* the feature-rich part of the stream and again while the
alternate screen is live, compared immediately post-restore and again after the tail, with an
independent per-cell attribute signature. A server-owned emulator would restore no better and would
cost memory and CPU per session.

The decision is **conditional on snapshot cadence**: renderer-owned preserves scrollback as of the
last snapshot; periodic snapshots (or one on disconnect/idle) bound the gap. Server-owned keeps the
screen *current* through a client crash without a snapshot, which is the one thing it buys.

## The stream and the checks

`spike/screen/record.ts` records one real pty byte stream (`stream.bin`, **586,381 bytes**) from
`emit.ts`: 9,000 lines of scrolling (past the host buffer), SGR colours/attributes, wide and emoji
cells, cursor moves, an escape written in two pieces, an alternate-screen top-shaped TUI, and a
scrolling tail. The TUI is **deterministic**; there is no real `top -b -n1`, so the committed stream
no longer leaks this machine's process list, username or uptime (`grep` for the username/hostname is
empty). It is fed in **7-byte chunks**, so escapes and UTF-8 split across writes.

Restore is tested at two offsets, each compared against a terminal fed the same prefix:

- **after the features** (offset 523,381, before the final tail) — normal screen;
- **while the alternate screen is active** (the `Tasks:` line inside `?1049h`) — alternate screen.

For each: snapshot, restore into a fresh terminal, compare **immediately** (cursor, `baseY`/
`viewportY`, active buffer type, every row, and the independent cell signature) to the
pre-disconnect screen; then feed the tail and compare again to the whole-stream reference (same
measures plus `addon.serialize`). All pass, including the alternate-screen case.

Gotcha found and fixed: the serialize addon already emits the alternate-screen enter itself; adding
another `\x1b[?1049h` wipes the restored alt screen. The snapshot must not prepend one.

## Independent fidelity

Two checks that do **not** go through `addon.serialize`:

- **Per-cell attributes** (`getLine().getCell(x)`: chars + bold/italic/underline/inverse/dim/
  strikethrough + fg/bg colour) must match the reference for the normal and alternate snapshots,
  before and after the tail. A serializer that drops SGR cannot pass on both sides.
- **Per-event seq contiguity** on the client: while resuming mid-buffer, each data event's `seq`
  must equal the previous event's `seq + length`, so a dropped chunk (not eviction) is visible.
  Proven on the host contract session (`gap.firstSeqAtOffset`, `gap.seqContiguous`).

## The absolute-cursor correction, honestly

`snapshot()` appends `\x1b[row;colH` (Orca's fix). In **every tested case it is a no-op**: the
addon's relative moves already land the cursor at the same cell, so the cross-geometry test
(120×40 snapshot restored into 80×24) reports `cursor 0,23` with and without the correction
(`crossGeometry.correctionChangesOutcome: false`). It is kept as an explicit, cheap guarantee that
the cursor is stated absolutely rather than inferred from the addon's relative moves, which is what
would break if the addon or geometry handling changes. It is **not** claimed to fix cross-geometry
restore; restoring into a different size is inherently lossy and only asserted to stay in bounds.

Immediate post-restore cursor and scroll are asserted in same geometry (`*.preCursor`,
`*.preScroll`).

## Resume-gap policy

**Policy: when `attach since` reports `truncated`, discard the snapshot and reset the screen.**
The snapshot's high-water offset is older than the host's oldest replayable byte, so no consistent
screen can be rebuilt from snapshot + replay; the client clears and presents a fresh screen (and
should say why). The alternative — requiring a snapshot cadence no longer than the host buffer —
is a latency/persistence trade the implementation can layer on top; the chosen rule is the safe
floor.

Worst case: everything before `oldestSeq` is unrecoverable, so a reset loses the whole screen.
Proven end to end on a host session producing 624,890 bytes with a 262,144-byte buffer: the
snapshot high-water (0) predates `oldestSeq` (362,786), `attach(0)` is `truncated`, and the policy
resolves to `reset` (`gap.highWaterPredatesOldest`, `gap.truncatedResets`); with no snapshot at
all, **324,237 of 586,381 bytes (55%)** are past the buffer.

The real mid-buffer dedupe test exists now too: `attach(since = oldestSeq + 10)` is **not**
truncated, its first replayed byte is exactly `oldestSeq + 10`, and the sequence stays contiguous
(`gap.midBufferReplays`, `gap.firstSeqAtOffset`, `gap.seqContiguous`).

## Snapshot keyed to the incarnation

A `SnapshotRecord` is `{sessionId, incarnation, highWater, data}`; `acceptSnapshot(record, id,
incarnation)` requires both to match. A snapshot from a killed incarnation is rejected for the
reopened one — shown both directly (`incarnation.acceptsSame`/`rejectsKilled`) and against the host:
open `inc`, kill it, reopen (new incarnation), reject its old snapshot
(`incarnation.hostReopenRejected`).

## Numbers

| | renderer-owned | server-owned |
| --- | --- | --- |
| restore fidelity, normal snapshot | all pass | all pass |
| restore fidelity, alt-screen snapshot | all pass | (core is the same) |
| cell-attribute + seq-contiguity checks | pass | pass |
| real browser page restore | pass | (not built) |
| snapshot bytes @ 5,040 rows | 292,244 (after features) | 268,244 |
| snapshot bytes @ 50,040 rows | 2,782,144 (2.65 MiB) | 2,782,144 |
| snapshot time @ 5,040 / 50,040 rows | 17.6 ms / 216.0 ms | 17.6 ms / 216.0 ms |
| extra memory @ 50,040 rows | 71.5–193.1 MB RSS (process-level, two builds) | same, on the **server** per session |
| snapshot-on-connect | n/a (disconnect/idle) | 32.7 ms @ 5k, ~216 ms @ 50k |
| browser heap after restore | 19,300,000 B (~18.4 MiB), 5,040 rows | — |

The snapshot work is the same wherever it runs (same core); the difference is where the terminal
lives and who pays for it. Renderer memory is reported as a **range** across two builds, and is
process-level RSS for the headless core, not isolated per-terminal; the plan's per-session figure
would need a broker to measure precisely.

## The 1 MiB cap, measured

`addon.serialize({scrollback: N})` was called and the result restored, not extrapolated. The
largest tested cap that fits 1 MiB is **N = 15,000** → **824,212 bytes**, restoring **15,040 rows**
(the viewport plus the capped scrollback), well under the 50,040-row full size
(`cap.fitsOneMiB`, `cap.truncatesRows`). A production cap of 1 MiB therefore means roughly the last
15k scrollback rows per session.

## Decision details

- **Where snapshots live.** The page holds the live buffer; on disconnect/idle it serializes and
  hands the string to the server for the session (memory, optionally disk). The host's 256 KiB
  replay buffer covers bytes after the snapshot's high-water mark.
- **The `attach since` contract.** High-water = pty bytes the client has applied. On reconnect:
  write the snapshot, then `attach(since = highWater)`; the reply's `oldestSeq`/`truncated` decides
  keep-or-reset (above).
- **Scrollback** default 5,000, max 50,000; snapshot cap 1 MiB (~15k rows), measured.

## Deferred / not proven

- **Images and links** are not exercised: no image addon in the repo, and the serialize addon's
  link/image handling needs its own check.
- **Storage and eviction** of snapshots, the exact 1 MiB cap, and periodic (not only
  disconnect/idle) snapshot cadence.
- **Reboot persistence** of snapshots.
- **Resize policy** beyond the cross-geometry bounds check: restoring into a different size is
  lossy and the intended reflow/crop behaviour is undefined.
- **Per-session memory** from a broker rather than process-level RSS; a browser `performance.memory`
  figure was added (cheap) but is still whole-heap.

## Files

| File | Purpose |
| --- | --- |
| `spike/screen/emit.ts` | deterministic content generator (no real `top`), run inside the pty |
| `spike/screen/record.ts` | records `stream.bin` from a real pty |
| `spike/screen/stream.bin` | the committed recorded stream (586,381 bytes) |
| `spike/screen/xterm.ts` | headless adapter, snapshot (+ absolute cursor), cell signature, snapshot key |
| `spike/screen/run.ts` | fidelity at both snapshot points, metrics, cap, resume-gap policy, dedupe |
| `spike/screen/page-entry.ts` | real `@xterm/xterm` restore check (+ heap), bundled for the browser |
| `spike/screen/page-smoke.ts` | Playwright smoke: restore in Chromium and compare to headless |
| `spike/screen/run.sh` | `set -euo pipefail`, 63 assertions, leftover check |
| `spike/screen/evidence.txt` | raw run output |
| `spike/screen/RESULTS.md` | this file |

`spike/terminal-host/client.ts` gained a third `seq` argument on `onData` (the only change outside
`spike/screen/`) so the seq-contiguity check can see per-event offsets. `bun run typecheck` and
`bun run lint` pass.
