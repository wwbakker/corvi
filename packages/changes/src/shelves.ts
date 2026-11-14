/** The shelf store port: a change's put-aside work, kept in its directory. */
import { Context, type Effect } from "effect"

import type { ChangeId, DirectoryName } from "@corvi/contracts/changes"
import type { AbsolutePath } from "@corvi/contracts/paths"
import type { ShelfDto, ShelfId } from "@corvi/contracts/shelves"
import type { ChangeFormatTooNew, ChangeNotFound, ChangeStoreError, ShelfNotFound } from "./errors.ts"

/** Where a new shelf's patch is to be written, before the shelf exists. */
export type PreparedShelf = {
  readonly id: ShelfId
  readonly patchFile: AbsolutePath
}

/**
 * Shelves live in the change directory, `shelves/<repository>/<stamp>-<slug>/`: a `shelf.json`
 * describing it and the `changes.patch` it holds. A shelf exists once its description is
 * recorded — a prepared directory with only a patch is not listed, so a capture that stopped half
 * way never looks like work that can be applied.
 */
export interface ShelfStoreInterface {
  /** Reserve a new shelf's directory and name the file its patch goes to. */
  readonly prepare: (input: {
    readonly changeId: ChangeId
    readonly repository: DirectoryName
    readonly name: string
  }) => Effect.Effect<PreparedShelf, ChangeNotFound | ChangeFormatTooNew | ChangeStoreError>
  /** Record the shelf's description beside its patch; from here on it is listed. */
  readonly record: (changeId: ChangeId, shelf: ShelfDto) => Effect.Effect<void, ChangeFormatTooNew | ChangeStoreError>
  /** The recorded shelves, newest first. A change without any — or without a directory — has none. */
  readonly list: (changeId: ChangeId) => Effect.Effect<readonly ShelfDto[], ChangeStoreError>
  /** One recorded shelf and where its patch is. */
  readonly find: (
    changeId: ChangeId,
    shelfId: ShelfId,
  ) => Effect.Effect<{ readonly shelf: ShelfDto; readonly patchFile: AbsolutePath }, ShelfNotFound | ChangeStoreError>
  /** The patch's text, for reading it. */
  readonly readPatch: (changeId: ChangeId, shelfId: ShelfId) => Effect.Effect<string, ShelfNotFound | ChangeStoreError>
  /** Remove a shelf — recorded or only prepared — and its patch. A shelf that is not there is
   * already removed. */
  readonly remove: (changeId: ChangeId, shelfId: ShelfId) => Effect.Effect<void, ChangeFormatTooNew | ChangeStoreError>
}

export class ShelfStore extends Context.Service<ShelfStore, ShelfStoreInterface>()("corvi/ShelfStore") {}
