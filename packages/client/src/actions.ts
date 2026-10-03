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
} from "@corvi/contracts/actions"
import type { ChangeId } from "@corvi/contracts/changes"

import {
  changePath,
  decode,
  mutableArray,
  type Send,
} from "./transport.ts"

export interface ActionsApi {
  readonly list: (changeId: ChangeId) => Promise<readonly ActionSummaryDto[]>
  readonly run: (
    changeId: ChangeId,
    key: string,
    window?: string,
  ) => Promise<RunActionResultDto>
  readonly files: () => Promise<ActionFilesResponseDto>
  readonly writeFile: (file: ActionFileWriteDto) => Promise<ActionFilesResponseDto>
  readonly deleteFile: (ref: ActionFileRefDto) => Promise<ActionFilesResponseDto>
  /** The repository-scope files of one change's checkouts — the Repositories view. */
  readonly repositoryFiles: (changeId: ChangeId) => Promise<ActionRepositoryFilesResponseDto>
  readonly writeRepositoryFile: (
    changeId: ChangeId,
    file: ActionRepositoryFileWriteDto,
  ) => Promise<ActionRepositoryFilesResponseDto>
  readonly deleteRepositoryFile: (
    changeId: ChangeId,
    ref: ActionRepositoryFileRefDto,
  ) => Promise<ActionRepositoryFilesResponseDto>
}

export const makeActionsApi = (send: Send): ActionsApi => {
  const change = changePath

  return {
    list: async (changeId) =>
      decode(
        mutableArray(ActionSummarySchema),
        await send("GET", `${change(changeId)}/actions`),
      ),
    run: async (changeId, key, window) =>
      decode(
        RunActionResultSchema,
        await send("POST", `${change(changeId)}/actions`, { body: { key, window } }),
      ),
    files: async () =>
      decode(ActionFilesResponseSchema, await send("GET", "/actions/files")),
    writeFile: async (file) =>
      decode(ActionFilesResponseSchema, await send("PUT", "/actions/files", { body: file })),
    deleteFile: async (ref) =>
      decode(
        ActionFilesResponseSchema,
        await send(
          "DELETE",
          `/actions/files?scope=${ref.scope}${
            ref.workspace ? `&workspace=${encodeURIComponent(ref.workspace)}` : ""
          }&id=${encodeURIComponent(ref.id)}`,
        ),
      ),
    repositoryFiles: async (changeId) =>
      decode(
        ActionRepositoryFilesResponseSchema,
        await send("GET", `${change(changeId)}/action-files`),
      ),
    writeRepositoryFile: async (changeId, file) =>
      decode(
        ActionRepositoryFilesResponseSchema,
        await send("PUT", `${change(changeId)}/action-files`, { body: file }),
      ),
    deleteRepositoryFile: async (changeId, ref) =>
      decode(
        ActionRepositoryFilesResponseSchema,
        await send(
          "DELETE",
          `${change(changeId)}/action-files?repository=${encodeURIComponent(ref.repository)}&id=${encodeURIComponent(ref.id)}`,
        ),
      ),
  }
}
