import type { AgentState } from "../terminalTypes.ts";

/** One tmux window of a change, as the navigation lists it. */
export type TerminalWindow = {
  index: number;
  name: string;
  command: string;
  active: boolean;
  activity: boolean;
  directory: string;
  named: boolean;
  /** Set for a window whose pane says an agent is in it. */
  agent?: AgentState;
};

/** What to call a window: the name when you gave it one, otherwise where it is. tmux names a
 * window after whatever runs in it, so that default says less than the directory does. */
export const windowLabel = (w: TerminalWindow): string => {
  const label = w.named ? w.name : w.directory || w.name;
  // An agent is `node` as far as tmux is concerned, which says nothing; what it told us about
  // itself says everything. Otherwise the process, unless it is a plain shell or already the
  // whole label.
  const what = w.agent ? `pi ${w.agent}` : w.command;
  return what && what !== "zsh" && what !== label ? `${label} - (${what})` : label;
};
