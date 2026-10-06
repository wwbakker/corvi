/** The machine's own agents, read for the power monitor and the control.
 *
 * Both read this one list, so the countdown waits on exactly what the control shows. A read
 * failure propagates rather than becoming an empty list: the monitor treats a failed read as
 * "not quiet", and an empty list would read as "no agents" and power the machine off.
 *
 * The reads are strict on purpose. The page's best-effort reads (`allWindows`, `listSubagents`)
 * fold a failure into an empty result, which is right for a page but fatal here; this reads the
 * change list once and then `listWindows`/`listSubagentsStrict` per change, so a failure to see
 * an agent skips the tick instead of counting as quiet.
 */
import { Effect } from "effect";

import type { PowerAgent } from "@corvi/contracts/power";

import { listChangesStrict } from "../../change/server/index.ts";
import { listSubagentsStrict } from "../../subagents/server/instances.ts";
import { listWindows } from "../../terminals/server/index.ts";
import { agentStates } from "../rule.ts";

/** Every agent across the machine's local changes: the presented windows plus each change's
 * subagent views, folded by the shared rule. */
export const localAgents = (): Effect.Effect<readonly PowerAgent[], unknown> =>
  Effect.gen(function* () {
    const changes = yield* listChangesStrict();
    const perChange = yield* Effect.forEach(
      changes,
      (change) =>
        Effect.all({
          windows: listWindows(change.id),
          subagents: listSubagentsStrict(change),
        }),
      { concurrency: "unbounded" },
    );
    return agentStates(
      perChange.flatMap((entry) => entry.windows),
      perChange.flatMap((entry) => entry.subagents),
    );
  });
