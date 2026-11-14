/** Reopening a cancelled change: back from the archive, its checkouts made again, and the work
 * cancelling shelved put back on them.
 *
 * Three steps, in the order a failure is easiest to stand in: the lifecycle moves the change back
 * (the record and its directory, nothing else), the checkout run every creation and start uses
 * provisions the worktrees on the kept branches, and the cancel shelves are applied to them. A
 * checkout that could not be made, or a shelf that does not apply cleanly, is reported on a change
 * that is already reopened — the shelf stays, and nothing is ever rebased or reset to fit it.
 */
import { Effect, Layer } from "effect";

import { ChangeId } from "@corvi/contracts/changes";
import { ConflictError, isIweError, BadRequestError, NotFoundError, type IweError } from "@corvi/contracts/errors";
import type { ApplyShelfResultDto } from "@corvi/contracts/shelves";
import { ChangeLifecycle } from "@corvi/workflows/lifecycle";
import { ChangeShelves } from "@corvi/workflows/shelves";
import type { Change, ProvisionResult } from "@corvi/changes/record";
import { messageOf } from "../../capabilities/effect/support.ts";
import { workspaceOf } from "../../workspace/server/index.ts";
import { changeShelvesLayer, lifecycleLayer } from "../lifecycle-layer.ts";
import { provisionRepositories, type RefreshOutcome } from "../provisioning.ts";
import { changePairs, readChange } from "./store.ts";

/** What restoring one repository's cancel shelf did. */
export type RestoredShelf = { readonly repository: string; readonly outcome: ApplyShelfResultDto };

export type Reopened = {
  readonly change: Change;
  readonly provision: readonly ProvisionResult[];
  readonly refresh: readonly RefreshOutcome[];
  readonly restored: readonly RestoredShelf[];
};

/** The transport boundary for the workflow's errors. */
const asIwe = (error: unknown): IweError => {
  if (isIweError(error)) return error;
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tag = String((error as { _tag: unknown })._tag);
    const raw = "message" in error ? (error as { message: unknown }).message : undefined;
    const message = raw ? String(raw) : tag;
    if (tag === "InvalidTransition" || tag === "ChangeConflict" || tag === "ChangeFormatTooNew" || tag === "ChangeOperationInProgress")
      return new ConflictError({ message });
    if (tag === "ChangeNotFound" || tag === "RepositoryNotFound" || tag === "ShelfNotFound")
      return new NotFoundError({ message });
    return new BadRequestError({ message });
  }
  return new BadRequestError({ message: messageOf(error) });
};

export const reopenChange = (change: Change): Effect.Effect<Reopened, IweError> => {
  const roots = changePairs();
  const changeId = ChangeId.make(change.id);
  return Effect.gen(function* () {
    const lifecycle = yield* ChangeLifecycle;
    const shelves = yield* ChangeShelves;
    yield* lifecycle.reopenChange(changeId);
    const reopened = yield* readChange(change.id);
    if (!reopened) return yield* new NotFoundError({ message: `${change.id} could not be read back after reopening` });

    const run = yield* provisionRepositories(reopened);
    const restored = yield* shelves.restoreCancelShelves(changeId);
    return {
      change: (yield* readChange(change.id)) ?? reopened,
      provision: run.provision,
      refresh: run.refresh,
      restored: restored.map((entry) => ({ repository: entry.repository, outcome: entry.outcome })),
    } satisfies Reopened;
  }).pipe(
    Effect.mapError(asIwe),
    Effect.provide(Layer.merge(lifecycleLayer(workspaceOf(change), roots), changeShelvesLayer(roots))),
  );
};
