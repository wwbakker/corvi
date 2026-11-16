/** The review tab's shelves: a repository's uncommitted work put aside and put back, through the
 * shelving workflow. The tab asks; `@corvi/workflows/shelves` does the work over the change's own
 * shelf store and the repositories capability, and this module only translates. */
import { Effect } from "effect";

import { ChangeId, DirectoryName } from "@corvi/contracts/changes";
import { BadRequestError, type CorviError } from "@corvi/contracts/errors";
import {
  ShelfId,
  type ApplyShelfResultDto,
  type ShelfDto,
  type ShelveBodyDto,
  type ShelveResultDto,
} from "@corvi/contracts/shelves";
import { ChangeShelves } from "@corvi/workflows/shelves";
import type { Change } from "@corvi/changes/record";
import { changeShelvesLayer } from "../../change/lifecycle-layer.ts";
import { changePairs } from "../../change/server/index.ts";
import { asCorviError as asCorviErrorBase } from "../../capabilities/effect/http.ts";

/** The workflow's failures in the route taxonomy. */
const asCorviError = (error: { readonly _tag: string; readonly message: string }): CorviError =>
  error._tag === "NotARepository"
    ? new BadRequestError({ message: "the repository has no checkout to shelve" })
    : asCorviErrorBase(error, {
        notFound: ["ChangeNotFound", "RepositoryNotFound", "ShelfNotFound"],
        conflict: ["ChangeFormatTooNew"],
      });

const withShelves = <A>(
  work: (
    shelves: ChangeShelves["Service"],
  ) => Effect.Effect<A, { readonly _tag: string; readonly message: string }>,
): Effect.Effect<A, CorviError> =>
  Effect.gen(function* () {
    return yield* work(yield* ChangeShelves);
  }).pipe(Effect.mapError(asCorviError), Effect.provide(changeShelvesLayer(changePairs())));

/** A finished change's shelves are a record: they are read, never applied or removed from here. */
const editable = (change: Change): Effect.Effect<void, BadRequestError> =>
  change.completedAt
    ? Effect.fail(new BadRequestError({ message: "this change is finished: reopen it to use its shelves" }))
    : Effect.void;

export const listShelves = (change: Change): Effect.Effect<readonly ShelfDto[], CorviError> =>
  withShelves((shelves) => shelves.listShelves(ChangeId.make(change.id)));

export const shelveRepository = (
  change: Change,
  body: ShelveBodyDto,
): Effect.Effect<ShelveResultDto, CorviError> =>
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

export const applyShelf = (change: Change, shelf: string): Effect.Effect<ApplyShelfResultDto, CorviError> =>
  Effect.andThen(
    editable(change),
    withShelves((shelves) =>
      shelves.applyShelf({ changeId: ChangeId.make(change.id), shelfId: ShelfId.make(shelf) }),
    ),
  );

export const deleteShelf = (change: Change, shelf: string): Effect.Effect<void, CorviError> =>
  Effect.andThen(
    editable(change),
    withShelves((shelves) =>
      shelves.deleteShelf({ changeId: ChangeId.make(change.id), shelfId: ShelfId.make(shelf) }),
    ),
  );

export const shelfPatch = (change: Change, shelf: string): Effect.Effect<string, CorviError> =>
  withShelves((shelves) =>
    shelves.readShelfPatch({ changeId: ChangeId.make(change.id), shelfId: ShelfId.make(shelf) }),
  );
