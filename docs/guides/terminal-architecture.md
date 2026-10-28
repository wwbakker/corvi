# Terminal architecture

Corvi does not use tmux. A pty **host** owns the shells, the server owns a **window registry** and
a headless **screen** per session, and the page's xterm renders that screen. This guide is the map
of those pieces, their contracts and how a byte travels between them. It is the current state, not
a proposal.

## The three roles

| Role | Process | Owns |
| --- | --- | --- |
| Page | Electron/Chromium renderer | The rendering: xterm buffer, scrollback, selection, context menu, find, links, reconnect |
| Server | `apps/server/src/server.ts` (Node) | The product: change ↔ window ↔ session registry, the screen per session, labels, agent status, notifications, HTTP/WS |
| Host | `apps/server/src/terminals/host/main.ts` (Node, detached) | The ptys: session lifetime, byte replay, exit state, idle shutdown |

The host survives the server and the app; the page reconnects to a surviving shell.

```
  page                                    server                                terminal host
  ────                                    ──────                                ─────────────
  TerminalPane ──WS──► routes.ts ──► session.ts hub ──► host.ts client ──unix──► host.ts ──► node-pty
  WindowTabs   ◄──── windows.ts + registry.ts (window ↔ session ↔ change)         sessions + replay
  renderer     ◄──── session.ts hub ◄── screen.ts (headless xterm)               incarnation + seq
                                          └────► snapshots.ts (persisted store)
  status view  ◄──── status.ts ◄── corvi status ◄── integrations/{pi,opencode}     OSC status parse
  SubagentsPane◄──── subagents/server/instances.ts (a subagent is a host session)
```

## The terminal host — `apps/server/src/terminals/host/`

- `main.ts` — the process boundary: argv (`--socket`, `--checkout`, `--build-id`), signals, and
  the `onClosed` exit. Run under Node (`node …/main.ts`); Bun never delivers pty output.
- `host.ts` — the daemon. A Unix socket with a 0600 token, a pid record and an owner record
  (checkout + build id), written only after `listen`. Sessions are keyed by a product id and hold
  the pty, an incarnation, byte `seq` offsets, a **4 MiB** replay buffer (per live session,
  overridable with `CORVI_HOST_REPLAY_BYTES` for tests), exit code/signal, status, and
  `cwd`/`createdAt`. Idle shutdown when no client is connected and no session is alive.
- `client.ts` — the server-side `ensureHost` (spawn or adopt) with an exclusive lock, ownership
  comparison (replace on a real mismatch, retry on a transient failure), and `HostClient`
  (`open/attach/write/resize/kill/list/info/shutdown`).
- `protocol.ts` — the request grammar and shared shapes; `osc.ts` — OSC-1337 status parsing.

Its contract: it knows session ids, not changes. Metadata (`change`, `window`, `subagentId`) is
opaque to it and is how the server re-associates windows after a restart.

## The server terminal module — `apps/server/src/terminals/server/`

- `host.ts` — one `HostClient` for the server, re-ensured when the host dies.
- `session.ts` — the WebSocket bridge and hub. The screen is **warm for the life of its session**:
  one host attach from window open, whether or not a page is looking, and no timed release. It
  seeds from the store, feeds every host byte to the headless screen, and serves a page the
  serialized snapshot and then the live bytes. Dirty screens are written on a 5 s cadence and on
  shutdown. It coalesces host output per event-loop turn into one screen write and one socket send,
  and re-syncs a page that falls too far behind rather than buffering it without bound. One live
  page per session: a newer attach supersedes the older one, which is told `detached` — the
  terminal is open elsewhere and can be taken back — where a real session end is `exit`.
  Server→page control is `snapshot` (the replay), `reset` (an empty screen), `exit` (final) and
  `detached` (superseded); the page sends binary keystrokes and `resize`. It resizes the pty and the
  screen to the page's grid on attach, and detaching never kills the shell.
  A host-ring gap (`reply.truncated`) is the only reason to reprint: the jiggle is issued after the
  snapshot and hold drain, streams its bytes to the page, and never gates the view on output
  going quiet. It is best-effort, not a repair guarantee. If the host connection dies, the sweep
  persists the last screen, tells attached pages the session ended, and reaps the hub unless a
  kept-open window still needs its frozen screen. `CORVI_TERMINAL_TRACE=1` adds attach/serve/
  reprint timings and a periodic per-hub size/cadence line.
