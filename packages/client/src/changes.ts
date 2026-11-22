/** The change's own domain: lifecycle, documents, completion and the repositories it covers. */
import { Schema } from "effect";

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
  ProvisionedChangeSchema,
  ReopenedResponseSchema,
  RepoStateSchema,
  RepositoryViewSchema,
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
  type ProvisionedChangeDto,
  type ReopenedResponseDto,
  type RepoStateDto,
  type ReposBodyDto,
  type RepositoryViewDto,
  type TextDto,
} from "@corvi/contracts/api";
import type { ChangeId } from "@corvi/contracts/changes";
import {
  TranscriptListSchema,
  TranscriptSchema,
  type TranscriptDto,
  type TranscriptSummaryDto,
} from "@corvi/contracts/transcripts";

import { changePath, mutableArray, type RequestOptions, type Send, request } from "./transport.ts";

export interface ChangesApi {
  readonly list: (options?: RequestOptions) => Promise<ChangeWireDto[]>;
  readonly read: (changeId: ChangeId, options?: RequestOptions) => Promise<ChangeWireDto>;
  readonly summary: (changeId: ChangeId, options?: RequestOptions) => Promise<ChangeSummaryDto>;
  readonly description: (changeId: ChangeId, options?: RequestOptions) => Promise<TextDto>;
  readonly plan: (changeId: ChangeId, options?: RequestOptions) => Promise<PlanDocDto>;
  readonly writePlan: (
    changeId: ChangeId,
    body: PlanWriteBodyDto,
    options?: RequestOptions,
  ) => Promise<PlanDocDto>;
  readonly completion: (changeId: ChangeId, options?: RequestOptions) => Promise<CompletionDto>;
  readonly completionProgress: (
    changeId: ChangeId,
    options?: RequestOptions,
  ) => Promise<CompletionProgressDto | null>;
  readonly create: (body: CreateChangeBodyDto) => Promise<ProvisionedChangeDto>;
  readonly complete: (changeId: ChangeId, options?: ForceBodyDto) => Promise<CompletedResponseDto>;
  readonly cancel: (changeId: ChangeId, options?: ForceBodyDto) => Promise<CancelledResponseDto>;
  /** Undo a cancellation: the change, its checkouts and its shelved work come back. */
  readonly reopen: (changeId: ChangeId) => Promise<ReopenedResponseDto>;
  /** The agent sessions kept with the change when it was archived. */
  readonly transcripts: (
    changeId: ChangeId,
    options?: RequestOptions,
  ) => Promise<readonly TranscriptSummaryDto[]>;
  readonly transcript: (changeId: ChangeId, id: string, options?: RequestOptions) => Promise<TranscriptDto>;
  readonly rename: (
    changeId: ChangeId,
    patch: {
      readonly state?: NonNullable<ChangeWireDto["state"]>;
      readonly title?: string;
      /** The harness selectors; null clears one back to the default. */
      readonly userHarness?: string | null;
      readonly subagentHarness?: string | null;
    },
  ) => Promise<ChangeWireDto>;
  /** The covered repositories and their checkout states: the read half of `setRepositories`. */
  readonly repoStates: (changeId: ChangeId, options?: RequestOptions) => Promise<RepoStateDto[]>;
  readonly setRepositories: (changeId: ChangeId, body: ReposBodyDto) => Promise<ProvisionedChangeDto>;
  /** The change's repositories as Corvi's own facts: which links exist, their projected state,
   * and what is actually checked out where. */
  readonly checkouts: (changeId: ChangeId) => Promise<readonly RepositoryViewDto[]>;
}

export const makeChangesApi = (send: Send): ChangesApi => {
  const change = changePath;

  return {
    list: async (options) => request(send, "GET", "/changes", mutableArray(ChangeWireSchema), options),
    read: async (changeId, options) => request(send, "GET", change(changeId), ChangeWireSchema, options),
    summary: async (changeId, options) =>
      request(send, "GET", `${change(changeId)}/summary`, ChangeSummarySchema, options),
    description: async (changeId, options) =>
      request(send, "GET", `${change(changeId)}/description`, TextSchema, options),
    plan: async (changeId, options) =>
      request(send, "GET", `${change(changeId)}/plan`, PlanDocSchema, options),
    writePlan: async (changeId, body, options) =>
      request(send, "PUT", `${change(changeId)}/plan`, PlanDocSchema, { body, ...options }),
    completion: async (changeId, options) =>
      request(send, "GET", `${change(changeId)}/completion`, CompletionSchema, options),
    completionProgress: async (changeId, options) =>
      request(
        send,
        "GET",
        `${change(changeId)}/completion/progress`,
        Schema.NullOr(CompletionProgressSchema),
        options,
      ),
    create: async (body) => request(send, "POST", "/changes", ProvisionedChangeSchema, { body }),
    complete: async (changeId, options) =>
      request(send, "POST", `${change(changeId)}/complete`, CompletedResponseSchema, { body: options ?? {} }),
    cancel: async (changeId, options) =>
      request(send, "POST", `${change(changeId)}/cancel`, CancelledResponseSchema, { body: options ?? {} }),
    reopen: async (changeId) => request(send, "POST", `${change(changeId)}/reopen`, ReopenedResponseSchema),
    transcripts: async (changeId, options) =>
      request(send, "GET", `${change(changeId)}/transcripts`, TranscriptListSchema, options),
    transcript: async (changeId, id, options) =>
      request(
        send,
        "GET",
        `${change(changeId)}/transcript?id=${encodeURIComponent(id)}`,
        TranscriptSchema,
        options,
      ),
    rename: async (changeId, patch) =>
      request(send, "PATCH", change(changeId), ChangeWireSchema, { body: patch }),
    repoStates: async (changeId, options) =>
      request(send, "GET", `${change(changeId)}/repos`, mutableArray(RepoStateSchema), options),
    setRepositories: async (changeId, body) =>
      request(send, "POST", `${change(changeId)}/repos`, ProvisionedChangeSchema, { body }),
    checkouts: async (changeId) =>
      request(send, "GET", `${change(changeId)}/checkouts`, mutableArray(RepositoryViewSchema)),
  };
};
