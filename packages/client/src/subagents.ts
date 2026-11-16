/** The persistent subagents: the profile files that template them, and the instances of a
 * change — their messages, turns and awaits. */
import { Schema } from "effect";

import {
  SubagentFilesResponseSchema,
  SubagentInstanceSchema,
  SubagentListResponseSchema,
  SubagentMessageSchema,
  SubagentNextResponseSchema,
  SubagentProfilesResponseSchema,
  SubagentRepositoryFilesResponseSchema,
  SubagentAwaitResponseSchema,
  type SubagentCreateRequestDto,
  type SubagentFileRefDto,
  type SubagentFileWriteDto,
  type SubagentFilesResponseDto,
  type SubagentInstanceDto,
  type SubagentMessageDto,
  type SubagentNextResponseDto,
  type SubagentAwaitResponseDto,
  type SubagentProfilesResponseDto,
  type SubagentRepositoryFileRefDto,
  type SubagentRepositoryFileWriteDto,
  type SubagentRepositoryFilesResponseDto,
  type SubagentSendRequestDto,
  type SubagentTurnRequestDto,
} from "@corvi/contracts/subagents";
import type { ChangeId } from "@corvi/contracts/changes";

import { changePath, type RequestOptions, type Send, request } from "./transport.ts";

export interface SubagentsApi {
  readonly files: () => Promise<SubagentFilesResponseDto>;
  readonly writeFile: (file: SubagentFileWriteDto) => Promise<SubagentFilesResponseDto>;
  readonly deleteFile: (ref: SubagentFileRefDto) => Promise<SubagentFilesResponseDto>;
  /** The repository-scope files of one change's checkouts — the Repositories view. */
  readonly repositoryFiles: (changeId: ChangeId) => Promise<SubagentRepositoryFilesResponseDto>;
  readonly writeRepositoryFile: (
    changeId: ChangeId,
    file: SubagentRepositoryFileWriteDto,
  ) => Promise<SubagentRepositoryFilesResponseDto>;
  readonly deleteRepositoryFile: (
    changeId: ChangeId,
    ref: SubagentRepositoryFileRefDto,
  ) => Promise<SubagentRepositoryFilesResponseDto>;
  /** The profiles this change can run — discovery's resolved keys, the ones `create` takes. */
  readonly profiles: (changeId: ChangeId, options?: RequestOptions) => Promise<SubagentProfilesResponseDto>;
  /** The persistent subagent instances of a change. */
  readonly list: (changeId: ChangeId, options?: RequestOptions) => Promise<SubagentInstanceDto[]>;
  readonly read: (changeId: ChangeId, id: string, options?: RequestOptions) => Promise<SubagentInstanceDto>;
  readonly create: (
    changeId: ChangeId,
    body: SubagentCreateRequestDto,
    idempotencyKey?: string,
  ) => Promise<SubagentInstanceDto>;
  readonly open: (changeId: ChangeId, id: string) => Promise<SubagentInstanceDto>;
  readonly close: (changeId: ChangeId, id: string) => Promise<SubagentInstanceDto>;
  readonly send: (
    changeId: ChangeId,
    id: string,
    body: SubagentSendRequestDto,
    idempotencyKey?: string,
  ) => Promise<SubagentMessageDto>;
  /** The latest reply, or with `turn` the reply that answers that explicit inbound turn (null
   * when none has landed). Read-only: neither form consumes the reply. */
  readonly result: (
    changeId: ChangeId,
    id: string,
    query?: { readonly turn?: number },
    options?: RequestOptions,
  ) => Promise<SubagentMessageDto | null>;
  /** Block until one of the subagents (all of them when `ids` is empty) can be processed, or until
   * the horizon answers `timeout`. Each target answers with its own outcome, carrying the turn it
   * concerns and, when a reply settled it, that reply's number. `turn` waits for one explicit
   * inbound turn instead of each target's latest, and only a single named target accepts it. */
  readonly await: (
    changeId: ChangeId,
    query: {
      readonly ids?: readonly string[];
      readonly all?: boolean;
      readonly turn?: number;
    },
    options?: RequestOptions,
  ) => Promise<SubagentAwaitResponseDto>;
  readonly next: (
    changeId: ChangeId,
    id: string,
    after?: number,
    options?: RequestOptions,
  ) => Promise<SubagentNextResponseDto>;
  readonly turn: (
    changeId: ChangeId,
    id: string,
    body: SubagentTurnRequestDto,
    idempotencyKey?: string,
  ) => Promise<SubagentMessageDto>;
}

