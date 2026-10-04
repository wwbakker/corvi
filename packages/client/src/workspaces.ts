/** Workspaces and the extension pages they may add to the shell, plus the pairing helper an
 * editor uses to add a workspace hosted by another server. */
import {
  PagesResponseSchema,
  PairRemoteWorkspaceResponseSchema,
  WorkspacesResponseSchema,
  type PairRemoteWorkspaceRequestDto,
  type PairRemoteWorkspaceResponseDto,
  type PageInfoDto,
  type WorkspacesResponseDto,
} from "@corvi/contracts/api"

import { decode, type RequestOptions, type Send } from "./transport.ts"

export interface WorkspacesApi {
  readonly list: (options?: RequestOptions) => Promise<WorkspacesResponseDto>
  readonly pages: (workspace?: string, options?: RequestOptions) => Promise<PageInfoDto[]>
  /** Ask this (local) server to pair with a workspace hosted by another server: it redeems the
   * code on the remote, server-to-server, and hands back the token for the settings draft. The
   * page never talks to the remote itself. */
  readonly pairRemote: (
    input: PairRemoteWorkspaceRequestDto,
    options?: RequestOptions,
  ) => Promise<PairRemoteWorkspaceResponseDto>
}

export const makeWorkspacesApi = (send: Send): WorkspacesApi => ({
  list: async (options) =>
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
  pairRemote: async (input, options) =>
    decode(
      PairRemoteWorkspaceResponseSchema,
      await send("POST", "/workspaces/pair-remote", { body: input, ...options }),
    ),
})
