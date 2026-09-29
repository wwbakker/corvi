/** The persistent subagents: the profile files that template them, and the instances of a
 * change — their messages, turns and waits. */
import { Schema } from "effect"

import {
  SubagentFilesResponseSchema,
  SubagentInstanceSchema,
  SubagentListResponseSchema,
  SubagentMessageSchema,
  SubagentNextResponseSchema,
  SubagentProfilesResponseSchema,
  SubagentWaitResponseSchema,
  type SubagentCreateRequestDto,
  type SubagentFileRefDto,
  type SubagentFileWriteDto,
  type SubagentFilesResponseDto,
  type SubagentInstanceDto,
  type SubagentMessageDto,
  type SubagentNextResponseDto,
  type SubagentProfilesResponseDto,
  type SubagentSendRequestDto,
  type SubagentTurnRequestDto,
  type SubagentWaitResponseDto,
} from "@corvi/contracts/subagents"
import type { ChangeId } from "@corvi/contracts/changes"

import {
  changePath,
  decode,
  type RequestOptions,
  type Send,
} from "./transport.ts"

export interface SubagentsApi {
  readonly files: () => Promise<SubagentFilesResponseDto>
  readonly writeFile: (file: SubagentFileWriteDto) => Promise<SubagentFilesResponseDto>
  readonly deleteFile: (ref: SubagentFileRefDto) => Promise<SubagentFilesResponseDto>
  /** The profiles this change can run — discovery's resolved keys, the ones `create` takes. */
  readonly profiles: (changeId: ChangeId, options?: RequestOptions) => Promise<SubagentProfilesResponseDto>
  /** The persistent subagent instances of a change. */
  readonly list: (changeId: ChangeId, options?: RequestOptions) => Promise<SubagentInstanceDto[]>
  readonly read: (
    changeId: ChangeId,
    id: string,
    options?: RequestOptions,
  ) => Promise<SubagentInstanceDto>
  readonly create: (
    changeId: ChangeId,
    body: SubagentCreateRequestDto,
    idempotencyKey?: string,
  ) => Promise<SubagentInstanceDto>
  readonly open: (changeId: ChangeId, id: string) => Promise<SubagentInstanceDto>
  readonly close: (changeId: ChangeId, id: string) => Promise<SubagentInstanceDto>
  readonly send: (
    changeId: ChangeId,
    id: string,
    body: SubagentSendRequestDto,
    idempotencyKey?: string,
  ) => Promise<SubagentMessageDto>
  readonly result: (
    changeId: ChangeId,
    id: string,
    options?: RequestOptions,
  ) => Promise<SubagentMessageDto | null>
  readonly wait: (
    changeId: ChangeId,
    query: {
      readonly id?: string
      readonly any?: boolean
      readonly all?: boolean
      readonly since?: number
    },
    options?: RequestOptions,
  ) => Promise<SubagentWaitResponseDto>
  readonly next: (
    changeId: ChangeId,
    id: string,
    after?: number,
    options?: RequestOptions,
  ) => Promise<SubagentNextResponseDto>
  readonly turn: (
    changeId: ChangeId,
    id: string,
    body: SubagentTurnRequestDto,
    idempotencyKey?: string,
  ) => Promise<SubagentMessageDto>
}

export const makeSubagentsApi = (send: Send): SubagentsApi => {
  const change = changePath
  const instance = (changeId: ChangeId, id: string): string =>
    `${change(changeId)}/subagents/${encodeURIComponent(id)}`
  // An idempotency key turns a retried write into the same request rather than a second one.
  const keyed = (idempotencyKey?: string): { headers?: Record<string, string> } =>
    idempotencyKey === undefined ? {} : { headers: { "idempotency-key": idempotencyKey } }

  return {
    files: async () =>
      decode(SubagentFilesResponseSchema, await send("GET", "/subagents/files")),
    writeFile: async (file) =>
      decode(SubagentFilesResponseSchema, await send("PUT", "/subagents/files", { body: file })),
    deleteFile: async (ref) =>
      decode(
        SubagentFilesResponseSchema,
        await send(
          "DELETE",
          `/subagents/files?scope=${ref.scope}${
            ref.workspace ? `&workspace=${encodeURIComponent(ref.workspace)}` : ""
          }&id=${encodeURIComponent(ref.id)}`,
        ),
      ),
    list: async (changeId, options) =>
      decode(
        SubagentListResponseSchema,
        await send("GET", `${change(changeId)}/subagents`, options),
      ).instances,
    profiles: async (changeId, options) =>
      decode(
        SubagentProfilesResponseSchema,
        await send("GET", `${change(changeId)}/subagent-profiles`, options),
      ),
    read: async (changeId, id, options) =>
      decode(SubagentInstanceSchema, await send("GET", instance(changeId, id), options)),
    create: async (changeId, body, idempotencyKey) =>
      decode(
        SubagentInstanceSchema,
        await send("POST", `${change(changeId)}/subagents`, {
          body,
          ...keyed(idempotencyKey),
        }),
      ),
    open: async (changeId, id) =>
      decode(SubagentInstanceSchema, await send("POST", `${instance(changeId, id)}/open`)),
    close: async (changeId, id) =>
      decode(SubagentInstanceSchema, await send("POST", `${instance(changeId, id)}/close`)),
    send: async (changeId, id, body, idempotencyKey) =>
      decode(
        SubagentMessageSchema,
        await send("POST", `${instance(changeId, id)}/messages`, {
          body,
          ...keyed(idempotencyKey),
        }),
      ),
    result: async (changeId, id, options) =>
      decode(
        Schema.NullOr(SubagentMessageSchema),
        await send("GET", `${instance(changeId, id)}/result`, options),
      ),
    wait: async (changeId, query, options) => {
      const params = new URLSearchParams()
      if (query.id) params.set("id", query.id)
      if (query.any) params.set("any", "1")
      if (query.all) params.set("all", "1")
      if (query.since !== undefined) params.set("since", String(query.since))
      const suffix = params.size > 0 ? `?${params.toString()}` : ""
      return decode(
        SubagentWaitResponseSchema,
        await send("GET", `${change(changeId)}/subagents/wait${suffix}`, options),
      )
    },
    next: async (changeId, id, after, options) =>
      decode(
        SubagentNextResponseSchema,
        await send(
          "GET",
          `${instance(changeId, id)}/next${after === undefined ? "" : `?after=${after}`}`,
          options,
        ),
      ),
    turn: async (changeId, id, body, idempotencyKey) =>
      decode(
        SubagentMessageSchema,
        await send("POST", `${instance(changeId, id)}/turn`, {
          body,
          ...keyed(idempotencyKey),
        }),
      ),
  }
}
