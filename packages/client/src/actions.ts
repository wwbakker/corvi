/** The actions a change may run, and the action files that configure them. */
import {
  ActionFilesResponseSchema,
  ActionRepositoryFilesResponseSchema,
  ActionSummarySchema,
  RunActionResultSchema,
  type ActionFileRefDto,
  type ActionFileWriteDto,
  type ActionFilesResponseDto,
  type ActionRepositoryFileRefDto,
  type ActionRepositoryFileWriteDto,
  type ActionRepositoryFilesResponseDto,
  type ActionSummaryDto,
  type RunActionResultDto,
} from "@corvi/contracts/actions";
import type { ChangeId } from "@corvi/contracts/changes";

import { changePath, mutableArray, type Send, request } from "./transport.ts";

export interface ActionsApi {
  readonly list: (changeId: ChangeId) => Promise<readonly ActionSummaryDto[]>;
  readonly run: (changeId: ChangeId, key: string, window?: string) => Promise<RunActionResultDto>;
  readonly files: () => Promise<ActionFilesResponseDto>;
  readonly writeFile: (file: ActionFileWriteDto) => Promise<ActionFilesResponseDto>;
  readonly deleteFile: (ref: ActionFileRefDto) => Promise<ActionFilesResponseDto>;
  /** The repository-scope files of one change's checkouts — the Repositories view. */
  readonly repositoryFiles: (changeId: ChangeId) => Promise<ActionRepositoryFilesResponseDto>;
  readonly writeRepositoryFile: (
    changeId: ChangeId,
    file: ActionRepositoryFileWriteDto,
  ) => Promise<ActionRepositoryFilesResponseDto>;
  readonly deleteRepositoryFile: (
    changeId: ChangeId,
    ref: ActionRepositoryFileRefDto,
  ) => Promise<ActionRepositoryFilesResponseDto>;
}

export const makeActionsApi = (send: Send): ActionsApi => {
  const change = changePath;

  return {
    list: async (changeId) =>
      request(send, "GET", `${change(changeId)}/actions`, mutableArray(ActionSummarySchema)),
    run: async (changeId, key, window) =>
      request(send, "POST", `${change(changeId)}/actions`, RunActionResultSchema, { body: { key, window } }),
    files: async () => request(send, "GET", "/actions/files", ActionFilesResponseSchema),
    writeFile: async (file) =>
      request(send, "PUT", "/actions/files", ActionFilesResponseSchema, { body: file }),
    deleteFile: async (ref) =>
      request(
        send,
        "DELETE",
        `/actions/files?scope=${ref.scope}${
          ref.workspace ? `&workspace=${encodeURIComponent(ref.workspace)}` : ""
        }&id=${encodeURIComponent(ref.id)}`,
        ActionFilesResponseSchema,
      ),
    repositoryFiles: async (changeId) =>
      request(send, "GET", `${change(changeId)}/action-files`, ActionRepositoryFilesResponseSchema),
    writeRepositoryFile: async (changeId, file) =>
      request(send, "PUT", `${change(changeId)}/action-files`, ActionRepositoryFilesResponseSchema, {
        body: file,
      }),
    deleteRepositoryFile: async (changeId, ref) =>
      request(
        send,
        "DELETE",
        `${change(changeId)}/action-files?repository=${encodeURIComponent(ref.repository)}&id=${encodeURIComponent(ref.id)}`,
        ActionRepositoryFilesResponseSchema,
      ),
  };
};
