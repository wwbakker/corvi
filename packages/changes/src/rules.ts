/** Pure rules for the change lifecycle and its repository links. */
import { trimLeadingSeparators, trimTrailingSeparators } from "@corvi/contracts/paths"
import type { Change, ChangePhase, Repository, RepositoryState } from "@corvi/contracts/changes"

export const isTerminal = (phase: ChangePhase): boolean =>
  phase === "Completed" || phase === "Cancelled"

export const isFinished = (change: Pick<Change, "phase">): boolean => isTerminal(change.phase)

/** `Ideation` leaves for `Implementation` (starting the work) or `Cancelled` (abandoning the
 * idea); the manual phases move among themselves, and the complete/cancel workflows enter the
 * terminal phases. */
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

const join = (left: string, right: string): string =>
  `${trimTrailingSeparators(left)}/${trimLeadingSeparators(right)}`

/** New-location checkouts live under the workspace; the original-location methods stay put. */
export const checkoutLocationOf = (change: Change, repository: Repository): string =>
  repository.checkoutMethod === "UseNewLocationNewBranch"
    ? join(change.workspaceLocation, repository.directoryName)
    : repository.originalLocation
