/** The Jira steps at the change's boundaries: the ticket is assigned from the moment it is
 * linked, and moved when the change leaves `Ideation`.
 *
 * Which workspace's Jira applies is the extension's own decision; each step is reported under
 * its name and is never fatal — the change is already written or already started by the time
 * these run.
 */
import { Effect } from "effect";

import { assignIssue, moveIssueOnComplete, moveIssueOnStart } from "@corvi/jira";
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
      Effect.result,
    );
    return [
      assigned._tag === "Success"
        ? { integration: "jira", ok: true, detail: assigned.success.detail }
        : { integration: "jira", ok: false, error: messageOf(assigned.failure) },
    ];
  });

/** The start's ticket step: run when a change first leaves `Ideation` for a manual phase. The
 * transition, and a backlog ticket onto the active sprint. It runs once — the `startedAt` fact on
 * the record is what stops a later departure running it again, not any idempotence of its own:
 * it reassigns, and moves the ticket to the start status when it is not already there (a ticket
 * already done is left alone). No linked ticket is no step at all, matching creation. */
export const startTicket = (change: Change): Effect.Effect<ProvisionResult[]> =>
  Effect.gen(function* () {
    if (!jiraApplies(change) || !ticketOf(change)) return [];
    const workspace = workspaceOf(change);
    const moved = yield* moveIssueOnStart(change).pipe(
      Effect.provide(capabilitiesLayer(workspace, "jira")),
      Effect.result,
    );
    return [
      moved._tag === "Success"
        ? {
            integration: "jira",
            ok: true,
            ...(moved.success.detail ? { detail: moved.success.detail } : {}),
          }
        : { integration: "jira", ok: false, error: messageOf(moved.failure) },
    ];
  });

/** The done move, run again after a start move that lost a race to a completion: a finished
 * change's ticket belongs in its done status whatever order Jira saw the two moves in. No linked
 * ticket is no step at all, matching the other boundaries. */
export const finishTicket = (change: Change): Effect.Effect<ProvisionResult[]> =>
  Effect.gen(function* () {
    if (!jiraApplies(change) || !ticketOf(change)) return [];
    const workspace = workspaceOf(change);
    const moved = yield* moveIssueOnComplete(change).pipe(
      Effect.provide(capabilitiesLayer(workspace, "jira")),
      Effect.result,
    );
    return [
      moved._tag === "Success"
        ? { integration: "jira", ok: true, detail: "moved to done" }
        : { integration: "jira", ok: false, error: messageOf(moved.failure) },
    ];
  });
