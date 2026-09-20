/** Design prototype: the change-owned persistence dependency. */
import { Context, type Effect } from "effect"

import type {
  AddRepositoryInput,
  Change,
  ChangeConflict,
  ChangeId,
  ChangeNotFound,
  ChangePhase,
  ChangeStoreError,
  Repository,
  RepositoryId,
  RepositoryStoreError,
} from "./model.ts"

export interface StoreInterface {
  readonly read: (changeId: ChangeId) => Effect.Effect<Change | undefined, ChangeStoreError>
  readonly list: () => Effect.Effect<readonly Change[], ChangeStoreError>
  readonly create: (change: Change) => Effect.Effect<Change, ChangeStoreError>
  readonly patch: (
    changeId: ChangeId,
    patch: { readonly phase: ChangePhase; readonly completedAt?: string },
  ) => Effect.Effect<Change, ChangeNotFound | ChangeConflict | ChangeStoreError>
  readonly listRepositories: (changeId: ChangeId) => Effect.Effect<readonly Repository[], RepositoryStoreError>
  readonly addRepository: (input: AddRepositoryInput) => Effect.Effect<Repository, RepositoryStoreError>
  readonly removeRepository: (
    changeId: ChangeId,
    repositoryId: RepositoryId,
  ) => Effect.Effect<boolean, RepositoryStoreError>
}

export class ChangeStore extends Context.Tag("corvi/ChangeStore")<ChangeStore, StoreInterface>() {}
