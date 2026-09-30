# Renderer-owned screen state

Status: accepted and implemented.

| Decision | Reason and boundary |
| --- | --- |
| The page's xterm.js owns the screen; the server stays a byte relay | There is one live client per session, so the renderer can hold the buffer without a second emulator's memory and CPU per session. |
| The page **serializes** the terminal with `@xterm/addon-serialize` plus an absolute-cursor correction and sends it with the host byte offset it covers | Serialization is the renderer's own view; the explicit cursor makes a restore into a different geometry unambiguous. |
| The server stores the latest snapshot per `(sessionId, incarnation)` and replays it on connect; the page then attaches with `since = highWater` | A reconnect restores the scrollback and resumes exactly after it, with no byte drawn twice and no byte lost. An explicit clear tombstones the value so a stale OSC status cannot reappear. |
| The snapshot store is **persisted** (state dir, atomic write, size-capped) and loaded on server start | This is what makes "restart Corvi and the terminal is still there" keep deep scrollback past the host's 256 KiB replay ring. A snapshot is pruned when its incarnation dies, except for a window a command asked to keep. |
| A snapshot is capped at 1 MiB; the page drops the oldest rows to fit, and the server refuses anything larger | The recent screen is what a restore is for, and an unbounded screenshot would be a memory and wire problem. |
| On a truncated replay the server sends a reset and the page clears before the replay | The evicted bytes cannot be reconstructed; drawing over corrupt state is worse than starting fresh. |
| Reject a server-side headless emulator (Phase 3's alternative) | It would restore no better and would cost memory and CPU per session, which is the one thing renderer-owned does not. |

The store lives in `apps/server/src/terminals/server/snapshots.ts`; the page's serializer is
`apps/web/src/terminals/client/snapshot.ts`. The protocol carries snapshots as JSON control
frames and output as binary frames.

**Boundary.** A crash loses at most the snapshot cadence; `pagehide`/`visibilitychange` are
best-effort. Images and links in the restored screen, and the per-window token a non-local server
needs, are separate later decisions.
