/** The change-owned store dependency: records and repository links together. */
import { Context, type Effect } from "effect"

import type {
  AddRepositoryInput,
  Change,
  ChangeId,
  ChangePhase,
  Repository,
  RepositoryId,
} from "@corvi/contracts/changes"
import type {
  ChangeConflict,
  ChangeNotFound,
  ChangeStoreError,
  RepositoryStoreError,
} from "./errors.ts"

export interface StoreInterface {
  readonly read: (changeId: ChangeId) => Effect.Effect<Change | undefined, ChangeStoreError>
  readonly list: () => Effect.Effect<readonly Change[], ChangeStoreError>
  readonly create: (change: Change, repositories: readonly Repository[]) => Effect.Effect<void, ChangeStoreError>
  readonly patch: (
    changeId: ChangeId,
    patch: { readonly phase: ChangePhase; readonly completedAt?: string },
  ) => Effect.Effect<Change, ChangeNotFound | ChangeConflict | ChangeStoreError>
  /** A missing change reads as no links; the workflow reads the change first. */
  readonly listRepositories: (changeId: ChangeId) => Effect.Effect<readonly Repository[], RepositoryStoreError>
  readonly addRepository: (input: AddRepositoryInput) => Effect.Effect<Repository, RepositoryStoreError>
  readonly removeRepository: (
    changeId: ChangeId,
    repositoryId: RepositoryId,
  ) => Effect.Effect<boolean, RepositoryStoreError>
}

export class ChangeStore extends Context.Tag("corvi/ChangeStore")<ChangeStore, StoreInterface>() {}
