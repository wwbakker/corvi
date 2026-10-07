/** The quiet rule: which agents still block a machine from powering down, and the agent list the
 * control shows.
 *
 * Pure, and shared by the arm control and the monitor, so what the control shows is exactly what
 * the power-off waits on. It reads the presented windows and the subagent views — the same
 * shapes the pages get — rather than the raw host state.
 */
import type { PowerAgent } from "@corvi/contracts/power";
import type { SubagentInstanceDto } from "@corvi/contracts/subagents";

import type { PresentedWindow } from "../terminals/server/index.ts";

/** Every agent on the machine, each marked by whether it is working. A window is an agent when
 * its presenter says so explicitly (`agent`), never by its glyph or name; subagents come from
 * their own views, whose derived `activity` folds in the stored `inFlight` while a live window
 * carries them — an interrupted (detached) turn reads idle, since it can never settle. A plain
 * shell and a waiting or finished agent are listed but not working. */
export const agentStates = (
  windows: readonly PresentedWindow[],
  subagents: readonly SubagentInstanceDto[],
): readonly PowerAgent[] => [
  ...windows
    .filter((window) => window.agent)
    .map((window): PowerAgent => ({ label: window.label, working: window.working })),
  ...subagents.map(
    (subagent): PowerAgent => ({
      label: subagent.label,
      working: subagent.activity === "working",
    }),
  ),
];

/** The labels of the agents in `agents` that are working: what the control names as blockers. */
export const agentBlockers = (agents: readonly PowerAgent[]): readonly string[] =>
  agents.filter((agent) => agent.working).map((agent) => agent.label);

/** Whether nothing is working: the machine may count down. No agents at all is quiet. */
export const isQuiet = (agents: readonly PowerAgent[]): boolean =>
  agents.every((agent) => !agent.working);
