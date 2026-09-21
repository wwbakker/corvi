/**
 * The terminal module's public face: the tmux session handling (bound in `tmux.ts` over
 * `@corvi/terminals/tmux`) and the presented-window shape (`presenter.ts`).
 *
 * The pty bridge (`session.ts`) is deliberately **not** re-exported here. It is the socket
 * boundary, and importing it would drag node-pty into every server consumer of `stopTerminal`
 * or `listWindows`. The files that speak the socket directly (`terminals/routes.ts`,
 * `server.ts`) import `./session.ts` as a leaf instead.
 *
 * The module knows sessions, not changes: every entry point takes the change's id and, where a
 * path is involved, the change directory its caller computed. There is no import of the change
 * module here.
 */
export {
  sessionName,
  terminalSocketPath,
  stopTerminal,
  changeOfSession,
  newWindow,
  selectWindow,
  moveWindow,
  ensureSession,
  pastePrompt,
} from "./tmux.ts";

export { listWindows, allWindows, presentWindow, type PresentedWindow } from "./presenter.ts";
