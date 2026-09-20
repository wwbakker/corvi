/** Design prototype: change records, repository links, and their pure rules. */
import { Data, Schema } from "effect"

import { join } from "./paths.ts"

export const ChangeId = Schema.String.pipe(Schema.brand("corvi/ChangeId"))
export type ChangeId = typeof ChangeId.Type

export const ChangePhase = Schema.Literal(
  "Ideation",
  "Implementation",
  "Verification",
  "Blocked",
  "Completed",
  "Cancelled",
)
export type ChangePhase = typeof ChangePhase.Type

export class Change extends Schema.Class<Change>("Change")({
  changeId: ChangeId,
  title: Schema.String,
  workspaceLocation: Schema.String,
  branch: Schema.String,
  phase: ChangePhase,
  createdAt: Schema.String,
  completedAt: Schema.optional(Schema.String),
}) {}

export type ChangeFilter = "Active" | "Archived"

export type CreateChangeInput = {
  readonly changeId: ChangeId
  readonly title: string
  readonly workspaceLocation: string
  readonly branch?: string
  readonly phase?: ChangePhase
}

export class ChangeNotFound extends Data.TaggedError("ChangeNotFound")<{
  readonly changeId: ChangeId
}> {}

export class ChangeIdTaken extends Data.TaggedError("ChangeIdTaken")<{
  readonly changeId: ChangeId
}> {}

export class InvalidTransition extends Data.TaggedError("InvalidTransition")<{
  readonly changeId: ChangeId
  readonly from: ChangePhase
  readonly to: ChangePhase
}> {}

export class ChangeConflict extends Data.TaggedError("ChangeConflict")<{
  readonly changeId: ChangeId
  readonly expected: number
  readonly actual: number
}> {}

export class ChangeStoreError extends Data.TaggedError("ChangeStoreError")<{
  readonly changeId: ChangeId
  readonly operation: "read" | "write"
  readonly message: string
  readonly cause?: unknown
}> {}

export const isTerminal = (phase: ChangePhase): boolean =>
  phase === "Completed" || phase === "Cancelled"

export const isFinished = (change: Pick<Change, "phase">): boolean => isTerminal(change.phase)

/** `Ideation` only leaves for `Implementation`; the manual phases move among themselves,
 * and the complete/cancel workflows enter the terminal phases. */
export const allowedTransition = (from: ChangePhase, to: ChangePhase): boolean => {
  if (from === to) return false
  if (isTerminal(from)) return false
  if (from === "Ideation") return to === "Implementation"
  return true
}

export const RepositoryId = Schema.String.pipe(Schema.brand("corvi/RepositoryId"))
export type RepositoryId = typeof RepositoryId.Type

export const DirectoryName = Schema.String.pipe(Schema.brand("corvi/DirectoryName"))
export type DirectoryName = typeof DirectoryName.Type

export const CheckoutMethod = Schema.Literal(
  "UseOriginalLocationOriginalBranch",
  "UseOriginalLocationNewBranch",
  "UseNewLocationNewBranch",
)
export type CheckoutMethod = typeof CheckoutMethod.Type

export class Repository extends Schema.Class<Repository>("Repository")({
  changeId: ChangeId,
  repositoryId: RepositoryId,
  directoryName: DirectoryName,
  originalLocation: Schema.String,
  checkoutMethod: CheckoutMethod,
}) {}

export type RepositoryState = "Concept" | "Active" | "Archived"

/** The row's state is a projection of the change, not a stored field. */
export const stateOf = (change: Change): RepositoryState =>
  change.phase === "Ideation"
    ? "Concept"
    : change.phase === "Completed" || change.phase === "Cancelled"
      ? "Archived"
      : "Active"

/** New-location checkouts live under the workspace; the original-location methods stay put. */
export const checkoutLocationOf = (change: Change, repository: Repository): string =>
  repository.checkoutMethod === "UseNewLocationNewBranch"
    ? join(change.workspaceLocation, repository.directoryName)
    : repository.originalLocation

export type RepositoryRef = {
  readonly changeId: ChangeId
  readonly repositoryId: RepositoryId
}

export type AddRepositoryInput = {
  readonly changeId: ChangeId
  readonly directoryName: DirectoryName
  readonly originalLocation: string
  readonly checkoutMethod: CheckoutMethod
}

export class RepositoryNotFound extends Data.TaggedError("RepositoryNotFound")<{
  readonly changeId: ChangeId
  readonly repositoryId: RepositoryId
}> {}

export class DuplicateDirectoryName extends Data.TaggedError("DuplicateDirectoryName")<{
  readonly changeId: ChangeId
  readonly directoryName: DirectoryName
}> {}

export class RepositoryStoreError extends Data.TaggedError("RepositoryStoreError")<{
  readonly changeId: ChangeId
  readonly operation: "read" | "write"
  readonly message: string
  readonly cause?: unknown
}> {}
