/**
 * The terminal module's public face: the window registry over host sessions and tmux windows
 * (`windows.ts`), the pure presentation (`presenter.ts`), and the tmux operations subagents still
 * need (`tmux.ts`).
 *
 * The pty bridge (`session.ts`) is deliberately **not** re-exported here: it is the socket
 * boundary, and importing it would drag node-pty into every server consumer of `listWindows`.
 * The files that speak the socket directly (`terminals/routes.ts`, `server.ts`) import
 * `./session.ts` as a leaf instead.
 *
 * The module knows sessions, not changes: every entry point takes the change's id and, where a
 * path is involved, the directory its caller computed.
 */
export { listWindows, allWindows, newWindow, selectWindow, moveWindow, ensureActiveHostWindow, stopHostTerminals } from "./windows.ts";
export { presentWindow, type PresentedWindow } from "./presenter.ts";

// Subagents still run in tmux windows until their slice moves them, so its operations stay
// exported; the interactive/action paths use the host-backed `windows.ts` and `session.ts`.
export {
  terminalSocketPath,
  stopTerminal,
  changeOfSession,
  ensureSession,
  killWindow,
  newWindowRunning,
  setPaneOption,
  sessions,
} from "./tmux.ts";
