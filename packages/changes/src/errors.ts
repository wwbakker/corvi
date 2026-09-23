/** Capability errors for changes and their repository links. Every one of them carries the
 * sentence the user sees (`messageOf`, `formatError`): an error without one reaches a transport
 * boundary as an empty string, which is rendered as the error's type name instead. */
import { Data } from "effect"

import type { ChangeId, ChangePhase, DirectoryName, RepositoryId } from "@corvi/contracts/changes"

export class ChangeNotFound extends Data.TaggedError("ChangeNotFound")<{
  readonly changeId: ChangeId
  readonly message: string
}> {}

export class ChangeIdTaken extends Data.TaggedError("ChangeIdTaken")<{
  readonly changeId: ChangeId
  readonly message: string
}> {}

export class InvalidTransition extends Data.TaggedError("InvalidTransition")<{
  readonly changeId: ChangeId
  readonly from: ChangePhase
  readonly to: ChangePhase
  readonly message: string
}> {}

export class ChangeConflict extends Data.TaggedError("ChangeConflict")<{
  readonly changeId: ChangeId
  readonly expected: number
  readonly actual: number
  readonly message: string
}> {}

export class ChangeStoreError extends Data.TaggedError("ChangeStoreError")<{
  /** Absent for store-wide operations such as listing the changes root. */
  readonly changeId?: ChangeId
  readonly operation: "read" | "write"
  readonly message: string
  readonly cause?: unknown
}> {}

/** The record was written by a newer Corvi: it is read best-effort, but nothing writes it — a
 * format this version does not understand must not be flattened into one it does. */
export class ChangeFormatTooNew extends Data.TaggedError("ChangeFormatTooNew")<{
  readonly changeId: ChangeId
  readonly recordFormat: number
  readonly appFormat: number
  readonly message: string
}> {}

export class RepositoryNotFound extends Data.TaggedError("RepositoryNotFound")<{
  readonly changeId: ChangeId
  readonly repositoryId: RepositoryId
  readonly message: string
}> {}

export class DuplicateDirectoryName extends Data.TaggedError("DuplicateDirectoryName")<{
  readonly changeId: ChangeId
  readonly directoryName: DirectoryName
  readonly message: string
}> {}

export class RepositoryStoreError extends Data.TaggedError("RepositoryStoreError")<{
  readonly changeId: ChangeId
  readonly operation: "read" | "write"
  readonly message: string
  readonly cause?: unknown
}> {}
