/** Shelving: a repository's uncommitted work put aside as a patch in the change, and put back.
 *
 * The workflow composes three owners: the repositories capability captures, discards and applies
 * the work on a concrete checkout; the change's shelf store keeps the patch and its description
 * in the change directory; the change's links say where each repository's checkout is. The order
 * is what keeps it safe — the patch is written and recorded before anything is discarded, and the
 * discard rechecks the checkout against it — so a shelf that exists holds the work, and work
 * that is gone is in a shelf.
 */
import { Context, Effect, Layer } from "effect"

import { ChangeRepositories } from "@corvi/changes/repositories"
import { ChangeService } from "@corvi/changes/changes"
import {
  RepositoryNotFound,
  type ChangeFormatTooNew,
  type ChangeNotFound,
  type ChangeStoreError,
  type RepositoryStoreError,
  type ShelfNotFound,
} from "@corvi/changes/errors"
import { checkoutLocationOf } from "@corvi/changes/rules"
import { ShelfStore } from "@corvi/changes/shelves"
import { RepositoryId, type Change, type ChangeId, type DirectoryName, type Repository } from "@corvi/contracts/changes"
import { AbsolutePath } from "@corvi/contracts/paths"
import {
  SHELF_WARNING_BYTES,
  type ApplyShelfResultDto,
  type ShelfDto,
  type ShelfId,
  type ShelfReason,
  type ShelveResultDto,
} from "@corvi/contracts/shelves"
import { Repositories, type CheckoutError, type NotARepository } from "@corvi/repositories"

import { withCheckoutLock } from "./change-work.ts"

/** What restoring one repository's cancel shelf did. */
export type RestoredShelf = {
  readonly repository: DirectoryName
  readonly shelfId: ShelfId
  readonly outcome: ApplyShelfResultDto
}

type ShelfFailure = ChangeNotFound | RepositoryNotFound | ChangeFormatTooNew | ChangeStoreError | RepositoryStoreError

export interface Interface {
  /** The change's shelves, newest first. */
  readonly listShelves: (changeId: ChangeId) => Effect.Effect<readonly ShelfDto[], ChangeStoreError>
  /** Put one repository's uncommitted work — staged, unstaged and untracked; never ignored files —
   * on a shelf and leave the checkout clean. A patch above `SHELF_WARNING_BYTES` is only kept with
   * `allowLarge`; otherwise the answer names the biggest files and nothing changes. */
  readonly shelveRepository: (input: {
    readonly changeId: ChangeId
    readonly repository: DirectoryName
    readonly reason: ShelfReason
    readonly name?: string
    readonly allowLarge?: boolean
  }) => Effect.Effect<ShelveResultDto, ShelfFailure | NotARepository | CheckoutError>
  /** Put a shelf's work back on its repository's checkout. A clean application removes the shelf;
   * conflicts keep it. Never applied over uncommitted work. */
  readonly applyShelf: (input: {
    readonly changeId: ChangeId
    readonly shelfId: ShelfId
  }) => Effect.Effect<ApplyShelfResultDto, ShelfFailure | ShelfNotFound | NotARepository | CheckoutError>
  readonly deleteShelf: (input: {
    readonly changeId: ChangeId
    readonly shelfId: ShelfId
  }) => Effect.Effect<void, ChangeFormatTooNew | ChangeStoreError>
  /** A shelf's patch, to read what it holds. */
  readonly readShelfPatch: (input: {
    readonly changeId: ChangeId
    readonly shelfId: ShelfId
  }) => Effect.Effect<string, ShelfNotFound | ChangeStoreError>
  /** After a reopen: apply each repository's newest cancel shelf, one repository at a time. A shelf
   * that does not apply cleanly — or whose checkout is not there — stays, with the reason. */
  readonly restoreCancelShelves: (
    changeId: ChangeId,
  ) => Effect.Effect<readonly RestoredShelf[], ShelfFailure | ShelfNotFound | CheckoutError>
}

export class ChangeShelves extends Context.Service<ChangeShelves, Interface>()("corvi/ChangeShelves") {}

/** How many of the biggest files a too-large answer names. */
const LARGEST_SHOWN = 5

const defaultName = (reason: ShelfReason, at: string): string =>
  `${reason === "cancel" ? "Cancelled" : "Shelved"} ${at.slice(0, 16).replace("T", " ")}`

