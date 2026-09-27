/** Workspaces and the extension pages they may add to the shell. */
import {
  PagesResponseSchema,
  WorkspacesResponseSchema,
  type PageInfoDto,
  type WorkspacesResponseDto,
} from "@corvi/contracts/api"

import { decode, type RequestOptions, type Send } from "./transport.ts"

export interface WorkspacesApi {
  readonly workspaces: (options?: RequestOptions) => Promise<WorkspacesResponseDto>
  readonly pages: (workspace?: string, options?: RequestOptions) => Promise<PageInfoDto[]>
}

export const makeWorkspacesApi = (send: Send): WorkspacesApi => ({
  workspaces: async (options) =>
    decode(WorkspacesResponseSchema, await send("GET", "/workspaces", options)),
  pages: async (workspace, options) =>
    decode(
      PagesResponseSchema,
      await send(
        "GET",
        `/pages${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ""}`,
        options,
      ),
    ).pages,
})
