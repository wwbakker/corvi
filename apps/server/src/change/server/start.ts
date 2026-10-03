import { Effect } from "effect";

import { ChangeId } from "@corvi/contracts/changes";
import { ChangeWork, withCheckoutLock } from "@corvi/workflows";
import {
  BadRequestError,
  ConflictError,
  isIweError,
  type IweError,
} from "@corvi/contracts/errors";
import { messageOf } from "../../capabilities/effect/support.ts";
import { type Change, type ProvisionResult } from "../../domain/change.ts";
import {
  finishCheckouts,
  prepareCheckouts,
  type RefreshOutcome,
} from "../provisioning.ts";
import { startTicket } from "../tickets.ts";
import { changeWorkLayer } from "../lifecycle-layer.ts";
import { changePairs, readChange } from "./store.ts";

/** What a workflow start produced: the started record, the per-target report the page shows,
 * and what each repository's refresh did. */
export type Started = {
  readonly change: Change;
  readonly provision: ProvisionResult[];
  readonly refresh: RefreshOutcome[];
};

/** The transport boundary for a workflow error: conflicts stay conflicts, everything else is the
 * taxonomy the route mapper knows. */
const asIwe = (change: Change, error: unknown): IweError => {
  if (isIweError(error)) return error;
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tag = String((error as { _tag: unknown })._tag);
    const raw = "message" in error ? (error as { message: unknown }).message : undefined;
    if (tag === "InvalidTransition") {
      return new ConflictError({
        message: `${change.id} has already started (${change.state ?? "Implementation"})`,
      });
    }
    // Our typed errors carry the sentence the user sees; the tag is a last resort for a
    // foreign tagged error, never the first choice — it would show the page the type name.
    return new BadRequestError({ message: raw ? String(raw) : tag });
  }
  return new BadRequestError({ message: messageOf(error) });
};

/**
 * Start the work through the workflow: the phase moves first (persisted, so a start that fails
 * part way leaves something to fix), then every checkout is provisioned and refreshed by the one
 * policy, with the presence the change directory reads through placed around it — the same run a
 * creation makes, so an idea's worktree and a started one cannot differ. A refresh that could
 * not fast-forward reports and continues; it never blocks the transition and never rewrites a
 * branch. The configured ticket move runs afterwards, reported under its own name, never fatal.
 */
const startBody = (change: Change): Effect.Effect<Started, IweError> =>
  Effect.gen(function* () {
    const work = yield* ChangeWork;

    // The checkout critical section — presence, the workflow's run, the reports — under this
    // change's lock, so a creation or an edit racing it cannot meet a half-made checkout.
    const run = yield* withCheckoutLock(
      ChangeId.make(change.id),
      Effect.gen(function* () {
        // The presence first: a browse link at a worktree's destination would make the
        // provisioning below read it as the checkout it is about to create.
        yield* prepareCheckouts(change, change.checkouts ?? []);

        const outcome = yield* work
          .startChange(ChangeId.make(change.id))
          .pipe(
            Effect.catchAll((error): Effect.Effect<never, IweError> => Effect.fail(asIwe(change, error))),
          );

        return yield* finishCheckouts(change, outcome.reports);
      }),
    );

    // The ticket move is somebody else's HTTP and holds no lock: a slow Jira must not block
    // this change's checkouts.
    const updated = (yield* readChange(change.id)) ?? change;
    const jira = yield* startTicket(updated);

    return {
      change: updated,
      provision: [...run.provision, ...jira],
      refresh: [...run.refresh],
    };
  }).pipe(Effect.provide(changeWorkLayer(changePairs())));

/** Start the work: the checkout run under this change's checkout lock — and the ticket move
 * outside it. */
export const startChangeWithWorkflow = (change: Change): Effect.Effect<Started, IweError> =>
  startBody(change);
