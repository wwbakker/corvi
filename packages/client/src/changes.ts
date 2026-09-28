/** The change's own domain: lifecycle, documents, completion and the repositories it covers. */
import { Schema } from "effect"

import {
  CancelledResponseSchema,
  ChangeSummarySchema,
  ChangeWireSchema,
  CompletedResponseSchema,
  CompletionProgressSchema,
  CompletionSchema,
  CreateChangeBodySchema,
  PlanDocSchema,
  PlanWriteBodySchema,
  RepoStateSchema,
  RepositoryViewSchema,
  StartedResponseSchema,
  TextSchema,
  type CancelledResponseDto,
  type ChangeSummaryDto,
  type ChangeWireDto,
  type CompletedResponseDto,
  type CompletionDto,
  type CompletionProgressDto,
  type CreateChangeBodyDto,
  type ForceBodyDto,
  type PlanDocDto,
  type PlanWriteBodyDto,
  type RepoStateDto,
  type ReposBodyDto,
  type RepositoryViewDto,
  type StartedResponseDto,
  type TextDto,
} from "@corvi/contracts/api"
import type { ChangeId } from "@corvi/contracts/changes"

import {
  changePath,
  decode,
  mutableArray,
  type RequestOptions,
  type Send,
} from "./transport.ts"

export interface ChangesApi {
  readonly list: (options?: RequestOptions) => Promise<ChangeWireDto[]>
  readonly read: (changeId: ChangeId, options?: RequestOptions) => Promise<ChangeWireDto>
  readonly summary: (changeId: ChangeId, options?: RequestOptions) => Promise<ChangeSummaryDto>
  readonly description: (changeId: ChangeId, options?: RequestOptions) => Promise<TextDto>
  readonly plan: (changeId: ChangeId, options?: RequestOptions) => Promise<PlanDocDto>
  readonly writePlan: (
    changeId: ChangeId,
    body: PlanWriteBodyDto,
    options?: RequestOptions,
  ) => Promise<PlanDocDto>
  readonly completion: (changeId: ChangeId, options?: RequestOptions) => Promise<CompletionDto>
  readonly completionProgress: (
    changeId: ChangeId,
    options?: RequestOptions,
  ) => Promise<CompletionProgressDto | null>
  readonly create: (body: CreateChangeBodyDto) => Promise<StartedResponseDto>
  readonly start: (changeId: ChangeId) => Promise<StartedResponseDto>
  readonly complete: (changeId: ChangeId, options?: ForceBodyDto) => Promise<CompletedResponseDto>
  readonly cancel: (changeId: ChangeId, options?: ForceBodyDto) => Promise<CancelledResponseDto>
  readonly rename: (
    changeId: ChangeId,
    patch: { readonly state?: string; readonly title?: string },
  ) => Promise<ChangeWireDto>
  /** The covered repositories and their checkout states: the read half of `setRepositories`. */
  readonly repoStates: (changeId: ChangeId, options?: RequestOptions) => Promise<RepoStateDto[]>
  readonly setRepositories: (
    changeId: ChangeId,
    body: ReposBodyDto,
  ) => Promise<ChangeWireDto>
  /** The change's repositories as Corvi's own facts: which links exist, their projected state,
   * and what is actually checked out where. */
  readonly checkouts: (changeId: ChangeId) => Promise<readonly RepositoryViewDto[]>
}

export const makeChangesApi = (send: Send): ChangesApi => {
  const change = changePath

  return {
    list: async (options) =>
      decode(mutableArray(ChangeWireSchema), await send("GET", "/changes", options)),
    read: async (changeId, options) =>
      decode(ChangeWireSchema, await send("GET", change(changeId), options)),
    summary: async (changeId, options) =>
      decode(ChangeSummarySchema, await send("GET", `${change(changeId)}/summary`, options)),
    description: async (changeId, options) =>
      decode(TextSchema, await send("GET", `${change(changeId)}/description`, options)),
    plan: async (changeId, options) =>
      decode(PlanDocSchema, await send("GET", `${change(changeId)}/plan`, options)),
    writePlan: async (changeId, body, options) =>
      decode(PlanDocSchema, await send("PUT", `${change(changeId)}/plan`, { body, ...options })),
    completion: async (changeId, options) =>
      decode(CompletionSchema, await send("GET", `${change(changeId)}/completion`, options)),
    completionProgress: async (changeId, options) =>
      decode(
        Schema.NullOr(CompletionProgressSchema),
        await send("GET", `${change(changeId)}/completion/progress`, options),
      ),
    create: async (body) =>
      decode(StartedResponseSchema, await send("POST", "/changes", { body })),
    start: async (changeId) =>
      decode(StartedResponseSchema, await send("POST", `${change(changeId)}/start`)),
    complete: async (changeId, options) =>
      decode(
        CompletedResponseSchema,
        await send("POST", `${change(changeId)}/complete`, { body: options ?? {} }),
      ),
    cancel: async (changeId, options) =>
      decode(
        CancelledResponseSchema,
        await send("POST", `${change(changeId)}/cancel`, { body: options ?? {} }),
      ),
    rename: async (changeId, patch) =>
      decode(ChangeWireSchema, await send("PATCH", change(changeId), { body: patch })),
    repoStates: async (changeId, options) =>
      decode(mutableArray(RepoStateSchema), await send("GET", `${change(changeId)}/repos`, options)),
    setRepositories: async (changeId, body) =>
      decode(ChangeWireSchema, await send("POST", `${change(changeId)}/repos`, { body })),
    checkouts: async (changeId) =>
      decode(
        mutableArray(RepositoryViewSchema),
        await send("GET", `${change(changeId)}/checkouts`),
      ),
  }
}
