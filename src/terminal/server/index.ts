/**
 * The terminal module's public face: the tmux/ttyd session handling (`tmux.ts`) and the
 * presented-window shape (`presenter.ts`).
 *
 * The proxy leaf (`proxy.ts`) is deliberately **not** re-exported here. It is the HTTP boundary
 * — the ttyd page and socket bridge — and importing it would drag its client-side key script
 * (and the browser half it comes from) into every server consumer of `stopTerminal` or
 * `listWindows`. The files that speak HTTP directly (`routes/terminals.ts`, `routes/assets.ts`,
 * `server.ts`, `origin.ts`) import `./proxy.ts` as a leaf instead.
 *
 * The module knows sessions, not changes: every entry point takes the change's id and, where a
 * path is involved, the change directory its caller computed. There is no import of the change
 * module here.
 */
export {
  sessionName,
  logPath,
  terminalPath,
  terminalPort,
  terminalGone,
  stopTerminal,
  listWindows,
  allWindows,
  changeOfSession,
  newWindow,
  selectWindow,
  moveWindow,
} from "./tmux.ts";

export { presentWindow, type PresentedWindow } from "./presenter.ts";
