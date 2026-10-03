# The agent-status channel

Status: accepted and implemented. Supersedes the tmux pane-option reporter described in
[terminals](../manual/terminals.md)' earlier revision.

| Decision | Reason and boundary |
| --- | --- |
| A reporter publishes through the **`corvi status` CLI**, which posts to a typed server endpoint | The reporter is a small plugin inside an agent; a CLI call is the one channel that works from any harness, is logged by the server, and can be validated and capped. A direct HTTP call is the same endpoint for a reporter that cannot shell out. |
| Identity comes from the **pty environment** (`CORVI_SESSION_ID`, `CORVI_SESSION_INCARNATION`), seeded by the host | The session names itself; no discovery step, no write-then-read race, and a reused id with a new incarnation is never confused with its predecessor. |
| The server keeps status **in memory**, keyed by `(sessionId, incarnation)`, and clears it on exit | Status is a live fact about a running process, not product state worth persisting. A restart clears it and the reporter's next transition sets it again. |
| An OSC 1337 `corvi=<base64 json>` sequence is the **fallback**, parsed by the host | A program that cannot run the CLI can still report. The store is read first and the OSC value second, so the two channels share one shape without the OSC path being the contract. |
| Retire the tmux pane options (`@agent_status` and friends) as the reporter's channel | The presenter still reads that option vocabulary, but the host synthesizes it from the store or the OSC parse; no reporter writes a pane option. |

The endpoint validates the body against a shared schema with length caps and refuses an unknown
or dead incarnation. The presenter turns the status into the window's label, icon colour,
attention edge and note.

**Boundary.** There is no heartbeat or TTL: a reporter that dies mid-turn leaves `working` until
its session ends. A per-window token for a non-local server is a later decision.
