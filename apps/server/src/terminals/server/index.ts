/**
 * The terminal module's public face: the window registry over host sessions (`windows.ts`) and
 * the pure presentation (`presenter.ts`).
 *
 * The pty bridge (`session.ts`) is deliberately **not** re-exported here: it is the socket
 * boundary, and importing it would drag node-pty into every server consumer of `listWindows`.
 * The files that speak the socket directly (`terminals/routes.ts`, `server.ts`) import
 * `./session.ts` as a leaf instead.
 *
 * The module knows sessions, not changes: every entry point takes the change's id and, where a
 * path is involved, the directory its caller computed.
 *
 * `tmux.ts` still holds the socket path the page connects to (`terminalSocketPath`); its other
 * operations have no product caller since subagents moved to host sessions, and the package is
 * scheduled for deletion in a later slice.
 */
export {
  listWindows,
  allWindows,
  newWindow,
  selectWindow,
  moveWindow,
  ensureActiveHostWindow,
  stopHostTerminals,
  newSubagentWindow,
  killHostWindow,
  liveSubagents,
  type LiveSubagent,
} from "./windows.ts";
export { presentWindow, type PresentedWindow } from "./presenter.ts";
export { terminalSocketPath } from "./tmux.ts";
