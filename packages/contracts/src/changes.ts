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
