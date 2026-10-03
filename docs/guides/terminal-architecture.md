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
  the pty, an incarnation, byte `seq` offsets, a 256 KiB replay buffer, exit code/signal, status,
  and `cwd`/`createdAt`. Idle shutdown when no client is connected and no session is alive.
- `client.ts` — the server-side `ensureHost` (spawn or adopt) with an exclusive lock, ownership
  comparison (replace on a real mismatch, retry on a transient failure), and `HostClient`
  (`open/attach/write/resize/kill/list/info/shutdown`).
- `protocol.ts` — the request grammar and shared shapes; `osc.ts` — OSC-1337 status parsing.

Its contract: it knows session ids, not changes. Metadata (`change`, `window`, `subagentId`) is
opaque to it and is how the server re-associates windows after a restart.

## The server terminal module — `apps/server/src/terminals/server/`

- `host.ts` — one `HostClient` for the server, re-ensured when the host dies.
- `session.ts` — the WebSocket bridge and hub. One host attach per session for the life of its
  screen, not only while a page is attached; it feeds the screen, serves a page the serialized
  screen and then the live bytes, writes dirty screens to the store on a cadence and on shutdown,
  and releases a screen no page has looked at for a short grace (10 s) — output does not postpone
  it, which is the CPU bound for unattended windows. It coalesces host output per event-loop turn
  into one screen write and one socket send, and re-syncs a page that falls too far behind rather
  than buffering it without bound. Server→page control is `snapshot` (the replay), `reset` (an
  empty screen) and `exit`; the page sends binary keystrokes and `resize`. It resizes the pty and
  the screen to the page's grid on attach, and detaching never kills the shell.
- `screen.ts` — the headless screen: a `@xterm/headless` terminal per `(sessionId, incarnation)`
  at the page's grid with 5,000 rows of scrollback, the serialize addon, a monotonic applied host
  offset, `seed(data, offset)` for a stored screen, and a 1 MiB serialization trim.
- `registry.ts` + `windows.ts` — the persisted registry (`stateDir()/terminal-windows.json`): a
  **window** is an opaque id holding an ordered list of **panes** (host session ids) and an active
  pane, plus a label, the active flag, order and activity. `rebuild` merges the live host sessions
  into the saved records — it adopts a live pane whose metadata names an existing window (a split
  that crashed before its record was saved), and a pane the user closed is tombstoned so a pty that
  outlives the kill cannot resurrect the window. A restart keeps labels and order;
  `new`/`select`/`move` and `split`/`close-pane`/`focus-pane` mutate it, and opening a pane creates
  its screen. This is what the tab strip and navigation read; the page still renders one pane per
  window until 5b composes the grid.
- `snapshots.ts` — the persisted server screens, keyed by `(sessionId, incarnation)`, 1 MiB each,
  loaded on start and pruned to live + kept incarnations.
- `status.ts` — the agent-status store: `working`/`waiting`/`clear`, validated, incarnation-keyed,
  cleared when the session exits.
- `action-sessions.ts` — host-backed action delivery (open a window running a command, bracketed
  paste, submit).
- `presenter.ts` — merges registry windows + status into the `PresentedWindow` shape, using the
  real agent/command presenters.

## Routes — `apps/server/src/terminals/routes.ts`

- `GET /api/changes/:id/terminal/socket?cols&rows&session` — the pane's WebSocket. `session` names
  the pane session to attach; absent means the active window's active pane.
- `GET /api/changes/:id/terminal` — the socket URL and why a terminal cannot start.
- `GET /api/changes/:id/terminal/windows`, `POST` actions `new`/`select`/`move`/`split`/`close-pane`/
  `focus-pane`, `GET /api/terminals`.
- `POST /api/terminals/status` — the agent-status channel.

## The page — `apps/web/src/terminals/client/`

- `TerminalPane.tsx` — xterm renders the server's screen: real scrollback and scrollbar, native
  selection, a page context menu, find, links, font chords, clipboard chords (Ctrl+Shift, Cmd/Super,
  Ctrl/Shift+Insert), the WS protocol and a bounded reconnect. It replays the `snapshot`/`reset`
  frame and streams the binary output after it; it sends only input and `resize`.
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
- The pty size always matches the grid the page shows — a window created before its page opens is
  resized on attach.

## Deliberate trades

- The server's snapshot carries the modes the shell asked for (the serialize addon emits bracketed
  paste) and always shows the cursor (`\e[?25h`), so the page resets into the replay and a
  cursor-hiding TUI shows a cursor again until its next redraw. The alternative — trusting a replay
  to carry DECTCEM — never works (the serializer does not emit it), and a plain shell after pi would
  have no cursor at all.
- A stored screen is seeded into the server's headless terminal even when the host's ring has
  evicted past its offset (the gap policy in
  [server-owned screen state](../decisions/server-owned-screen.md)): the deep history is kept and
  the ring's incremental bytes land on top. A TUI that never fully redraws can look scrambled until
  its next paint, and the hole is bounded by the ring, not by the missing span.
- "Exact" resume is screen-content exact: the serializer restores the text and the modes it knows,
  not every parser state, and the stored offset can fall mid-escape.

## Known limitations

- Children that ignore HUP or are `setsid`/`nohup`'d survive a host SIGKILL (no cgroup supervision).
- The agent-status channel has no heartbeat: a reporter that dies mid-turn leaves `working` until
  the session exits.
- The screen is server-owned and persisted, but images and links are not covered, a stored screen
  seeded into a differently sized window reflows, and `savedAt` is not refreshed on liveness (a
  quiet live screen can be evicted before a churning one under the total-size cap).
- The status/first-byte trust model equals tmux's: a per-window token is the remote extension point.
- A split window's panes exist server-side, each with its own host session and screen; the page
  renders only the active pane until 5b composes the grid.
