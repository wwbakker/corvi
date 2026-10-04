/** The Jira steps at the change's boundaries: the ticket is assigned from the moment it is
 * linked, and moved when work starts.
 *
 * Which workspace's Jira applies is the extension's own decision; each step is reported under
 * its name and is never fatal — the change is already written or already started by the time
 * these run.
 */
import { Effect } from "effect";

import { assignIssue, moveIssueOnStart } from "@corvi/jira";
import { ticketOf } from "@corvi/jira/jira";
import { messageOf } from "../capabilities/effect/support.ts";
import { extensionsFor } from "../integrations/selectors.ts";
import { capabilitiesLayer } from "../integrations/services.ts";
import type { Change, ProvisionResult } from "@corvi/changes/record";
import { workspaceOf } from "../workspace/server/index.ts";

// Pure and synchronous: nothing for an Effect to wrap.
const jiraApplies = (change: Change): boolean =>
  extensionsFor(workspaceOf(change)).some((extension) => extension.name === "jira");

/** Creation's ticket step: a linked ticket is assigned to me right away, not at the start. No
 * linked ticket is no step at all — not a step that did nothing. */
export const assignTicketOnCreate = (change: Change): Effect.Effect<ProvisionResult[]> =>
  Effect.gen(function* () {
    if (!jiraApplies(change) || !ticketOf(change)) return [];
    const workspace = workspaceOf(change);
    const assigned = yield* assignIssue(change).pipe(
      Effect.provide(capabilitiesLayer(workspace, "jira")),
      Effect.either,
    );
    return [
      assigned._tag === "Right"
        ? { integration: "jira", ok: true, detail: assigned.right.detail }
        : { integration: "jira", ok: false, error: messageOf(assigned.left) },
    ];
  });

/** Start's ticket step: the transition, and a backlog ticket onto the active sprint. No linked
 * ticket is no step at all, matching creation. */
export const startTicket = (change: Change): Effect.Effect<ProvisionResult[]> =>
  Effect.gen(function* () {
    if (!jiraApplies(change) || !ticketOf(change)) return [];
    const workspace = workspaceOf(change);
    const moved = yield* moveIssueOnStart(change).pipe(
      Effect.provide(capabilitiesLayer(workspace, "jira")),
      Effect.either,
    );
    return [
      moved._tag === "Right"
        ? {
            integration: "jira",
            ok: true,
            ...(moved.right.detail ? { detail: moved.right.detail } : {}),
          }
        : { integration: "jira", ok: false, error: messageOf(moved.left) },
    ];
  });
