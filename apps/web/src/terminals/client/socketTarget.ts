/**
 * The pane's socket-target decision, split out so it is pinned without a browser.
 *
 * The terminal socket belongs to one pane. When the pane the page names changes, the existing
 * socket must be closed and a new one opened — except for one case: the *first* connect happens
 * before the window list arrives, so it opens unnamed, the server resolves the active pane, and the
 * window list then names that same pane. Reconnecting there would drop keystrokes in the gap
 * between two sockets, so that one rename keeps the socket.
 */

/** What the pane's socket effect knows when the target changes. */
export type SocketTarget = {
  /** Whether the current socket opened without naming a pane, so the server resolved the active
   * one for it. A socket opened for a named pane is never a rename candidate. */
  readonly unnamed: boolean;
  /** The pane session the **current** socket resolved to, from its own control frame; null until
   * that frame arrives. It must be read per socket, not as "the last frame seen": after a real
   * switch it still holds the id of a *previous* socket. */
  readonly resolved: string | null;
  /** The pane the page now names; null/undefined before the window list has loaded. */
  readonly sessionId: string | null | undefined;
};

/** Whether a target change is the unnamed first connect resolving to the same pane (keep the open
 * socket) rather than a switch to another pane (close and reconnect). A resolved id from a
 * previous socket must not count: on rapid A → B → A, keeping B's socket while the page names A
 * would render B's screen under A's tab. */
export const shouldKeepSocket = ({ unnamed, resolved, sessionId }: SocketTarget): boolean =>
  unnamed && sessionId != null && resolved === sessionId;