export const layer: Layer.Layer<ChangeShelves, never, ChangeService | ChangeRepositories | Repositories | ShelfStore> =
  Layer.effect(
    ChangeShelves,
    Effect.gen(function* () {
      const changes = yield* ChangeService
      const links = yield* ChangeRepositories
      const repositories = yield* Repositories
      const store = yield* ShelfStore

      const checkoutOf = (
        changeId: ChangeId,
        repository: DirectoryName,
      ): Effect.Effect<{ readonly change: Change; readonly link: Repository; readonly directory: AbsolutePath }, ShelfFailure> =>
        Effect.gen(function* () {
          const change = yield* changes.getChange(changeId)
          const link = (yield* links.listRepositories(changeId)).find((entry) => entry.directoryName === repository)
          if (!link)
            return yield* new RepositoryNotFound({
              changeId,
              repositoryId: RepositoryId.make(`${changeId}:${repository}`),
              message: `${repository} is not one of ${changeId}'s repositories`,
            })
          return { change, link, directory: AbsolutePath.make(checkoutLocationOf(change, link)) }
        })

      const shelveRepository = Effect.fn("ChangeShelves.shelveRepository")(function* (input: {
        readonly changeId: ChangeId
        readonly repository: DirectoryName
        readonly reason: ShelfReason
        readonly name?: string
        readonly allowLarge?: boolean
      }) {
        return yield* withCheckoutLock(
          input.changeId,
          Effect.gen(function* () {
            const { directory } = yield* checkoutOf(input.changeId, input.repository)
            const createdAt = new Date().toISOString()
            const name = input.name?.trim() || defaultName(input.reason, createdAt)
            const prepared = yield* store.prepare({ changeId: input.changeId, repository: input.repository, name })
            // Whatever stops the shelving before the record is written leaves no half shelf.
            const abandon = store.remove(input.changeId, prepared.id)
            const captured = yield* repositories
              .captureWork({ directory, patchFile: prepared.patchFile })
              .pipe(Effect.tapError(() => abandon.pipe(Effect.ignore)))
            if (captured._tag === "Clean") {
              yield* abandon
              return { _tag: "Clean" } satisfies ShelveResultDto
            }
            if (captured._tag === "Conflicted") {
              yield* abandon
              return { _tag: "Conflicted", files: captured.files } satisfies ShelveResultDto
            }
            if (captured.patchBytes > SHELF_WARNING_BYTES && input.allowLarge !== true) {
              yield* abandon
              const largest = [...captured.files].sort((a, b) => b.bytes - a.bytes).slice(0, LARGEST_SHOWN)
              return {
                _tag: "TooLarge",
                patchBytes: captured.patchBytes,
                limitBytes: SHELF_WARNING_BYTES,
                largest,
              } satisfies ShelveResultDto
            }
            const shelf: ShelfDto = {
              id: prepared.id,
              repository: input.repository,
              name,
              reason: input.reason,
              createdAt,
              ...(captured.branch ? { branch: captured.branch } : {}),
              base: captured.base,
              files: captured.files,
              patchBytes: captured.patchBytes,
            }
            yield* store.record(input.changeId, shelf).pipe(Effect.tapError(() => abandon.pipe(Effect.ignore)))
            // The shelf holds the work now; only then does the checkout let go of it, and only if
            // it still holds exactly what was captured.
            const discarded = yield* repositories.discardWork({
              directory,
              patchFile: prepared.patchFile,
              files: captured.files,
            })
            if (discarded._tag === "Changed") {
              yield* abandon
              return { _tag: "Changed", reason: discarded.reason } satisfies ShelveResultDto
            }
            return { _tag: "Shelved", shelf } satisfies ShelveResultDto
          }),
        )
      })

      const applyUnlocked = (
        changeId: ChangeId,
        shelfId: ShelfId,
      ): Effect.Effect<ApplyShelfResultDto, ShelfFailure | ShelfNotFound | NotARepository | CheckoutError> =>
        Effect.gen(function* () {
          const { shelf, patchFile } = yield* store.find(changeId, shelfId)
          const { directory } = yield* checkoutOf(changeId, shelf.repository)
          const outcome = yield* repositories.applyWork({ directory, patchFile })
          if (outcome._tag === "Applied") yield* store.remove(changeId, shelfId)
          return outcome
        })

      const applyShelf = Effect.fn("ChangeShelves.applyShelf")(function* (input: {
        readonly changeId: ChangeId
        readonly shelfId: ShelfId
      }) {
        return yield* withCheckoutLock(input.changeId, applyUnlocked(input.changeId, input.shelfId))
      })

      const restoreCancelShelves = Effect.fn("ChangeShelves.restoreCancelShelves")(function* (changeId: ChangeId) {
        return yield* withCheckoutLock(
          changeId,
          Effect.gen(function* () {
            // Newest first, so the first per repository is the one the last cancel made.
            const newest = new Map<DirectoryName, ShelfDto>()
            for (const shelf of yield* store.list(changeId)) {
              if (shelf.reason === "cancel" && !newest.has(shelf.repository)) newest.set(shelf.repository, shelf)
            }
            const restored: RestoredShelf[] = []
            for (const shelf of newest.values()) {
              // A repository whose checkout could not be made keeps its shelf for later.
              const outcome = yield* applyUnlocked(changeId, shelf.id).pipe(
                Effect.catchTag("NotARepository", (error) =>
                  Effect.succeed({
                    _tag: "Rejected",
                    reason: `there is no checkout at ${error.directory} to apply it to`,
                  } satisfies ApplyShelfResultDto),
                ),
              )
              restored.push({ repository: shelf.repository, shelfId: shelf.id, outcome })
            }
            return restored
          }),
        )
      })

      return {
        listShelves: (changeId) => store.list(changeId),
        shelveRepository,
        applyShelf,
        deleteShelf: ({ changeId, shelfId }) => store.remove(changeId, shelfId),
        readShelfPatch: ({ changeId, shelfId }) => store.readPatch(changeId, shelfId),
        restoreCancelShelves,
      }
    }),
  )
