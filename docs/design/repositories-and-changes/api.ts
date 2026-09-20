/** Design prototype: DTOs, the server routes, and the named client methods. */
import { Data, Effect, Schema } from "effect"

import {
  Change,
  ChangeId,
  DirectoryName,
  RepositoryId,
  type ChangeConflict,
  type ChangeNotFound,
  type ChangeStoreError,
  type InvalidTransition,
  type RepositoryStoreError,
} from "./model.ts"
import type { CheckoutError } from "./repositories.ts"
import { ChangeWork, type RepositoryView, type StartOutcome } from "./workflows.ts"

export class HttpError extends Data.TaggedError("HttpError")<{
  readonly status: 400 | 404 | 409 | 500
  readonly message: string
}> {}

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

export const toRepositoryViewDto = (view: RepositoryView): RepositoryViewDto => ({
  repositoryId: view.repository.repositoryId,
  directoryName: view.repository.directoryName,
  state: view.state,
  checkoutLocation: view.checkoutLocation,
  checkout: view.checkout,
})

export const inspectChangeRepositoriesRoute = (request: {
  readonly params: { readonly changeId: string }
}): Effect.Effect<readonly RepositoryViewDto[], HttpError, ChangeWork> =>
  Effect.gen(function* () {
    const changeId = yield* Schema.decodeUnknown(ChangeId)(request.params.changeId).pipe(
      Effect.mapError(() => new HttpError({ status: 400, message: "invalid change id" })),
    )
    const work = yield* ChangeWork
    const views = yield* work.inspectChangeRepositories(changeId)
    return views.map(toRepositoryViewDto)
  }).pipe(
    Effect.catchTags({
      ChangeNotFound: () => new HttpError({ status: 404, message: "change not found" }),
      ChangeStoreError: (error) => new HttpError({ status: 500, message: error.message }),
      RepositoryStoreError: (error) => new HttpError({ status: 500, message: error.message }),
      CheckoutError: (error) => new HttpError({ status: 500, message: error.message }),
    }),
  )

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

export const toStartOutcomeDto = (outcome: StartOutcome): StartOutcomeDto =>
  outcome._tag === "Started"
    ? {
        _tag: "Started",
        change: outcome.change,
        repositoryIds: outcome.repositories.map((repository) => repository.repositoryId),
      }
    : {
        _tag: "PartiallyStarted",
        change: outcome.change,
        repositoryIds: outcome.repositories.map((repository) => repository.repositoryId),
        failures: outcome.failures.map((failure) => ({
          repositoryId: failure.repositoryId,
          code:
            failure.error._tag === "NotARepository"
              ? ("not-a-repository" as const)
              : ("checkout-failed" as const),
          message:
            failure.error._tag === "NotARepository"
              ? `${failure.error.directory} is not a repository`
              : failure.error.message,
        })),
      }

export const startChangeRoute = (request: {
  readonly params: { readonly changeId: string }
}): Effect.Effect<StartOutcomeDto, HttpError, ChangeWork> =>
  Effect.gen(function* () {
    const changeId = yield* Schema.decodeUnknown(ChangeId)(request.params.changeId).pipe(
      Effect.mapError(() => new HttpError({ status: 400, message: "invalid change id" })),
    )
    const work = yield* ChangeWork
    return toStartOutcomeDto(yield* work.startChange(changeId))
  }).pipe(
    Effect.catchTags({
      ChangeNotFound: () => new HttpError({ status: 404, message: "change not found" }),
      InvalidTransition: () => new HttpError({ status: 409, message: "change is not an idea" }),
      ChangeConflict: () => new HttpError({ status: 409, message: "change changed; retry" }),
      ChangeStoreError: (error) => new HttpError({ status: 500, message: error.message }),
      RepositoryStoreError: (error) => new HttpError({ status: 500, message: error.message }),
    }),
  )

export interface ChangesClient {
  readonly inspectRepositories: (changeId: ChangeId) => Promise<readonly RepositoryViewDto[]>
  readonly startChange: (changeId: ChangeId) => Promise<StartOutcomeDto>
}

export const makeChangesClient = (baseUrl: string): ChangesClient => ({
  inspectRepositories: async (changeId) => {
    const response = await fetch(`${baseUrl}/api/changes/${encodeURIComponent(changeId)}/repositories`)
    if (!response.ok) throw new HttpError({ status: 500, message: `request failed: ${response.status}` })
    return Schema.decodeUnknownSync(Schema.Array(RepositoryViewSchema))(await response.json())
  },
  startChange: async (changeId) => {
    const response = await fetch(`${baseUrl}/api/changes/${encodeURIComponent(changeId)}/start`, {
      method: "POST",
    })
    if (!response.ok) throw new HttpError({ status: 500, message: `request failed: ${response.status}` })
    return Schema.decodeUnknownSync(StartOutcomeSchema)(await response.json())
  },
})
