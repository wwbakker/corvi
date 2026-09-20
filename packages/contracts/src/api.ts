/** Wire schemas shared by the server routes and the browser client. */
import { Schema } from "effect"

import { Change, DirectoryName, RepositoryId } from "./changes.ts"

export const RepositoryViewSchema = Schema.Struct({
  repositoryId: RepositoryId,
  directoryName: DirectoryName,
  state: Schema.Literal("Concept", "Active", "Archived"),
  checkoutLocation: Schema.String,
  checkout: Schema.Union(
    Schema.Struct({ _tag: Schema.Literal("Missing") }),
    Schema.Struct({
      _tag: Schema.Literal("Present"),
      branch: Schema.optional(Schema.String),
      head: Schema.optional(Schema.String),
    }),
  ),
})
export type RepositoryViewDto = typeof RepositoryViewSchema.Type

export const ProvisionFailureSchema = Schema.Struct({
  repositoryId: RepositoryId,
  code: Schema.Literal("not-a-repository", "checkout-failed"),
  message: Schema.String,
})

export const StartOutcomeSchema = Schema.Union(
  Schema.Struct({
    _tag: Schema.Literal("Started"),
    change: Change,
    repositoryIds: Schema.Array(RepositoryId),
  }),
  Schema.Struct({
    _tag: Schema.Literal("PartiallyStarted"),
    change: Change,
    repositoryIds: Schema.Array(RepositoryId),
    failures: Schema.Array(ProvisionFailureSchema),
  }),
)
export type StartOutcomeDto = typeof StartOutcomeSchema.Type
