/** Harnesses: the files the Harnesses page edits, the resolved views a change gets, and the
 * new-terminal dialog's harness window. */
import {
  HarnessProfileChoicesResponseSchema,
  HarnessProfileFilesResponseSchema,
  HarnessProfileListResponseSchema,
  HarnessProfileRepositoryFilesResponseSchema,
  HarnessWindowResponseSchema,
  type HarnessProfileChoicesResponseDto,
  type HarnessProfileFilesResponseDto,
  type HarnessProfileListResponseDto,
  type HarnessProfileRepositoryFilesResponseDto,
  type HarnessWindowResponseDto,
  type OpenHarnessWindowDto,
} from "@corvi/contracts/harness-profiles";
import type { ChangeId } from "@corvi/contracts/changes";

import { makeFileOperations, type FileOperations } from "./files.ts";
import { changePath, request, type RequestOptions, type Send } from "./transport.ts";

export interface HarnessProfilesApi extends FileOperations<
  HarnessProfileFilesResponseDto,
  HarnessProfileRepositoryFilesResponseDto
> {
  /** Every harness this change can use, its resolved view, and the change's selection. */
  readonly list: (changeId: ChangeId, options?: RequestOptions) => Promise<HarnessProfileListResponseDto>;
  /** The change's harness profiles without resolved views, for selectors and dialogs. */
  readonly summaries: (
    changeId: ChangeId,
    options?: RequestOptions,
  ) => Promise<HarnessProfileListResponseDto>;
  /** The harness profiles a scope or wizard selection can choose from — no resolved views. */
  readonly choices: (
    query: {
      readonly workspace?: string;
      readonly repositories?: readonly string[];
      /** Repositories whose checkout will be a fresh worktree: only tracked harness profile files. */
      readonly trackedRepositories?: readonly string[];
    },
    options?: RequestOptions,
  ) => Promise<HarnessProfileChoicesResponseDto>;
  /** Start `pi` in a new window with the named harness. */
  readonly openWindow: (changeId: ChangeId, body: OpenHarnessWindowDto) => Promise<HarnessWindowResponseDto>;
}

export const makeHarnessProfilesApi = (send: Send): HarnessProfilesApi => ({
  ...makeFileOperations(send, {
    filesPath: "/harness-profile-files",
    repositoryPath: (changeId) => `${changePath(changeId)}/harness-profile-files`,
    filesSchema: HarnessProfileFilesResponseSchema,
    repositoriesSchema: HarnessProfileRepositoryFilesResponseSchema,
  }),
  list: async (changeId, options) =>
    request(
      send,
      "GET",
      `${changePath(changeId)}/harness-profiles`,
      HarnessProfileListResponseSchema,
      options,
    ),
  summaries: async (changeId, options) =>
    request(
      send,
      "GET",
      `${changePath(changeId)}/harness-profiles?views=0`,
      HarnessProfileListResponseSchema,
      options,
    ),
  choices: async (query, options) => {
    const params = new URLSearchParams();
    if (query.workspace !== undefined) params.set("workspace", query.workspace);
    for (const repository of query.repositories ?? []) params.append("repository", repository);
    for (const repository of query.trackedRepositories ?? []) {
      params.append("trackedRepository", repository);
    }
    return request(
      send,
      "GET",
      `/harness-profiles${params.size > 0 ? `?${params.toString()}` : ""}`,
      HarnessProfileChoicesResponseSchema,
      options,
    );
  },
  openWindow: async (changeId, body) =>
    request(send, "POST", `${changePath(changeId)}/harness-window`, HarnessWindowResponseSchema, {
      body,
    }),
});