- `screen.ts` — the headless screen: a `@xterm/headless` terminal per `(sessionId, incarnation)`
  at the page's grid with 5,000 rows of scrollback, the serialize addon, a monotonic applied host
  offset, `seed(data, offset)` for a stored screen, and a 1 MiB serialization trim.
- `registry.ts` + `windows.ts` — the persisted registry (`stateDir()/terminal-windows.json`): a
  **window** is an opaque id holding an ordered list of **panes** (host session ids) and an active
  pane, plus a label, a user-given title, the active flag, order and activity. `label` marks a window
  as an action run (`@corvi_action` publishes it); `title` is the name the user gave from the tab,
  deliberately separate so a named shell is still an idle shell. `rebuild` merges the live host
  sessions into the saved records — it adopts a live pane whose metadata names an existing window (a
  split that crashed before its record was saved), and a pane the user closed is tombstoned so a pty
  that outlives the kill cannot resurrect the window. A restart keeps labels, titles and order;
  `new`/`select`/`move`/`rename` and `split`/`close-pane`/`focus-pane` mutate it, and opening a pane
  creates its screen. This is what the tab strip and navigation read; the page still renders one
  pane per window until 5b composes the grid.
- `snapshots.ts` — the persisted server screens, keyed by `(sessionId, incarnation)`, 1 MiB each,
  loaded on start and pruned to live + kept incarnations.
- `status.ts` — the agent-status store: `working`/`waiting`/`clear`, validated, incarnation-keyed,
  cleared when the session exits.
- `action-sessions.ts` — host-backed action delivery (open a window running a command, bracketed
  paste, submit).
- `presenter.ts` — merges registry windows + status into the `PresentedWindow` shape, using the
  real agent/command presenters; a user-given title is the label those presenters do not override.

## Routes — `apps/server/src/terminals/routes.ts`

- `GET /api/changes/:id/terminal/socket?cols&rows&session` — the pane's WebSocket. `session` names
  the pane session to attach; absent means the active window's active pane.
- `GET /api/changes/:id/terminal` — the socket URL and why a terminal cannot start.
- `GET /api/changes/:id/terminal/windows`, `POST` actions `new`/`select`/`move`/`split`/`close-pane`/
  `focus-pane`/`rename`, `GET /api/terminals`.
- `POST /api/terminals/status` — the agent-status channel.

## The page — `apps/web/src/terminals/client/`

- `TerminalPane.tsx` — xterm renders the server's screen: real scrollback and scrollbar, native
  selection, a page context menu, find, links, font chords, clipboard chords (Ctrl+Shift, Cmd/Super,
  Ctrl/Shift+Insert), the WS protocol and a bounded reconnect. It replays the `snapshot`/`reset`
  frame and streams the binary output after it; it sends only input and `resize`. Its
  starting/connecting/reconnecting status is an absolute overlay, not a layout row, so socket
  state cannot change the grid between the connect and its snapshot.
- `WindowTabs.tsx` / `CheatSheet.tsx` — the tab strip and the key reference.

App state lives in `apps/web/src/app-root/state.ts` (`useWindows`, `useTerminal`); `ChangeView.tsx`
passes the active window's focused pane id to the pane, and `SubagentsPane.tsx` passes the selected
subagent's.

## Agent status

A reporter in a pane reads `CORVI_SESSION_ID`/`CORVI_SESSION_INCARNATION` from its environment and
runs `corvi status working|waiting|clear [--name|--session-name|--message]`. The CLI posts to
`/api/terminals/status` through `@corvi/client`; the server validates, keys by incarnation, and
clears on exit. The presenter and `watch.ts` notifications read the store. OSC-1337 remains a
host-side fallback. Reporter code lives in `integrations/pi` and `integrations/opencode`.

## Subagents

`apps/server/src/subagents/server/instances.ts` opens a subagent as a host session: cwd is the
subagent's own directory (which, with the harness's pinned `--session-id`/`--session`, is what
resumes the same harness session), metadata carries `subagentId`, and the env carries
`CORVI_SUBAGENT_ID`. The relay is `corvi subagent next`/`turn`; the orchestrator drives it with
`corvi subagent create|send|wait|result|open|close`.

## Power down when agents are done

