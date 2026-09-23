/** Pure rules for the change lifecycle and its repository links. */
import { trimLeadingSeparators, trimTrailingSeparators } from "@corvi/contracts/paths"
import { baseName } from "@corvi/contracts/paths"
import { DirectoryName, Repository, RepositoryId } from "@corvi/contracts/changes"
import type {
  AddRepositoryInput,
  Change,
  ChangeId,
  ChangePhase,
  RepositoryState,
} from "@corvi/contracts/changes"

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
  repository.location === "new"
    ? join(change.workspaceLocation, repository.directoryName)
    : repository.originalLocation

/** The link a checkout spec becomes: its directory name is the source's last component, and the
 * id derives from the two, so re-reading a record yields the same links every time. */
export const repositoryFromSpec = (
  changeId: ChangeId,
  spec: {
    readonly path: string
    readonly location: Repository["location"]
    readonly branch: Repository["branch"]
    readonly base?: string
    readonly target?: string
  },
): Repository => {
  const directoryName = baseName(spec.path)
  return new Repository({
    changeId,
    repositoryId: RepositoryId.make(`${changeId}:${directoryName}`),
    directoryName: DirectoryName.make(directoryName),
    originalLocation: spec.path,
    location: spec.location,
    branch: spec.branch,
    ...(spec.base !== undefined ? { base: spec.base } : {}),
    ...(spec.target !== undefined ? { target: spec.target } : {}),
  })
}

/** The spec a link persists as — `repositoryFromSpec`'s inverse. */
export const specFromRepository = (repository: Repository): {
  readonly path: string
  readonly location: Repository["location"]
  readonly branch: Repository["branch"]
  readonly base?: string
  readonly target?: string
} => ({
  path: repository.originalLocation,
  location: repository.location,
  branch: repository.branch,
  ...(repository.base !== undefined ? { base: repository.base } : {}),
  ...(repository.target !== undefined ? { target: repository.target } : {}),
})

/** The input a new link is created from, as the same spec shape. */
export const specFromInput = (input: AddRepositoryInput): Parameters<typeof repositoryFromSpec>[1] => ({
  path: input.originalLocation,
  location: input.location,
  branch: input.branch,
  ...(input.base !== undefined ? { base: input.base } : {}),
  ...(input.target !== undefined ? { target: input.target } : {}),
})
