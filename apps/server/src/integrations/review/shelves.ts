/** The review tab's shelves: a repository's uncommitted work put aside and put back, through the
 * shelving workflow. The tab asks; `@corvi/workflows/shelves` does the work over the change's own
 * shelf store and the repositories capability, and this module only translates. */
import { Effect } from "effect";

import { ChangeId, DirectoryName } from "@corvi/contracts/changes";
import { BadRequestError, ConflictError, NotFoundError, type IweError } from "@corvi/contracts/errors";
import { ShelfId, type ApplyShelfResultDto, type ShelfDto, type ShelveBodyDto, type ShelveResultDto } from "@corvi/contracts/shelves";
import { ChangeShelves } from "@corvi/workflows/shelves";
import type { Change } from "@corvi/changes/record";
import { changeShelvesLayer } from "../../change/lifecycle-layer.ts";
import { changePairs } from "../../change/server/index.ts";

/** The workflow's failures in the route taxonomy. */
const asIwe = (error: { readonly _tag: string; readonly message: string }): IweError => {
  switch (error._tag) {
    case "ChangeNotFound":
    case "RepositoryNotFound":
    case "ShelfNotFound":
      return new NotFoundError({ message: error.message });
    case "ChangeFormatTooNew":
      return new ConflictError({ message: error.message });
    case "NotARepository":
      return new BadRequestError({ message: "the repository has no checkout to shelve" });
    default:
      return new BadRequestError({ message: error.message || error._tag });
  }
};

const withShelves = <A>(
  work: (shelves: ChangeShelves["Service"]) => Effect.Effect<A, { readonly _tag: string; readonly message: string }>,
): Effect.Effect<A, IweError> =>
  Effect.gen(function* () {
    return yield* work(yield* ChangeShelves);
  }).pipe(
    Effect.mapError(asIwe),
    Effect.provide(changeShelvesLayer(changePairs())),
  );

/** A finished change's shelves are a record: they are read, never applied or removed from here. */
const editable = (change: Change): Effect.Effect<void, BadRequestError> =>
  change.completedAt
    ? Effect.fail(new BadRequestError({ message: "this change is finished: reopen it to use its shelves" }))
    : Effect.void;

export const listShelves = (change: Change): Effect.Effect<readonly ShelfDto[], IweError> =>
  withShelves((shelves) => shelves.listShelves(ChangeId.make(change.id)));

export const shelveRepository = (change: Change, body: ShelveBodyDto): Effect.Effect<ShelveResultDto, IweError> =>
  Effect.andThen(
    editable(change),
    withShelves((shelves) =>
      shelves.shelveRepository({
        changeId: ChangeId.make(change.id),
        repository: DirectoryName.make(body.repository),
        reason: "manual",
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.allowLarge !== undefined ? { allowLarge: body.allowLarge } : {}),
      }),
    ),
  );

export const applyShelf = (change: Change, shelf: string): Effect.Effect<ApplyShelfResultDto, IweError> =>
  Effect.andThen(
    editable(change),
    withShelves((shelves) => shelves.applyShelf({ changeId: ChangeId.make(change.id), shelfId: ShelfId.make(shelf) })),
  );

export const deleteShelf = (change: Change, shelf: string): Effect.Effect<void, IweError> =>
  Effect.andThen(
    editable(change),
    withShelves((shelves) => shelves.deleteShelf({ changeId: ChangeId.make(change.id), shelfId: ShelfId.make(shelf) })),
  );

export const shelfPatch = (change: Change, shelf: string): Effect.Effect<string, IweError> =>
  withShelves((shelves) => shelves.readShelfPatch({ changeId: ChangeId.make(change.id), shelfId: ShelfId.make(shelf) }));
