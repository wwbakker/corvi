/** The terminal page's menu: the actions this window may run, then the tmux cheat sheet, behind
 * the one button that replaced it.
 *
 * The list is fetched when the menu opens — discovery is per request, so an edited or newly
 * written file shows up on the next open — and the client names an action by key when running
 * one. The text never leaves the machine. After a run the notice names the window it went to,
 * and the keyboard goes back to the terminal (`focusRequest`): every run owes that. */
import { type JSX, useState } from "react";

import { ChangeId } from "@corvi/contracts/changes";
import type { ActionSummaryDto, RunActionResultDto } from "@corvi/contracts/actions";
import type { TerminalWindow } from "../domain/terminal.ts";
import { apiClient } from "../app-root/api.ts";
import { ActionsMenu, type Action } from "../app-root/ActionsMenu.tsx";

/** What kind of window is on screen. The agent kind is the presented icon — the app's
 * presenters read pi's own `@agent_status` for it. */
export type WindowKind = "agent" | "plain";

export const kindOf = (window?: TerminalWindow): WindowKind =>
  window?.icon === "agent" ? "agent" : "plain";

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
  return result.submitted
    ? `Sent to ${where}`
    : `Pasted into ${where} — read it and send it`;
};

export function RunMenu({
  changeId,
  windows,
  onOpenCheatSheet,
  onRan,
}: {
  changeId: string;
  /** This change's windows, so the filter can see what is on screen. */
  windows: TerminalWindow[];
  onOpenCheatSheet: () => void;
  /** The keyboard goes back to the terminal after a run. */
  onRan: () => void;
}): JSX.Element {
  const [actions, setActions] = useState<readonly ActionSummaryDto[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const active = windows.find((w) => w.active);

  const say = (message: string): void => {
    setNotice(message);
    setTimeout(() => setNotice(null), 2500);
  };

  const run = (found: ActionSummaryDto): void => {
    onRan();
    apiClient
      .runAction(ChangeId.make(changeId), found.key, active?.id)
      .then((result) => say(noticeFor(found.label, result)))
      .catch((e: Error) => say(e.message));
  };

  const items: Action[] = [
    ...applicableActions(actions, active).map((found) => ({
      // Workspace and repository actions carry their source ("review — orders-api"), so the
      // same id from two checkouts is two entries, each saying whose it is.
      label:
        found.source === "builtin" || found.source === "global"
          ? found.label
          : `${found.label} — ${found.sourceLabel ?? found.source}`,
      title:
        found.target === "active"
          ? "In this window"
          : found.target === "agent"
            ? "In the window where an agent runs (or a new one)"
            : "In a new window",
      onSelect: () => run(found),
    })),
    { label: "tmux cheat sheet", separated: true, onSelect: onOpenCheatSheet },
  ];

  return (
    <>
      {notice && <span className="summary">{notice}</span>}
      <ActionsMenu
        actions={items}
        onOpen={() =>
          apiClient
            .terminalActions(ChangeId.make(changeId))
            .then(setActions)
            .catch((e: Error) => say(e.message))
        }
      />
    </>
  );
}
