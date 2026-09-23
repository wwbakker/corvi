/** Canonical boundary values for changes and the repository links they own. */
import { Schema } from "effect"

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
  /** The branch the change's checkouts use; defaults to the change id. */
  branch: Schema.String,
  phase: ChangePhase,
  createdAt: Schema.String,
  completedAt: Schema.optional(Schema.String),
  /** How many times the record has been written; absent on records written before revisioning,
   * which count as 0. Writers may pass the revision they read and be refused when it moved. */
  revision: Schema.optional(Schema.Number),
}) {}

export type ChangeFilter = "Active" | "Archived"

export type CreateChangeInput = {
  readonly changeId: ChangeId
  readonly title: string
  readonly workspaceLocation: string
  readonly branch?: string
  readonly phase?: ChangePhase
}

export const RepositoryId = Schema.String.pipe(Schema.brand("corvi/RepositoryId"))
export type RepositoryId = typeof RepositoryId.Type

export const DirectoryName = Schema.String.pipe(Schema.brand("corvi/DirectoryName"))
export type DirectoryName = typeof DirectoryName.Type

/** Where a checkout lives: a worktree Corvi owns under the change (`new`), or the repository's
 * own checkout (`original`), which Corvi only links for reading. */
export const CheckoutLocation = Schema.Literal("new", "original")
export type CheckoutLocation = typeof CheckoutLocation.Type

/** Which branch a checkout uses: the change's own (created from `base` when missing, attached
 * when present), the branch the checkout has right now (adopted untouched), or an existing
 * branch by name (attached or switched to; never created). */
export const BranchPlan = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("change") }),
  Schema.Struct({ kind: Schema.Literal("current") }),
  Schema.Struct({ kind: Schema.Literal("existing"), name: Schema.String }),
)
export type BranchPlan = typeof BranchPlan.Type

export class Repository extends Schema.Class<Repository>("Repository")({
  changeId: ChangeId,
  repositoryId: RepositoryId,
  directoryName: DirectoryName,
  originalLocation: Schema.String,
  location: CheckoutLocation,
  branch: BranchPlan,
  /** Where a `change` branch starts; only meaningful for that branch kind. */
  base: Schema.optional(Schema.String),
  /** What a pull request merges into; falls back to `base`, then the repository default. */
  target: Schema.optional(Schema.String),
}) {}

export type RepositoryState = "Concept" | "Active" | "Archived"

/** Which branch a checkout's facts follow: the change's own branch, a named existing branch, or
 * whatever the checkout has checked out now — which is observed live at read time, never
 * recorded. */
export type EffectiveBranch =
  | { readonly _tag: "Recorded"; readonly name: string }
  | { readonly _tag: "Observed" }

// Pure and synchronous: nothing for an Effect to wrap.
export const effectiveBranchOf = (changeBranch: string, branch: BranchPlan): EffectiveBranch =>
  branch.kind === "current"
    ? { _tag: "Observed" }
    : { _tag: "Recorded", name: branch.kind === "existing" ? branch.name : changeBranch }

export type RepositoryRef = {
  readonly changeId: ChangeId
  readonly repositoryId: RepositoryId
}

export type AddRepositoryInput = {
  readonly changeId: ChangeId
  /** The source repository's checkout; the link's directory name and id derive from its last
   * component, so re-reading a record yields the same links every time. */
  readonly originalLocation: string
  readonly location: CheckoutLocation
  readonly branch: BranchPlan
  readonly base?: string
  readonly target?: string
}
