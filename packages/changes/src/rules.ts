/** Pure rules for the change lifecycle and its repository links. */
import { trimLeadingSeparators, trimTrailingSeparators } from "@corvi/contracts/paths";
import { baseName } from "@corvi/contracts/paths";
import { DirectoryName, Repository, RepositoryId } from "@corvi/contracts/changes";
import type {
  AddRepositoryInput,
  BranchPlan,
  Change,
  ChangeId,
  ChangePhase,
  RepositoryState,
} from "@corvi/contracts/changes";

export const isTerminal = (phase: ChangePhase): boolean => phase === "Completed" || phase === "Cancelled";

/** The manual phases — `Ideation` included — move among themselves, and nothing leaves a
 * terminal phase. Terminal *targets* are allowed because the complete/cancel workflows enter them
 * through `ChangeService.transitionTo`; a hand edit is filtered separately (`applyPatch` refuses a
 * finished state), so a caller that must not reach a terminal phase guards it itself. */
export const allowedTransition = (from: ChangePhase, to: ChangePhase): boolean => {
  if (from === to) return false;
  if (isTerminal(from)) return false;
  return true;
};

/** Where reopening a cancelled change returns it: the phase it was cancelled from, and
 * `Implementation` for a record cancelled before that was written down. Only a cancelled change
 * reopens — a completed one landed, and there is nothing to go back to. */
export const reopenPhaseOf = (change: Pick<Change, "phase" | "cancelledFrom">): ChangePhase | undefined => {
  if (change.phase !== "Cancelled") return undefined;
  const from = change.cancelledFrom;
  return from === undefined || isTerminal(from) ? "Implementation" : from;
};

/** Which ref a checkout is fresh against, chosen purely from its branch plan and the values its
 * caller resolved. A branch adopted as checked out has no freshness source at all; a named
 * existing branch is fresh against its remote counterpart; a change branch is fresh against the
 * base it was given, else the repository's default branch. The callers supply their own reads —
 * the dashboard card over plain git, the checkout workflow over the capability — so only the
 * choice lives here, and the two can never select different kinds of ref. */
export const freshnessTargetOf = (input: {
  readonly branch: BranchPlan;
  readonly base?: string;
  readonly defaultBranch?: string;
  readonly existingRemoteRef?: string;
}): string | undefined => {
  switch (input.branch.kind) {
    case "current":
      return undefined;
    case "existing":
      return input.existingRemoteRef;
    case "change":
      return input.base ?? input.defaultBranch;
  }
};

/** The row's state is a projection of the change, not a stored field. */
export const stateOf = (change: Change): RepositoryState =>
  change.phase === "Ideation"
    ? "Concept"
    : change.phase === "Completed" || change.phase === "Cancelled"
      ? "Archived"
      : "Active";

const join = (left: string, right: string): string =>
  `${trimTrailingSeparators(left)}/${trimLeadingSeparators(right)}`;

/** New-location checkouts live under the workspace; the original-location methods stay put. */
export const checkoutLocationOf = (change: Change, repository: Repository): string =>
  repository.location === "new"
    ? join(change.workspaceLocation, repository.directoryName)
    : repository.originalLocation;

/** The link a checkout spec becomes: its directory name is the source's last component, and the
 * id derives from the two, so re-reading a record yields the same links every time. */
export const repositoryFromSpec = (
  changeId: ChangeId,
  spec: {
    readonly path: string;
    readonly location: Repository["location"];
    readonly branch: Repository["branch"];
    readonly base?: string;
    readonly target?: string;
  },
): Repository => {
  const directoryName = baseName(spec.path);
  return new Repository({
    changeId,
    repositoryId: RepositoryId.make(`${changeId}:${directoryName}`),
    directoryName: DirectoryName.make(directoryName),
    originalLocation: spec.path,
    location: spec.location,
    branch: spec.branch,
    ...(spec.base !== undefined ? { base: spec.base } : {}),
    ...(spec.target !== undefined ? { target: spec.target } : {}),
  });
};

/** The spec a link persists as — `repositoryFromSpec`'s inverse. */
export const specFromRepository = (
  repository: Repository,
): {
  readonly path: string;
  readonly location: Repository["location"];
  readonly branch: Repository["branch"];
  readonly base?: string;
  readonly target?: string;
} => ({
  path: repository.originalLocation,
  location: repository.location,
  branch: repository.branch,
  ...(repository.base !== undefined ? { base: repository.base } : {}),
  ...(repository.target !== undefined ? { target: repository.target } : {}),
});

/** The input a new link is created from, as the same spec shape. */
export const specFromInput = (input: AddRepositoryInput): Parameters<typeof repositoryFromSpec>[1] => ({
  path: input.originalLocation,
  location: input.location,
  branch: input.branch,
  ...(input.base !== undefined ? { base: input.base } : {}),
  ...(input.target !== undefined ? { target: input.target } : {}),
});
