/** The operation journal port: change-owned, written through by workflows. */
import { Context, type Effect } from "effect"

import type { ChangeId } from "@corvi/contracts/changes"
import type { ChangeStoreError } from "./errors.ts"

/** One journal entry of an operation that can stop half way. */
export type OperationStep = {
  readonly id: string
  readonly label: string
  readonly state: "running" | "done" | "failed"
  readonly detail?: string
}

export interface ProgressInterface {
  readonly record: (input: {
    readonly changeId: ChangeId
    readonly step: OperationStep
  }) => Effect.Effect<void, ChangeStoreError>
}

export class OperationProgress extends Context.Tag("corvi/OperationProgress")<OperationProgress, ProgressInterface>() {}