`apps/server/src/power/` arms a machine to shut down once no agent on it is working. Every machine
owns its own arm state: the local server arms itself, fans the command out to the selected remote
servers with each workspace's device token, and serves `GET /api/power` plus the arm/disarm
routes. A server-owned fiber ticks once a second (a disarmed tick reads nothing) and runs a
60-second countdown, which `CORVI_POWER_COUNTDOWN_MS` overrides (`0` fires on the next quiet
tick). The control and the monitor read one server-computed list (`agentStates`), so
the dialog shows exactly what the power-off waits on; the agent and change reads are strict — a
failed read skips the tick and is never "no agents". The state lives in server memory, and a
change to it is announced as the `power` event (a remote's arrives under the `source` envelope),
so an open page refetches `GET /api/power`.

## Actions

`packages/actions/src/deliver.ts` gets a host-backed `ActionSessions`: a new run opens a window
running the action command, the prompt is a bracketed write, submit is Enter, and `keepOpen`/
`notify` ride on the window record so a finished command freezes over its output.

## Invariants

- The host owns sessions; the server owns windows/changes and the screen; the page renders it. No
  layer reaches across.
- A window id is opaque; a window holds one or more panes, each a host session identified by
  `(id, incarnation)`.
- Detaching, hiding a pane, or restarting the server never kills a shell; completing or cancelling
  a change does.
- The pty size matches the grid the page shows in steady state — a window created before its page
  opens is resized on attach. The exception is the one-column shrink during a gap reprint; the
  grow restores the latest grid.

## Deliberate trades

- The server's snapshot carries the modes the shell asked for (the serialize addon emits bracketed
  paste) and always shows the cursor (`\e[?25h`), so the page resets into the replay and a
  cursor-hiding TUI shows a cursor again until its next redraw. The alternative — trusting a replay
  to carry DECTCEM — never works (the serializer does not emit it), and a plain shell after pi would
  have no cursor at all.
- A stored screen is seeded into the server's headless terminal even when the host's ring has
  evicted past its offset (the gap policy in
  [server-owned screen state](../decisions/server-owned-screen.md)): the deep history is kept and
  the ring's incremental bytes land on top. A gap triggers a best-effort background reprint after
  the snapshot; a TUI that does not repaint on `SIGWINCH` can still look scrambled until its next
  full paint. The missing span between the stored offset and the ring's oldest byte is unbounded;
  only the misapplied ring tail is bounded by the 4 MiB ring. The alternative — drop the seed and
  reset to a clean ring tail — is worth revisiting now that the reprint is measured, but it is not
  changed here because it would forfeit the deep history.
- Warm screens spend memory, not a fixed CPU grace. The measured estimate is ~6.5–7 MiB/screen,
  server RSS growth is ~8–10 MiB/screen while scrollback fills, and the host's replay ring adds up
  to N × 4 MiB plus pty processes. The follow-up cap trigger reads the trace's summed `estBytes`;
  above ~256 MiB release the least-recently-viewed unattended screen after persisting it. At ~6.5–7
  MiB/screen that is ~36–40 screens; ~30 is the ~9 MiB measured-RSS gloss, not the trigger metric.
  That fallback is lossy for a non-redrawing TUI, so it needs an active-turn probe first.
- Memory is not the only cost: the lockstep 5 s cadence serializes every due screen in one 250 ms
  tick (~18–20 ms each, ~0.6 s of event-loop block at ~30 screens) and rewrites the whole store
  synchronously; `/api/workspaces` p95 was 7 ms at 8 screens and 61 ms at 16. The follow-up should
  also stagger persists across ticks or use a longer cadence for unviewed screens.
- The gap reprint's old rationale — “pi re-emits its whole conversation, measured 8.7 MB” — is
  contradicted by the committed isolated probe: pi 1.0.3 startup and history and opencode 1.18.34
  startup emitted **0 host bytes** on the exact jiggle with unchanged screens; an earlier ad-hoc
  pi-history run once saw 29 B but did not reproduce. The active-turn case is unmeasured (no
  isolated credentials). The gap path is therefore best-effort, not a repair guarantee.
- "Exact" resume is screen-content exact: the serializer restores the text and the modes it knows,
  not every parser state, and the stored offset can fall mid-escape.

## Known limitations

- Children that ignore HUP or are `setsid`/`nohup`'d survive a host SIGKILL (no cgroup supervision).
- The agent-status channel has no heartbeat: a reporter that dies mid-turn leaves `working` until
  the session exits.
- The screen is server-owned and persisted, but images and links are not covered, a stored screen
  seeded into a differently sized window reflows, and `savedAt` is not refreshed on liveness (a
  quiet live screen can be evicted before a churning one under the total-size cap).
- Warm unviewed screens are not capped in this change; the trace and `hubStats()` expose their
  estimated size for the cap follow-up above.
- The status/first-byte trust model equals tmux's: a per-window token is the remote extension point.
- A split window's panes exist server-side, each with its own host session and screen; the page
  renders only the active pane until 5b composes the grid.
