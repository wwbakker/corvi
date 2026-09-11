/** The raw facts tmux reports about one window, before anyone says what to call it. */
export type TmuxWindow = {
  index: number;
  name: string;
  /** What is running in the active pane: zsh, nvim, gradle, ... */
  command: string;
  active: boolean;
  /** Output arrived since you last looked at it. */
  activity: boolean;
  /** Directory of the active pane: which repository the window is in, which is usually what
   * you want to know about it. */
  directory: string;
  /** Whether the name is one you gave it. tmux renames a window after whatever runs in it
   * until you name it yourself, which switches automatic renaming off. */
  named: boolean;
  /** The pane options any presenter declared, by option name ("@agent" → "working"). */
  options: Record<string, string>;
  /** tmux's own window id (`@3`): stable across reordering, unlike the index the session shows
   * and the tabs move around. */
  id: string;
};

/** How a window is presented. The first presenter that answers a field wins; fields left out
 * come from the next presenter, and the core's defaults last. The label is composed by the
 * core (from `running`), so a presenter that only says what is running still gets a good
 * name. */
export type WindowPresentation = {
  /** Override the composed name entirely. */
  label?: string;
  /** What is running in it, said the way a person would: "pi working", "nvim". */
  running?: string;
  /** One line about what is happening, for a tooltip or a status bar. */
  detail?: string;
  /** Which icon to draw — a name the page knows ("terminal", "agent"); unknown names fall
   * back to the terminal glyph. */
  icon?: string;
  /** The icon's colour: "ok" when it is working, "idle" at a prompt. */
  state?: "ok" | "idle";
  /** Whether this counts as work happening (the overview's terminals fact). */
  busy?: boolean;
  /** Whether this window wants the user now — what notifications are made of. The core only
   * sees the edge into it; the presenter owns what it means and when it clears. */
  attention?: boolean;
  /** A line of the presenter's own words to carry beside the name: an agent can say what it
   * just answered, instead of only that it stopped. */
  note?: string;
};

/** Says how a tmux window is presented: which pane options to read for it, and what those
 * options mean. Pure — plain tmux data in, plain data out — so it runs wherever the windows
 * are listed, with no workspace and no services in sight. */
export type TerminalPresenter = {
  /** Pane options to read for every window of every session, e.g. ["@agent"]. */
  paneOptions?: string[];
  /** Nothing to say about this window is `undefined` — it simply falls through. */
  present(window: TmuxWindow): WindowPresentation | undefined;
};
