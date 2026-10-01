# Terminal architecture

Corvi does not use tmux. A pty **host** owns the shells, the server owns a **window registry**,
and the page's xterm owns the **screen**. This guide is the map of those pieces, their contracts
and how a byte travels between them. It is the current state, not a proposal.

## The three roles

| Role | Process | Owns |
| --- | --- | --- |
| Page | Electron/Chromium renderer | The screen: xterm buffer, scrollback, selection, context menu, find, links, snapshots, reconnect |
| Server | `apps/server/src/server.ts` (Node) | The product: change ↔ window ↔ session registry, labels, agent status, notifications, HTTP/WS |
| Host | `apps/server/src/terminals/host/main.ts` (Node, detached) | The ptys: session lifetime, byte replay, exit state, idle shutdown |

The host survives the server and the app; the page reconnects to a surviving shell.

```
  page                                    server                                terminal host
  ────                                    ──────                                ─────────────
  TerminalPane ──WS──► routes.ts ──► session.ts hub ──► host.ts client ──unix──► host.ts ──► node-pty
  WindowTabs   ◄──── windows.ts + registry.ts (window ↔ session ↔ change)         sessions + replay
  snapshot.ts  ────► snapshots.ts (persisted per session+incarnation)              incarnation + seq
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
- `session.ts` — the WebSocket bridge and hub. One host attach per session; output is binary
  frames, control is JSON (`snapshot`/`reset`/`truncated`/`exit` from the server; `attach`/
  `snapshot`/`resize` from the page). It resizes the pty to the page's grid on attach (a window
  created before its page opened carries a default size), and detaching never kills the shell.
- `registry.ts` + `windows.ts` — the persisted registry (`stateDir()/terminal-windows.json`):
  window id (= host session id), label, active flag, order, activity. `rebuild` merges the live
  host sessions into the saved records, so a restart keeps labels and order; `new`/`select`/`move`
  mutate it. This is what the tab strip and navigation read.
- `snapshots.ts` — the persisted screen snapshots, keyed by `(sessionId, incarnation)`, 1 MiB each.
- `status.ts` — the agent-status store: `working`/`waiting`/`clear`, validated, incarnation-keyed,
  cleared when the session exits.
- `action-sessions.ts` — host-backed action delivery (open a window running a command, bracketed
  paste, submit).
- `presenter.ts` — merges registry windows + status into the `PresentedWindow` shape, using the
  real agent/command presenters.

## Routes — `apps/server/src/terminals/routes.ts`

- `GET /api/changes/:id/terminal/socket?cols&rows&window` — the pty WebSocket. `window` names the
  window whose pty to attach; absent means the active one.
- `GET /api/changes/:id/terminal` — the socket URL and why a terminal cannot start.
- `GET /api/changes/:id/terminal/windows`, `POST` actions `new`/`select`/`move`, `GET /api/terminals`.
- `POST /api/terminals/status` — the agent-status channel.

## The page — `apps/web/src/terminals/client/`

- `TerminalPane.tsx` — xterm owns the screen: real scrollback and scrollbar, native selection,
  a page context menu, find, links, font chords, clipboard chords (Ctrl+Shift, Cmd/Super,
  Ctrl/Shift+Insert), the WS protocol, the snapshot handshake and a bounded reconnect.
- `snapshot.ts` — `serializeTerminal` (`@xterm/addon-serialize` + an absolute-cursor correction)
  with a 1 MiB cap; a visible pane snapshots when output settles, a hidden one on a slow timer.
- `WindowTabs.tsx` / `CheatSheet.tsx` — the tab strip and the key reference.

App state lives in `apps/web/src/app-root/state.ts` (`useWindows`, `useTerminal`); `ChangeView.tsx`
passes the active window id to the pane, and `SubagentsPane.tsx` passes the selected subagent's.

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

- The host owns sessions; the server owns windows/changes; the page owns the screen. No layer
  reaches across.
- A window id is a host session id; a session is identified by `(id, incarnation)`.
- Detaching, hiding a pane, or restarting the server never kills a shell; completing or cancelling
  a change does.
- The pty size always matches the grid the page shows — a window created before its page opens is
  resized on attach.

## Known limitations

- Children that ignore HUP or are `setsid`/`nohup`'d survive a host SIGKILL (no cgroup supervision).
- The agent-status channel has no heartbeat: a reporter that dies mid-turn leaves `working` until
  the session exits.
- Snapshots are page-owned and persisted server-side; images and links are not covered, and a
  snapshot taken at a different geometry restores approximately.
- The status/first-byte trust model equals tmux's: a per-window token is the remote extension point.
