/** The actions a change may run, and the action files that configure them. */
import {
  ActionFilesResponseSchema,
  ActionSummarySchema,
  RunActionResultSchema,
  type ActionFileRefDto,
  type ActionFileWriteDto,
  type ActionFilesResponseDto,
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
  readonly terminalActions: (changeId: ChangeId) => Promise<readonly ActionSummaryDto[]>
  readonly runAction: (
    changeId: ChangeId,
    key: string,
    window?: string,
  ) => Promise<RunActionResultDto>
  readonly actionFiles: () => Promise<ActionFilesResponseDto>
  readonly writeActionFile: (file: ActionFileWriteDto) => Promise<ActionFilesResponseDto>
  readonly deleteActionFile: (ref: ActionFileRefDto) => Promise<ActionFilesResponseDto>
}

export const makeActionsApi = (send: Send): ActionsApi => {
  const change = changePath

  return {
    terminalActions: async (changeId) =>
      decode(
        mutableArray(ActionSummarySchema),
        await send("GET", `${change(changeId)}/actions`),
      ),
    runAction: async (changeId, key, window) =>
      decode(
        RunActionResultSchema,
        await send("POST", `${change(changeId)}/actions`, { body: { key, window } }),
      ),
    actionFiles: async () =>
      decode(ActionFilesResponseSchema, await send("GET", "/actions/files")),
    writeActionFile: async (file) =>
      decode(ActionFilesResponseSchema, await send("PUT", "/actions/files", { body: file })),
    deleteActionFile: async (ref) =>
      decode(
        ActionFilesResponseSchema,
        await send(
          "DELETE",
          `/actions/files?scope=${ref.scope}${
            ref.workspace ? `&workspace=${encodeURIComponent(ref.workspace)}` : ""
          }&id=${encodeURIComponent(ref.id)}`,
        ),
      ),
  }
}
