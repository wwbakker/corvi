/** Shelves: a repository's uncommitted work put aside as a patch, kept in the change directory so
 * it travels into the archive and back. The schemas are the wire shapes the review tab and the
 * lifecycle's reports share. */
import { Schema } from "effect"

import { DirectoryName } from "./changes.ts"

/** A shelf's identity within its change: `<repository>/<stamp>-<slug>`. */
export const ShelfId = Schema.String.pipe(Schema.brand("corvi/ShelfId"))
export type ShelfId = typeof ShelfId.Type

/** Why a shelf exists: put aside by hand from the review tab, or by cancelling the change, which
 * is the shelf reopening applies. */
export const ShelfReason = Schema.Literals(["manual", "cancel"])
export type ShelfReason = typeof ShelfReason.Type

export const ShelvedFileSchema = Schema.Struct({
  path: Schema.String,
  change: Schema.Literals(["modified", "added", "deleted", "renamed", "untracked", "conflicted"]),
  /** Size on disk when it was shelved; 0 for a deletion. */
  bytes: Schema.Number,
})
export type ShelvedFileDto = typeof ShelvedFileSchema.Type

export const ShelfSchema = Schema.Struct({
  id: ShelfId,
  /** The change's repository it was taken from, by the directory name the change files it under. */
  repository: DirectoryName,
  name: Schema.String,
  reason: ShelfReason,
  createdAt: Schema.String,
  /** The branch the checkout was on; absent for a detached HEAD. */
  branch: Schema.optional(Schema.String),
  /** The commit the patch is against. */
  base: Schema.String,
  files: Schema.Array(ShelvedFileSchema),
  patchBytes: Schema.Number,
})
export type ShelfDto = typeof ShelfSchema.Type

/** Above this a shelf is only made when asked twice: a patch this big is usually build output
 * that should have been ignored. */
export const SHELF_WARNING_BYTES = 50 * 1024 * 1024

export const ShelveBodySchema = Schema.Struct({
  repository: Schema.String,
  name: Schema.optional(Schema.String),
  /** Shelve even above `SHELF_WARNING_BYTES`. */
  allowLarge: Schema.optional(Schema.Boolean),
})
export type ShelveBodyDto = typeof ShelveBodySchema.Type

/** What shelving did. Only `Shelved` changed the checkout; every other answer left it exactly as
 * it was. */
export const ShelveResultSchema = Schema.Union([
  Schema.TaggedStruct("Shelved", { shelf: ShelfSchema }),
  Schema.TaggedStruct("Clean", {}),
  Schema.TaggedStruct("TooLarge", {
    patchBytes: Schema.Number,
    limitBytes: Schema.Number,
    largest: Schema.Array(ShelvedFileSchema),
  }),
  Schema.TaggedStruct("Changed", { reason: Schema.String }),
  Schema.TaggedStruct("Conflicted", { files: Schema.Array(Schema.String) }),
])
export type ShelveResultDto = typeof ShelveResultSchema.Type

/** What applying a shelf did. `Applied` removed the shelf; `Conflicts` kept it and left conflict
 * markers; `NotClean` and `Rejected` changed nothing. */
export const ApplyShelfResultSchema = Schema.Union([
  Schema.TaggedStruct("Applied", {}),
  Schema.TaggedStruct("Conflicts", { files: Schema.Array(Schema.String) }),
  Schema.TaggedStruct("NotClean", { files: Schema.Array(Schema.String) }),
  Schema.TaggedStruct("Rejected", { reason: Schema.String }),
])
export type ApplyShelfResultDto = typeof ApplyShelfResultSchema.Type

export const ShelfListSchema = Schema.Array(ShelfSchema)
