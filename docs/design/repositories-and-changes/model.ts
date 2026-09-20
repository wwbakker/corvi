/** Design prototype: capability errors and pure rules over the canonical contracts. */
import { Data } from "effect"

import type {
  Change,
  ChangeId,
  ChangePhase,
  DirectoryName,
  Repository,
  RepositoryId,
  RepositoryState,
} from "@corvi/contracts/changes"

export {
  Change,
  ChangeId,
  ChangePhase,
  CheckoutMethod,
  DirectoryName,
  Repository,
  RepositoryId,
} from "@corvi/contracts/changes"
export type { ChangeFilter, CreateChangeInput, RepositoryState } from "@corvi/contracts/changes"
export type { AddRepositoryInput, RepositoryRef } from "@corvi/contracts/changes"

import { join } from "./paths.ts"

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
  /** Absent for store-wide operations such as listing the changes root. */
  readonly changeId?: ChangeId
  readonly operation: "read" | "write"
  readonly message: string
  readonly cause?: unknown
}> {}

export const isTerminal = (phase: ChangePhase): boolean =>
  phase === "Completed" || phase === "Cancelled"

export const isFinished = (change: Pick<Change, "phase">): boolean => isTerminal(change.phase)

/** `Ideation` leaves for `Implementation` (starting) or `Cancelled` (abandoning the idea); the
 * manual phases move among themselves, and the complete/cancel workflows enter the terminal phases. */
export const allowedTransition = (from: ChangePhase, to: ChangePhase): boolean => {
  if (from === to) return false
  if (isTerminal(from)) return false
  if (from === "Ideation") return to === "Implementation" || to === "Cancelled"
  return true
}

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
