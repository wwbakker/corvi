/** One tmux window of a change, as the navigation shows it: presented, not raw — the server
 * says what it is called and which icon it draws, and the page renders that. Its own file so
 * the page can have the type without importing the server's terminal machinery. */
export type TerminalWindow = {
  index: number;
  /** What the navigation calls it. */
  label: string;
  /** The long form: what is running, and where. A tooltip or status bar reads this. */
  detail: string;
  /** Which glyph to draw; a name the page knows, unknown names fall back to the terminal. */
  icon?: string;
  /** The icon's colour: "ok" when it is working, "idle" at a prompt. */
  state?: "ok" | "idle";
  active: boolean;
  /** Output arrived since you last looked at it. */
  activity: boolean;
};
