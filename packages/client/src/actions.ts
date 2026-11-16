/** The actions a change may run, and the action files that configure them. */
import {
  ActionFilesResponseSchema,
  ActionRepositoryFilesResponseSchema,
  ActionSummarySchema,
  RunActionResultSchema,
  type ActionFilesResponseDto,
  type ActionRepositoryFilesResponseDto,
  type ActionSummaryDto,
  type RunActionResultDto,
} from "@corvi/contracts/actions";
import type { ChangeId } from "@corvi/contracts/changes";

import { makeFileOperations, type FileOperations } from "./files.ts";
import { changePath, mutableArray, type Send, request } from "./transport.ts";

export interface ActionsApi extends FileOperations<ActionFilesResponseDto, ActionRepositoryFilesResponseDto> {
  readonly list: (changeId: ChangeId) => Promise<readonly ActionSummaryDto[]>;
  readonly run: (changeId: ChangeId, key: string, window?: string) => Promise<RunActionResultDto>;
}

export const makeActionsApi = (send: Send): ActionsApi => {
  const change = changePath;

  return {
    ...makeFileOperations(send, {
      filesPath: "/actions/files",
      repositoryPath: (changeId) => `${change(changeId)}/action-files`,
      filesSchema: ActionFilesResponseSchema,
      repositoriesSchema: ActionRepositoryFilesResponseSchema,
    }),
    list: async (changeId) =>
      request(send, "GET", `${change(changeId)}/actions`, mutableArray(ActionSummarySchema)),
    run: async (changeId, key, window) =>
      request(send, "POST", `${change(changeId)}/actions`, RunActionResultSchema, { body: { key, window } }),
  };
};
