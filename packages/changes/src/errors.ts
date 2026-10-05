/** Capability errors for changes and their repository links. Every one of them carries the
 * sentence the user sees (`messageOf`, `formatError`): an error without one reaches a transport
 * boundary as an empty string, which is rendered as the error's type name instead. */
import { Schema } from "effect"

import { ChangeId, ChangePhase, DirectoryName, RepositoryId } from "@corvi/contracts/changes"

export class ChangeNotFound extends Schema.TaggedError<ChangeNotFound>()("ChangeNotFound", {
  changeId: ChangeId,
  message: Schema.String,
}) {}

export class ChangeIdTaken extends Schema.TaggedError<ChangeIdTaken>()("ChangeIdTaken", {
  changeId: ChangeId,
  message: Schema.String,
}) {}

export class InvalidTransition extends Schema.TaggedError<InvalidTransition>()("InvalidTransition", {
  changeId: ChangeId,
  from: ChangePhase,
  to: ChangePhase,
  message: Schema.String,
}) {}

export class ChangeConflict extends Schema.TaggedError<ChangeConflict>()("ChangeConflict", {
  changeId: ChangeId,
  expected: Schema.Number,
  actual: Schema.Number,
  message: Schema.String,
}) {}

export class ChangeStoreError extends Schema.TaggedError<ChangeStoreError>()("ChangeStoreError", {
  /** Absent for store-wide operations such as listing the changes root. */
  changeId: Schema.optional(ChangeId),
  operation: Schema.Literals(["read", "write"]),
  message: Schema.String,
  // The cause is an opaque in-process throwable that is never serialized; `Schema.Unknown`
  // preserves it exactly (on decode `Schema.Defect()` is lossy).
  cause: Schema.optional(Schema.Unknown),
}) {}

/** The record was written by a newer Corvi: it is read best-effort, but nothing writes it — a
 * format this version does not understand must not be flattened into one it does. */
export class ChangeFormatTooNew extends Schema.TaggedError<ChangeFormatTooNew>()(
  "ChangeFormatTooNew",
  {
    changeId: ChangeId,
    recordFormat: Schema.Number,
    appFormat: Schema.Number,
    message: Schema.String,
  },
) {}

export class RepositoryNotFound extends Schema.TaggedError<RepositoryNotFound>()(
  "RepositoryNotFound",
  {
    changeId: ChangeId,
    repositoryId: RepositoryId,
    message: Schema.String,
  },
) {}

export class DuplicateDirectoryName extends Schema.TaggedError<DuplicateDirectoryName>()(
  "DuplicateDirectoryName",
  {
    changeId: ChangeId,
    directoryName: DirectoryName,
    message: Schema.String,
  },
) {}

export class RepositoryStoreError extends Schema.TaggedError<RepositoryStoreError>()(
  "RepositoryStoreError",
  {
    changeId: ChangeId,
    operation: Schema.Literals(["read", "write"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}
