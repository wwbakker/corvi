# The terminal host and host sessions

Status: accepted and implemented. Supersedes the tmux-era line in
[architecture decisions](architecture.md) ("Retain the current technology baseline"); tmux is no
longer part of the product.

| Decision | Reason and boundary |
| --- | --- |
| Corvi owns the pty through a separate **terminal host** process, one per state directory, adopted across server restarts | A server restart is routine during development and must not end the shells. The host outlives the server, so reattaching is the normal path rather than a special one. The host runs on Node; Bun never delivers pty output. |
| The page renders the session with xterm.js and the server is a byte relay | One process owns the pty, the other owns the screen. The server keeps no emulator, so a session costs it no screen memory and no screen CPU. |
| Every terminal is a **host session**, not only interactive shells: action runs and subagents are the same substrate | One model for starting a process, writing to it, resizing it and ending it. A subagent's harness session is keyed by its directory and pinned by `--session-id`/`--session`, so reopening resumes it. |
| A persisted **window registry** owns order, labels and the active flag; the backing id is the host session id | The product's arrangement is not the substrate's. A restart rebuilds the list from the live sessions without losing labels or duplicating windows. |
| Discovery is session **metadata** (`change`, `window`, `subagentId`), read back with the host list | The old `@subagent_id` pane option was write-then-read with no owning process once the pane was gone; session metadata travels with the session's whole life. |
| Remove tmux, its install requirement, its config surface and its pane options | Nothing produced tmux windows once subagents moved; keeping it would keep a second substrate, its socket, its cleanup and its install step alive for no caller. |

The host protocol is newline-JSON over a unix socket with a token and an owner record; the socket
and the window registry live under the Corvi state directory. `CORVI_HOST_RUNTIME` is the test
seam that points the server's host client at a Node runtime.

**Boundary.** This is process survival, not machine-reboot restore: a reboot loses the host and
its sessions. The page's screen state is separate (see
[renderer-owned screen state](renderer-owned-screen.md)). One hub serves one live client; splits
and multi-client are separate later decisions.
