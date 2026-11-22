/** Harnesses: the files the Harnesses page edits, the resolved views a change gets, and the
 * new-terminal dialog's harness window. */
import {
  HarnessChoicesResponseSchema,
  HarnessFilesResponseSchema,
  HarnessListResponseSchema,
  HarnessRepositoryFilesResponseSchema,
  HarnessWindowResponseSchema,
  type HarnessChoicesResponseDto,
  type HarnessFilesResponseDto,
  type HarnessListResponseDto,
  type HarnessRepositoryFilesResponseDto,
  type HarnessWindowResponseDto,
  type OpenHarnessWindowDto,
} from "@corvi/contracts/harnesses";
import type { ChangeId } from "@corvi/contracts/changes";

import { makeFileOperations, type FileOperations } from "./files.ts";
import { changePath, request, type RequestOptions, type Send } from "./transport.ts";

export interface HarnessesApi extends FileOperations<
  HarnessFilesResponseDto,
  HarnessRepositoryFilesResponseDto
> {
  /** Every harness this change can use, its resolved view, and the change's selection. */
  readonly list: (changeId: ChangeId, options?: RequestOptions) => Promise<HarnessListResponseDto>;
  /** The change's harnesses without resolved views, for selectors and dialogs. */
  readonly summaries: (changeId: ChangeId, options?: RequestOptions) => Promise<HarnessListResponseDto>;
  /** The harnesses a scope or wizard selection can choose from — no resolved views. */
  readonly choices: (
    query: {
      readonly workspace?: string;
      readonly repositories?: readonly string[];
      /** Repositories whose checkout will be a fresh worktree: only tracked harness files. */
      readonly trackedRepositories?: readonly string[];
    },
    options?: RequestOptions,
  ) => Promise<HarnessChoicesResponseDto>;
  /** Start `pi` in a new window with the named harness. */
  readonly openWindow: (changeId: ChangeId, body: OpenHarnessWindowDto) => Promise<HarnessWindowResponseDto>;
}

export const makeHarnessesApi = (send: Send): HarnessesApi => ({
  ...makeFileOperations(send, {
    filesPath: "/harness-files",
    repositoryPath: (changeId) => `${changePath(changeId)}/harness-files`,
    filesSchema: HarnessFilesResponseSchema,
    repositoriesSchema: HarnessRepositoryFilesResponseSchema,
  }),
  list: async (changeId, options) =>
    request(send, "GET", `${changePath(changeId)}/harnesses`, HarnessListResponseSchema, options),
  summaries: async (changeId, options) =>
    request(send, "GET", `${changePath(changeId)}/harnesses?views=0`, HarnessListResponseSchema, options),
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
      `/harnesses${params.size > 0 ? `?${params.toString()}` : ""}`,
      HarnessChoicesResponseSchema,
      options,
    );
  },
  openWindow: async (changeId, body) =>
    request(send, "POST", `${changePath(changeId)}/harness-window`, HarnessWindowResponseSchema, {
      body,
    }),
});
