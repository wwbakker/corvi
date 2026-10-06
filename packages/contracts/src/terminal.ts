/** The raw facts about one window — synthesized from the host session that backs it — before
 * anyone says what to call it. */
export type RawWindow = {
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
  /** Whether the name is one you gave it: a labelled host window is named; a plain shell is
   * named by its directory. */
  named: boolean;
  /** The window facts a presenter reads, by name ("@agent_status" → "working"). */
  options: Record<string, string>;
  /** The window id (`w-…`): opaque and stable across reordering, unlike the index. The page
   * attaches to `activePane`, which for a single-pane window is the same string. */
  id: string;
  /** The window's pane session ids, in order. */
  readonly panes: readonly string[];
  /** The focused pane's session id. */
  readonly activePane: string;
  /** Whether this window is a Corvi subagent (a host session carrying `subagentId`). A subagent
   * waits for its orchestrator, not the user; the presenter suppresses its attention. */
  subagent?: boolean;
};

/** How a window is presented. The first presenter that answers a field wins; fields left out
 * come from the next presenter, and the core's defaults last. The label is composed by the
 * core (from `running`), so a presenter that only says what is running still gets a good
 * name. */
export type WindowPresentation = {
  /** Override the composed name entirely. */
  label?: string;
  /** What is running in it, said the way a person would: "pi working", "opencode waiting", "nvim". */
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
  /** Whether the agent in this window is working right now — the agent-only signal, unlike
   * `busy`, which also counts plain commands. Absent for a window no agent speaks for. */
  working?: boolean;
  /** Whether an agent speaks for this window at all: the explicit "only agents" fact, so a
   * consumer need not guess from `icon` or `running`. */
  agent?: boolean;
  /** Whether this window wants the user now — what notifications are made of. The core only
   * sees the edge into it; the presenter owns what it means and when it clears. */
  attention?: boolean;
  /** A line of the presenter's own words to carry beside the name: an agent can say what it
   * just answered, instead of only that it stopped. */
  note?: string;
};

/** Says how a window is presented: which facts to read for it, and what those facts mean. Pure —
 * plain window data in, plain data out — so it runs wherever the windows are listed, with no
 * workspace and no services in sight. */
export type TerminalPresenter = {
  /** Nothing to say about this window is `undefined` — it simply falls through. */
  present(window: RawWindow): WindowPresentation | undefined;
};

/** One window of a change, as the navigation shows it: presented, not raw — the server says what
 * it is called and which icon it draws, and the page renders that. */
export type TerminalWindow = {
  index: number;
  /** The window id (`w-…`): stable across reordering, unlike the index. Opaque and independent of
   * the panes it holds. */
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
  /** The window's pane session ids, in order: each is a host session the page can attach to. */
  readonly panes: readonly string[];
  /** The focused pane's session id. The page renders this pane until 5b composes the rest. */
  readonly activePane: string;
};
