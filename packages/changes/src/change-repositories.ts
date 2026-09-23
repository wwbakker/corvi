/** The change-owned repository links. */
import { Context, Effect, Layer } from "effect"

import type { AddRepositoryInput, ChangeId, Repository, RepositoryRef } from "@corvi/contracts/changes"
import {
  DuplicateDirectoryName,
  RepositoryNotFound,
  type RepositoryStoreError,
} from "./errors.ts"
import { ChangeStore } from "./store.ts"

export interface Interface {
  readonly listRepositories: (changeId: ChangeId) => Effect.Effect<readonly Repository[], RepositoryStoreError>
  readonly addRepository: (
    input: AddRepositoryInput,
  ) => Effect.Effect<Repository, DuplicateDirectoryName | RepositoryStoreError>
  readonly removeRepository: (
    input: RepositoryRef,
  ) => Effect.Effect<void, RepositoryNotFound | RepositoryStoreError>
}

export class ChangeRepositories extends Context.Tag("corvi/ChangeRepositories")<ChangeRepositories, Interface>() {}

export const layer = Layer.effect(
  ChangeRepositories,
  Effect.gen(function* () {
    const store = yield* ChangeStore

    const listRepositories = Effect.fn("ChangeRepositories.listRepositories")(function* (changeId: ChangeId) {
      return yield* store.listRepositories(changeId)
    })

    const addRepository = Effect.fn("ChangeRepositories.addRepository")(function* (input: AddRepositoryInput) {
      const existing = yield* store.listRepositories(input.changeId)
      if (existing.some((repository) => repository.directoryName === input.directoryName))
        return yield* new DuplicateDirectoryName({
          changeId: input.changeId,
          directoryName: input.directoryName,
          message: `change ${input.changeId} already has a repository in ${input.directoryName}`,
        })
      return yield* store.addRepository(input)
    })

    const removeRepository = Effect.fn("ChangeRepositories.removeRepository")(function* (input: RepositoryRef) {
      const removed = yield* store.removeRepository(input.changeId, input.repositoryId)
      if (!removed)
        return yield* new RepositoryNotFound({
          ...input,
          message: `repository ${input.repositoryId} is not part of change ${input.changeId}`,
        })
    })

    return { listRepositories, addRepository, removeRepository }
  }),
)
