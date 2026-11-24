/** Running an action for a change: the roots its files live in, the facts its text is filled
 * with, and the delivery over the change's terminal.
 *
 * Discovery is per request — a small directory read — so an edit or a new file needs no restart.
 * The client names an action by key and never sends text; the file is resolved again at run
 * time, so the click always runs what is on disk now. */
import { Effect } from "effect";

import { builtinActionBody, discoverActions, type ActionRoots } from "@corvi/actions/node";
import { resolveBriefTemplate, type DiscoveredAction } from "@corvi/actions/discovery";
import { deliverAction, type CandidateWindow, type DeliveryFailure } from "@corvi/actions/deliver";
import { renderActionBody } from "@corvi/actions/render";
import type { ActionSummaryDto, RunActionResultDto } from "@corvi/contracts/actions";
import { BadRequestError } from "@corvi/contracts/errors";
import type { Change } from "@corvi/changes/record";
import { changeDir, factsFor } from "../../change/server/index.ts";
import { settingsOf, workspaceOf } from "../../workspace/server/index.ts";
import { fileRootsFor } from "../../capabilities/fileRoots.ts";
import { ensureActiveHostWindow, listWindows } from "../../terminals/server/index.ts";
import { userHarnessLaunch } from "../../harnesses/server/index.ts";
import { actionSessions } from "../../terminals/server/action-sessions.ts";

/** Where one change's action files live. */
export const actionRootsFor = (change: Change): Effect.Effect<ActionRoots> => fileRootsFor(change, "actions");

const summaryOf = (found: DiscoveredAction): ActionSummaryDto => ({
  key: found.key,
  label: found.action.label,
  kind: found.action.kind,
  target: found.action.target,
  source: found.source,
  sourceLabel: found.sourceLabel,
});

/** The actions this change may run, by phase: an action that names its phases is offered only
 * in them. Everything discoverable is listed otherwise — the menu filters further by the
 * window you are on. */
export const listActionsFor = (change: Change): Effect.Effect<readonly ActionSummaryDto[]> =>
  Effect.gen(function* () {
    const discovery = yield* actionRootsFor(change).pipe(Effect.flatMap(discoverActions));
    const state = change.state ?? "Implementation";
    return discovery.actions
      .filter(
        (found) => found.action.phases === undefined || found.action.phases.some((phase) => phase === state),
      )
      .map(summaryOf);
  });

/** A delivery with nowhere to go, or a write that would not land: both are refusals at the
 * route boundary, not server faults. */
const asBadRequest = (failure: BadRequestError | DeliveryFailure): BadRequestError => {
  if (failure instanceof BadRequestError) return failure;
  if ("_tag" in failure) return new BadRequestError({ message: "no window to run this in" });
  return new BadRequestError({ message: failure.message });
};

/** Run one action of this change. The session is ensured first, as the brief always did, so an
 * action works without opening the terminal first. */
export const runActionFor = (
  change: Change,
  key: string,
  explicitWindow?: string,
): Effect.Effect<RunActionResultDto, BadRequestError> =>
  Effect.gen(function* () {
    if (change.completedAt) {
      return yield* new BadRequestError({ message: "this change is completed: its terminal is gone" });
    }
    const discovery = yield* actionRootsFor(change).pipe(Effect.flatMap(discoverActions));
    const found = discovery.actions.find((a) => a.key === key);
    if (!found) return yield* new BadRequestError({ message: `no such action: ${key}` });
    const state = change.state ?? "Implementation";
    if (found.action.phases !== undefined && !found.action.phases.some((phase) => phase === state)) {
      return yield* new BadRequestError({ message: `"${found.action.label}" is not offered in ${state}` });
    }

    // The brief's text keeps its chain: a `brief.md` that shadows the built-in wins whole, then
    // the legacy `ideationPrompt` setting while it is set, then the shipped body.
    const template =
      found.id === "brief"
        ? resolveBriefTemplate({
            actions: discovery.actions,
            // The settings chain, in this change's scope: the workspace's `ideationPrompt` over
            // the global one (apps/server/src/workspace/server/workspaces.ts).
            ideationPrompt: settingsOf(workspaceOf(change)).ideationPrompt,
            shippedBody: builtinActionBody("brief"),
          })
        : found.action.body;
    const text = renderActionBody(
      template,
      factsFor(change),
      found.action.kind === "command" ? "shell" : "text",
    );

    const dir = changeDir(change);
    // An action run should not be blocked by a harness file that broke since the pane opened: a
    // window it starts then keeps today's environment, and the warning is logged.
    const harness = yield* userHarnessLaunch(change).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          console.error(error.message);
          return undefined;
        }),
      ),
    );
    const harnessEnv = harness?.env;
    // A change with no window at all gets one to deliver into; a window it already has — a
    // subagent's included — is what the action pastes into. Finding the window and opening one
    // are one registry step, so two runs arriving together cannot each open a shell.
    yield* ensureActiveHostWindow(change.id, dir, { cols: 100, rows: 30 }, async () =>
      harness === undefined ? {} : { env: harness.env, harness: harness.key },
    ).pipe(Effect.mapError((failure) => new BadRequestError({ message: failure.message })));
    const windows = yield* listWindows(change.id);
    const candidates: readonly CandidateWindow[] = windows.map((window) => ({
      window: window.id,
      label: window.label,
      kind: window.icon === "agent" ? "agent" : "plain",
      active: window.active,
    }));
    const delivery = yield* deliverAction(actionSessions, {
      changeId: change.id,
      changeDir: dir,
      action: found.action,
      text,
      candidates,
      explicitWindow,
      ...(harnessEnv === undefined ? {} : { env: harnessEnv }),
      ...(harness?.key === undefined ? {} : { harness: harness.key }),
    }).pipe(Effect.mapError((failure) => asBadRequest(failure)));

    return {
      kind: found.action.kind,
      submitted: delivery.submitted,
      started: delivery.started,
      window: delivery.window,
    };
  }).pipe(Effect.mapError((failure) => asBadRequest(failure)));
