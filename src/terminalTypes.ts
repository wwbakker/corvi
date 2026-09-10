/** One tmux window of a change, as the navigation shows it: presented, not raw — the server
 * says what it is called and which icon it draws, and the page renders that. Its own file so
 * the page can have the type without importing the server's terminal machinery. */
export type TerminalWindow = {
  index: number;
  /** tmux's own window id (`@3`): stable across reordering, unlike the index. */
  id: string;
  /** What the navigation calls it. */
  label: string;
  /** The long form: what is running, and where. A tooltip or status bar reads this. */
  detail: string;
  /** Which glyph to draw; a name the page knows, unknown names fall back to the terminal. */
  icon?: string;
  /** The icon's colour: "ok" when it is working, "idle" at a prompt. */
  state?: "ok" | "idle";
  /** Whether this window wants the user now; the server reports the edges, the page decides
   * what to do with them. */
  attention: boolean;
  /** The presenter's own words to carry beside the name, e.g. what the agent just answered. */
  note?: string;
  active: boolean;
  /** Output arrived since you last looked at it. */
  activity: boolean;
};
