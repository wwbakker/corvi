import { post } from "./api.ts";

export type TerminalWindow = {
  index: number;
  name: string;
  command: string;
  active: boolean;
  activity: boolean;
  directory: string;
  named: boolean;
};

/** What to call a window: the name when you gave it one, otherwise where it is. tmux names a
 * window after whatever runs in it, so that default says less than the directory does. */
export const windowLabel = (w: TerminalWindow): string => {
  const label = w.named ? w.name : w.directory || w.name;
  // The process, unless it is a plain shell or already the whole label.
  return w.command && w.command !== "zsh" && w.command !== label ? `${label} - (${w.command})` : label;
};

/**
 * The tmux windows of this change, as tabs: what each one is running, which is current, and
 * which produced output while you were looking elsewhere.
 *
 * tmux owns them — this reads `list-windows` and calls `new-window`/`select-window`, so the same
 * keys still work and a session attached from a terminal stays in step.
 */
export function WindowStrip({
  changeId,
  windows,
  onChanged,
  focusTerminal,
}: {
  changeId: string;
  /** Polled by the change view, which needs the count for the tab as well. */
  windows: TerminalWindow[];
  onChanged: (windows: TerminalWindow[]) => void;
  /** Puts the keyboard back in the terminal, for the cases where the click did take it. */
  focusTerminal: () => void;
}) {
  const setWindows = onChanged;

  const act = (body: { action: "new" | "select"; index?: number }) =>
    post<TerminalWindow[]>(`/changes/${changeId}/terminal/windows`, body)
      .then((next) => {
        setWindows(next);
        focusTerminal(); // you clicked a window to type in it
      })
      .catch(() => {});

  return (
    <div className="windows">
      {windows.map((w) => (
        <button
          key={w.index}
          className={w.active ? "win current" : "win"}
          title={`window ${w.index}: ${w.name} (${w.command}) in ${w.directory} — ctrl-b ${w.index}`}
          // Focus is what a mousedown moves, and a terminal you cannot type in after clicking a
          // window is useless. Preventing the default keeps it where it is: in the terminal.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => act({ action: "select", index: w.index })}
        >
          {windowLabel(w)}
          {/* Not for the current window: you are looking at its output already. */}
          {w.activity && !w.active && <span className="dot" title="new output" />}
        </button>
      ))}
      <button
        className="win add"
        title="new window (ctrl-b c)"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => act({ action: "new" })}
      >
        +
      </button>
    </div>
  );
}
