# IWE's terminals live on their own tmux socket

> **Kind:** decision · **Status:** accepted

## Context

Every tmux command IWE ran resolved its socket implicitly. None of the eleven call sites named
one, so each used whatever tmux resolves on its own: `$TMUX` when the server was started inside a
tmux session, otherwise `$TMUX_TMPDIR` or `/tmp` plus `default`. Two consequences, neither
visible from the code:

- **A bare `tmux` command could end every IWE terminal.** During the planning change, a throwaway
  Playwright probe ran `tmux kill-server` from inside a pane: `$TMUX` named the default server,
  and every session on it — all IWE terminals, and whatever ran in them — died. The test harness
  had the discipline (a private `TMUX_TMPDIR`, `$TMUX` deleted) but that discipline was a comment
  in one file, not a structure; the probe forgot it, and nothing stopped it.
- **The app's commands were reroutable.** Launching the app or `bun run dev` from inside a tmux
  session pointed every one of those commands at that session's server: IWE's sessions would land
  in whatever server launched it.

## Decision

**Every tmux command IWE runs names its socket, in one builder.** `tmuxCmd()`
(src/terminals/server/tmux.ts) prepends the socket to every command, including the argv the pty
runs. The socket is `IWE_TMUX_SOCKET`, default `iwe`: a bare name becomes `-L <name>` — the file
`tmux-<uid>/<name>` under `$TMUX_TMPDIR` or `/tmp` — and a path becomes `-S <path>`.
`-L` and `-S` beat `$TMUX` (verified: with `$TMUX` set, `tmux -L x ls` still asks the x socket), so:

- the app's own commands are deterministic, whatever shell launched it; and
- a bare `tmux` command — a probe, a script, a test run, an agent in a non-tmux shell — resolves
  to the default socket and finds nothing of IWE's.

The attach command from a normal terminal becomes `tmux -L iwe attach -t iwe-<id>`. This
supersedes the sentence in [`node-pty-terminal.md`](node-pty-terminal.md) that gives it without
the socket.

Panes start with the change's context on purpose — `IWE_CHANGE_ID` and `IWE_CHANGE_DIR` in the
pty's environment (scrubbed of the launcher's variables like every child,
`src/capabilities/env.ts`) and, for a session created by `ensureSession`, `-e` flags at creation,
so the first window has it whichever way the session came into being.

## The guard that was tried

The decision does not close the in-pane hole: inside a pane, `$TMUX` names IWE's server, and for
a bare command `$TMUX` wins — so `tmux kill-server` typed in a pane still ends every IWE
terminal. A PATH shim refusing `kill-server` was implemented and dropped on measurement: the
pane's PATH does carry it, but a login shell rebuilds PATH — macOS's `path_helper`, brew
shellenv, the user's own rc files — ahead of anything IWE can add, so `tmux` always resolves to
the real binary. Dead code that only implies protection. What guards the realistic case is the
harness discipline: tests and scripts name their socket with `-S` under the run's temp dir (the
server under test gets the same path as `IWE_TMUX_SOCKET`), and
[`scripts/clean-test.ts`](../../scripts/clean-test.ts) decides ownership by socket path. A human
typing `kill-server` in a pane is a deliberate act.

## Consequences

- Attaching from a normal terminal names the socket: `tmux -L iwe attach -t iwe-<id>` (README and
  the cheat sheet say so). A bare `tmux ls` lists none of IWE's sessions — that is the point.
- Sessions created before this decision stay on the default socket: invisible to IWE, still
  attachable by hand, no migration.
- Known edge: a pty attach that *starts* the tmux server donates the pane's environment to the
  server's **global** environment, including that change's `IWE_CHANGE_*` — a session created
  later by hand on the iwe socket would inherit a stale change's identity in its panes.
  Unsetting it globally (`set-environment -g -u` in the attach chain) was tried and reverted:
  tmux's `-u` leaves a removal marker in the global table that propagates into sessions at attach
  and strips the variable IWE deliberately set.
- The sandbox copy shares the `iwe` socket, as it shared the default socket before — it shares
  the changes root. If it ever gets a root of its own, `IWE_TMUX_SOCKET` is the mechanism.
- One server per change (`-L iwe-<id>`) was rejected: the sidebar's `list-windows -a` is
  deliberately one call for every change, and per-change servers would make it one call per
  change every few seconds.
- Tests: every tmux call names its socket with `-S` under the run's temp dir — the same path the
  server under test receives — so a careless `kill-server` in a test can only reach a socket the
  test itself created. The ownership rules in [`AGENTS.md`](../../AGENTS.md) and
  `scripts/clean-test.ts` say the same thing.
