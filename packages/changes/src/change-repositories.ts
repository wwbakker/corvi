/** The change-owned repository links. */
import { Context, Effect, Layer } from "effect"

import { DirectoryName } from "@corvi/contracts/changes"
import type { AddRepositoryInput, ChangeId, Repository, RepositoryRef } from "@corvi/contracts/changes"
import { baseName } from "@corvi/contracts/paths"
import {
  DuplicateDirectoryName,
  RepositoryNotFound,
  type ChangeFormatTooNew,
  type RepositoryStoreError,
} from "./errors.ts"
import { ChangeStore } from "./store.ts"

export interface Interface {
  readonly listRepositories: (changeId: ChangeId) => Effect.Effect<readonly Repository[], RepositoryStoreError>
  readonly addRepository: (
    input: AddRepositoryInput,
  ) => Effect.Effect<Repository, ChangeFormatTooNew | DuplicateDirectoryName | RepositoryStoreError>
  readonly removeRepository: (
    input: RepositoryRef,
  ) => Effect.Effect<void, ChangeFormatTooNew | RepositoryNotFound | RepositoryStoreError>
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
      // Every repository is filed in the change directory under its own name, so two paths with
      // the same last component would collide there.
      const directoryName = DirectoryName.make(baseName(input.originalLocation))
      const existing = yield* store.listRepositories(input.changeId)
      if (existing.some((repository) => repository.directoryName === directoryName))
        return yield* new DuplicateDirectoryName({
          changeId: input.changeId,
          directoryName,
          message: `change ${input.changeId} already has a repository in ${directoryName}`,
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
