/** The operation journal port: change-owned, written through by workflows. */
import { Context, type Effect } from "effect"

import type { ChangeId } from "@corvi/contracts/changes"
import type { OperationStepDto } from "@corvi/contracts/api"
import type { ChangeFormatTooNew, ChangeStoreError } from "./errors.ts"

/** One journal entry of an operation that can stop half way. `waiting` is written when the plan
 * is recorded, before anything runs, so a page can show what is still coming. The shared
 * operation-progress shape (`@corvi/contracts/api`'s `OperationStepDto`). */
export type OperationStep = OperationStepDto

export interface ProgressInterface {
  readonly record: (input: {
    readonly changeId: ChangeId
    readonly step: OperationStep
  }) => Effect.Effect<void, ChangeFormatTooNew | ChangeStoreError>
}

export class OperationProgress extends Context.Tag("corvi/OperationProgress")<OperationProgress, ProgressInterface>() {}
