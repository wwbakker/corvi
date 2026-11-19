/** The actions a change's terminal windows may run, as entries of the change's own **Actions** menu.
 *
 * There is one menu on a change page: the title row's. It carries the change's lifecycle actions
 * and, under them, the window's — these. The list is fetched when the menu opens (discovery is per
 * request, so an edited or newly written file shows up on the next open), the client names an
 * action by key when running one, and the text never leaves the machine. After a run the notice
 * names the window it went to and the keyboard goes back to the terminal. */
import { useCallback, useEffect, useRef, useState } from "react";

import { ChangeId } from "@corvi/contracts/changes";
import type { ActionSummaryDto, RunActionResultDto } from "@corvi/contracts/actions";
import type { TerminalWindow } from "../domain/terminal.ts";
import { useChangeClient } from "../app-root/sources.ts";
import type { Action } from "../app-root/ActionsMenu.tsx";

/** What kind of window is on screen. The agent kind is the presented icon — the app's
 * presenters read pi's own `@agent_status` for it. */
export type WindowKind = "agent" | "plain";

export const kindOf = (window?: TerminalWindow): WindowKind => (window?.icon === "agent" ? "agent" : "plain");

/** Which actions this window may run. `agent` and `new` targets are offered anywhere; an
 * `active` target only where its delivery makes sense — a prompt into the agent you are looking
 * at, a command into a plain shell. Pure, so the rule is pin-able. */
export const applicableActions = (
  actions: readonly ActionSummaryDto[],
  active?: TerminalWindow,
): ActionSummaryDto[] =>
  actions.filter((a) => {
    if (a.target !== "active") return true;
    if (!active) return false;
    return a.kind === "prompt" ? kindOf(active) === "agent" : kindOf(active) === "plain";
  });

/** The notice after a run, naming the window it went to ("Pasted into orders-api — read it and
 * send it"). Pure. */
export const noticeFor = (label: string, result: RunActionResultDto): string => {
  const where = result.window?.label ?? result.window?.id ?? "the terminal";
  if (result.started) {
    return result.kind === "command"
      ? `Running "${label}" in a new window`
      : `Started a window and pasted "${label}"`;
  }
  if (result.kind === "command") return `Running "${label}" in ${where}`;
  return result.submitted ? `Sent to ${where}` : `Pasted into ${where} — read it and send it`;
};

/** The terminal entries of the change's Actions menu, and the way to refresh them. */
export function useTerminalActions({
  changeId,
  windows,
  disabled,
  onOpenCheatSheet,
  onRan,
  onNotice,
}: {
  changeId: string;
  /** This change's windows, so the filter can see what is on screen. */
  windows: TerminalWindow[];
  /** The change's workspace is unavailable: the cheat sheet is local and still offered, but no
   * action that would reach the remote is. */
  disabled?: boolean;
  /** The cheat sheet is the page's dialog: the menu only asks for it. */
  onOpenCheatSheet: () => void;
  /** The keyboard goes back to the terminal after a run. */
  onRan: () => void;
  /** What the page says after a run: the window it went to, or why it could not run. */
  onNotice: (message: string | null) => void;
}): { actions: Action[]; refresh: () => void } {
  const client = useChangeClient();
  const [actions, setActions] = useState<readonly ActionSummaryDto[]>([]);
  const clear = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // A notice is the page's, not the menu's: it outlives the menu closing on the way to the run.
  useEffect(() => () => clearTimeout(clear.current), []);

  const say = useCallback(
    (message: string | null): void => {
      clearTimeout(clear.current);
      onNotice(message);
      if (message !== null) clear.current = setTimeout(() => onNotice(null), 2500);
    },
    [onNotice],
  );

  const refresh = useCallback((): void => {
    client.actions
      .list(ChangeId.make(changeId))
      .then(setActions)
      .catch((e: Error) => say(e.message));
  }, [client, changeId, say]);

  const run = (found: ActionSummaryDto): void => {
    const active = windows.find((w) => w.active);
    onRan();
    client.actions
      .run(ChangeId.make(changeId), found.key, active?.id)
      .then((result) => say(noticeFor(found.label, result)))
      .catch((e: Error) => say(e.message));
  };

  // The run entries first, then the cheat sheet: the menu's last section is reading, not doing.
  const active = windows.find((w) => w.active);
  const entries: Action[] = [
    // Named and disabled, not hidden: an unavailable workspace's actions explain themselves the
    // way the change's own menu does, and the cheat sheet (local) stays usable.
    ...applicableActions(actions, active).map((found) => ({
      disabled: disabled === true,
      // Workspace and repository actions carry their source ("review — orders-api"), so the
      // same id from two checkouts is two entries, each saying whose it is.
      label:
        found.source === "builtin" || found.source === "global"
          ? found.label
          : `${found.label} — ${found.sourceLabel ?? found.source}`,
      title:
        disabled === true
          ? "Unavailable: this workspace cannot be reached"
          : found.target === "active"
            ? "In this window"
            : found.target === "agent"
              ? "In the window where an agent runs (or a new one)"
              : "In a new window",
      onSelect: () => run(found),
    })),
    { label: "terminal cheat sheet", separated: true, onSelect: onOpenCheatSheet },
  ];

  return { actions: entries, refresh };
}
