/** Change records and lifecycle. */
import { Context, Effect, Layer } from "effect"

import { Change, type ChangeFilter, type ChangeId, type ChangePhase, type CreateChangeInput } from "@corvi/contracts/changes"
import {
  ChangeIdTaken,
  ChangeNotFound,
  ChangeStoreError,
  InvalidTransition,
  type ChangeConflict,
} from "./errors.ts"
import { allowedTransition, isFinished, isTerminal } from "./rules.ts"
import { ChangeStore } from "./store.ts"

export interface Interface {
  readonly getChange: (changeId: ChangeId) => Effect.Effect<Change, ChangeNotFound | ChangeStoreError>
  readonly listChanges: (filter: ChangeFilter) => Effect.Effect<readonly Change[], ChangeStoreError>
  readonly createChange: (input: CreateChangeInput) => Effect.Effect<Change, ChangeIdTaken | ChangeStoreError>
  readonly transitionTo: (
    changeId: ChangeId,
    phase: ChangePhase,
  ) => Effect.Effect<Change, ChangeNotFound | InvalidTransition | ChangeConflict | ChangeStoreError>
}

export class ChangeService extends Context.Tag("corvi/ChangeService")<ChangeService, Interface>() {}

const now = (): string => new Date().toISOString()

export const layer = Layer.effect(
  ChangeService,
  Effect.gen(function* () {
    const store = yield* ChangeStore

    const getChange = Effect.fn("Change.getChange")(function* (changeId: ChangeId) {
      const change = yield* store.read(changeId)
      if (!change) return yield* new ChangeNotFound({ changeId })
      return change
    })

    const listChanges = Effect.fn("Change.listChanges")(function* (filter: ChangeFilter) {
      const changes = yield* store.list()
      return changes.filter((change) => (filter === "Archived" ? isFinished(change) : !isFinished(change)))
    })

    const createChange = Effect.fn("Change.createChange")(function* (input: CreateChangeInput) {
      const existing = yield* store.read(input.changeId)
      if (existing) return yield* new ChangeIdTaken({ changeId: input.changeId })
      const change = new Change({
        changeId: input.changeId,
        title: input.title,
        workspaceLocation: input.workspaceLocation,
        branch: input.branch ?? input.changeId,
        phase: input.phase ?? "Ideation",
        createdAt: now(),
      })
      yield* store.create(change, [])
      // The store owns the on-disk location, so the created change is read back rather than
      // echoing the input's workspace location.
      const created = yield* store.read(input.changeId)
      if (!created)
        return yield* new ChangeStoreError({
          changeId: input.changeId,
          operation: "read",
          message: "the created change could not be read back",
        })
      return created
    })

    const transitionTo = Effect.fn("Change.transitionTo")(function* (
      changeId: ChangeId,
      phase: ChangePhase,
    ) {
      const change = yield* getChange(changeId)
      if (!allowedTransition(change.phase, phase))
        return yield* new InvalidTransition({ changeId, from: change.phase, to: phase })
      return yield* store.patch(changeId, {
        phase,
        ...(isTerminal(phase) ? { completedAt: now() } : {}),
        // Optimistic concurrency: the write lands only if the record is still the one this
        // transition was decided on; another writer's commit is a conflict, not a lost update.
        expectedRevision: change.revision ?? 0,
      })
    })

    return { getChange, listChanges, createChange, transitionTo }
  }),
)