export const makeSubagentsApi = (send: Send): SubagentsApi => {
  const change = changePath;
  const instance = (changeId: ChangeId, id: string): string =>
    `${change(changeId)}/subagents/${encodeURIComponent(id)}`;
  // An idempotency key turns a retried write into the same request rather than a second one.
  const keyed = (idempotencyKey?: string): { headers?: Record<string, string> } =>
    idempotencyKey === undefined ? {} : { headers: { "idempotency-key": idempotencyKey } };
  // The explicit turn target, as the `?turn=` the routes read.
  const turnSuffix = (turn?: number): string => (turn === undefined ? "" : `?turn=${turn}`);

  return {
    files: async () => request(send, "GET", "/subagents/files", SubagentFilesResponseSchema),
    writeFile: async (file) =>
      request(send, "PUT", "/subagents/files", SubagentFilesResponseSchema, { body: file }),
    deleteFile: async (ref) =>
      request(
        send,
        "DELETE",
        `/subagents/files?scope=${ref.scope}${
          ref.workspace ? `&workspace=${encodeURIComponent(ref.workspace)}` : ""
        }&id=${encodeURIComponent(ref.id)}`,
        SubagentFilesResponseSchema,
      ),
    repositoryFiles: async (changeId) =>
      request(send, "GET", `${change(changeId)}/subagent-files`, SubagentRepositoryFilesResponseSchema),
    writeRepositoryFile: async (changeId, file) =>
      request(send, "PUT", `${change(changeId)}/subagent-files`, SubagentRepositoryFilesResponseSchema, {
        body: file,
      }),
    deleteRepositoryFile: async (changeId, ref) =>
      request(
        send,
        "DELETE",
        `${change(changeId)}/subagent-files?repository=${encodeURIComponent(ref.repository)}&id=${encodeURIComponent(ref.id)}`,
        SubagentRepositoryFilesResponseSchema,
      ),
    list: async (changeId, options) =>
      (await request(send, "GET", `${change(changeId)}/subagents`, SubagentListResponseSchema, options))
        .instances,
    profiles: async (changeId, options) =>
      request(send, "GET", `${change(changeId)}/subagent-profiles`, SubagentProfilesResponseSchema, options),
    read: async (changeId, id, options) =>
      request(send, "GET", instance(changeId, id), SubagentInstanceSchema, options),
    create: async (changeId, body, idempotencyKey) =>
      request(send, "POST", `${change(changeId)}/subagents`, SubagentInstanceSchema, {
        body,
        ...keyed(idempotencyKey),
      }),
    open: async (changeId, id) =>
      request(send, "POST", `${instance(changeId, id)}/open`, SubagentInstanceSchema),
    close: async (changeId, id) =>
      request(send, "POST", `${instance(changeId, id)}/close`, SubagentInstanceSchema),
    send: async (changeId, id, body, idempotencyKey) =>
      request(send, "POST", `${instance(changeId, id)}/messages`, SubagentMessageSchema, {
        body,
        ...keyed(idempotencyKey),
      }),
    result: async (changeId, id, query, options) =>
      request(
        send,
        "GET",
        `${instance(changeId, id)}/result${turnSuffix(query?.turn)}`,
        Schema.NullOr(SubagentMessageSchema),
        options,
      ),
    await: async (changeId, query, options) => {
      const params = new URLSearchParams();
      for (const id of query.ids ?? []) params.append("id", id);
      if (query.all === true) params.set("all", "1");
      if (query.turn !== undefined) params.set("turn", String(query.turn));
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      return request(
        send,
        "GET",
        `${change(changeId)}/subagents/await${suffix}`,
        SubagentAwaitResponseSchema,
        options,
      );
    },
    next: async (changeId, id, after, options) =>
      request(
        send,
        "GET",
        `${instance(changeId, id)}/next${after === undefined ? "" : `?after=${after}`}`,
        SubagentNextResponseSchema,
        options,
      ),
    turn: async (changeId, id, body, idempotencyKey) =>
      request(send, "POST", `${instance(changeId, id)}/turn`, SubagentMessageSchema, {
        body,
        ...keyed(idempotencyKey),
      }),
  };
};
