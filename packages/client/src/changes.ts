/** Named network operations for browser consumers.
 *
 * Promise-facing: React consumes these directly. Request and response types come from the
 * canonical contracts schema, so the server and the client cannot disagree silently, and a
 * failure is a classified `ClientError` rather than a bare `Error`.
 */
import { Data, Schema } from "effect"

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

import {
  SubagentFilesResponseSchema,
  SubagentInstanceSchema,
  SubagentListResponseSchema,
  SubagentMessageSchema,
  SubagentNextResponseSchema,
  SubagentWaitResponseSchema,
  type SubagentCreateRequestDto,
  type SubagentFileRefDto,
  type SubagentFileWriteDto,
  type SubagentFilesResponseDto,
  type SubagentInstanceDto,
  type SubagentMessageDto,
  type SubagentNextResponseDto,
  type SubagentSendRequestDto,
  type SubagentTurnRequestDto,
  type SubagentWaitResponseDto,
} from "@corvi/contracts/subagents"

import {
  AppUpdateStatusSchema,
  BranchesSchema,
  CardInfoSchema,
  ChangeSummarySchema,
  ChangeTabsResponseSchema,
  ChangeWidgetsResponseSchema,
  ChangeWireSchema,
  CompletedResponseSchema,
  CancelledResponseSchema,
  CompletionProgressSchema,
  CompletionSchema,
  CreateChangeBodySchema,
  DirectoryListingSchema,
  ForceBodySchema,
  IdentityResponseSchema,
  PagesResponseSchema,
  PlanDocSchema,
  PlanWriteBodySchema,
  RepoItemsSchema,
  RepoStateSchema,
  RepositoryViewSchema,
  SettingsViewSchema,
  StartedResponseSchema,
  TerminalsResponseSchema,
  TerminalWindowSchema,
  TextSchema,
  UrlSchema,
  WidgetSchema,
  WindowActionBodySchema,
  WizardResponseSchema,
  WorkspacesResponseSchema,
  type AppUpdateStatusDto,
  type BranchesDto,
  type CardInfoDto,
  type ChangeSummaryDto,
  type ChangeTabInfoDto,
  type ChangeWireDto,
  type CompletedResponseDto,
  type CancelledResponseDto,
  type CompletionDto,
  type CompletionProgressDto,
  type CreateChangeBodyDto,
  type DirectoryListingDto,
  type DirectoryListingSpec,
  type ForceBodyDto,
  type IdentityResponseDto,
  type PageInfoDto,
  type PlanDocDto,
  type PlanWriteBodyDto,
  type RepoItemsDto,
  type RepoStateDto,
  type ReposBodyDto,
  type RepositoryViewDto,
  type SettingsViewDto,
  type StartedResponseDto,
  type TerminalWindowDto,
  type TerminalsResponseDto,
  type TextDto,
  type UrlDto,
  type WidgetDto,
  type WidgetInfoDto,
  type WindowActionBodyDto,
  type WizardResponseDto,
  type WorkspacesResponseDto,
} from "@corvi/contracts/api"
import type { ConfigFileDto } from "@corvi/contracts/config"
import type { ChangeId } from "@corvi/contracts/changes"

export class ClientError extends Data.TaggedError("ClientError")<{
  readonly status?: number
  readonly message: string
  /** The server's error body when there was one, as it sent it: a 409 refusal and its reasons
   * live here, so a caller can act on more than the status. */
  readonly body?: unknown
  readonly cause?: unknown
}> {}

export type { DirectoryListingSpec, WidgetItemDto } from "@corvi/contracts/api"

export interface RequestOptions {
  readonly signal?: AbortSignal
}

export interface ChangesClient {
  readonly list: (options?: RequestOptions) => Promise<ChangeWireDto[]>
  /** What this server knows: the changes in its root. Discovery's probe, and the answer that
   * decides which of several candidate servers owns a change. */
  readonly identity: (options?: RequestOptions) => Promise<IdentityResponseDto>
  readonly read: (changeId: ChangeId, options?: RequestOptions) => Promise<ChangeWireDto>
  readonly summary: (changeId: ChangeId, options?: RequestOptions) => Promise<ChangeSummaryDto>
  readonly cards: (changeId: ChangeId, options?: RequestOptions) => Promise<CardInfoDto[]>
  readonly tabs: (changeId: ChangeId, options?: RequestOptions) => Promise<ChangeTabInfoDto[]>
  readonly widgets: (changeId: ChangeId, options?: RequestOptions) => Promise<WidgetInfoDto[]>
  readonly repoStates: (changeId: ChangeId, options?: RequestOptions) => Promise<RepoStateDto[]>
  readonly card: (changeId: ChangeId, card: string, options?: RequestOptions) => Promise<WidgetDto>
  readonly cardRepo: (
    changeId: ChangeId,
    card: string,
    repo: string,
    options?: RequestOptions,
  ) => Promise<RepoItemsDto>
  readonly completion: (changeId: ChangeId, options?: RequestOptions) => Promise<CompletionDto>
  readonly completionProgress: (
    changeId: ChangeId,
    options?: RequestOptions,
  ) => Promise<CompletionProgressDto | null>
  readonly terminals: (options?: RequestOptions) => Promise<TerminalsResponseDto>
  readonly terminalUrl: (changeId: ChangeId, options?: RequestOptions) => Promise<UrlDto>
  readonly wizard: (workspace?: string, options?: RequestOptions) => Promise<WizardResponseDto>
  readonly pages: (workspace?: string, options?: RequestOptions) => Promise<PageInfoDto[]>
  readonly directories: (
    spec: DirectoryListingSpec,
    options?: RequestOptions,
  ) => Promise<DirectoryListingDto>
  readonly branches: (path: string, options?: RequestOptions) => Promise<BranchesDto>
  readonly settings: (options?: RequestOptions) => Promise<SettingsViewDto>
  readonly writeSettings: (settings: ConfigFileDto) => Promise<SettingsViewDto>
  readonly workspaces: (options?: RequestOptions) => Promise<WorkspacesResponseDto>
  readonly description: (changeId: ChangeId, options?: RequestOptions) => Promise<TextDto>
  readonly plan: (changeId: ChangeId, options?: RequestOptions) => Promise<PlanDocDto>
  readonly writePlan: (
    changeId: ChangeId,
    body: PlanWriteBodyDto,
    options?: RequestOptions,
  ) => Promise<PlanDocDto>
  readonly create: (body: CreateChangeBodyDto) => Promise<StartedResponseDto>
  readonly start: (changeId: ChangeId) => Promise<StartedResponseDto>
  readonly complete: (changeId: ChangeId, options?: ForceBodyDto) => Promise<CompletedResponseDto>
  readonly cancel: (changeId: ChangeId, options?: ForceBodyDto) => Promise<CancelledResponseDto>
  readonly rename: (
    changeId: ChangeId,
    patch: { readonly state?: string; readonly title?: string },
  ) => Promise<ChangeWireDto>
  readonly setRepositories: (
    changeId: ChangeId,
    body: ReposBodyDto,
  ) => Promise<ChangeWireDto>
  readonly cardAction: (
    changeId: ChangeId,
    card: string,
    action: string,
    arg?: string,
  ) => Promise<WidgetDto>
  readonly cardRepoAction: (
    changeId: ChangeId,
    card: string,
    action: string,
    arg?: string,
  ) => Promise<RepoItemsDto>
  readonly windowAction: (
    changeId: ChangeId,
    action: WindowActionBodyDto,
  ) => Promise<TerminalWindowDto[]>
  readonly terminalActions: (changeId: ChangeId) => Promise<readonly ActionSummaryDto[]>
  readonly runAction: (
    changeId: ChangeId,
    key: string,
    window?: string,
  ) => Promise<RunActionResultDto>
  readonly actionFiles: () => Promise<ActionFilesResponseDto>
  readonly writeActionFile: (file: ActionFileWriteDto) => Promise<ActionFilesResponseDto>
  readonly deleteActionFile: (ref: ActionFileRefDto) => Promise<ActionFilesResponseDto>
  readonly subagentFiles: () => Promise<SubagentFilesResponseDto>
  readonly writeSubagentFile: (file: SubagentFileWriteDto) => Promise<SubagentFilesResponseDto>
  readonly deleteSubagentFile: (ref: SubagentFileRefDto) => Promise<SubagentFilesResponseDto>
  /** The persistent subagent instances of a change. */
  readonly subagents: (changeId: ChangeId, options?: RequestOptions) => Promise<SubagentInstanceDto[]>
  readonly subagent: (changeId: ChangeId, id: string, options?: RequestOptions) => Promise<SubagentInstanceDto>
  readonly createSubagent: (
    changeId: ChangeId,
    body: SubagentCreateRequestDto,
    idempotencyKey?: string,
  ) => Promise<SubagentInstanceDto>
  readonly openSubagent: (changeId: ChangeId, id: string) => Promise<SubagentInstanceDto>
  readonly closeSubagent: (changeId: ChangeId, id: string) => Promise<SubagentInstanceDto>
  readonly sendSubagent: (
    changeId: ChangeId,
    id: string,
    body: SubagentSendRequestDto,
    idempotencyKey?: string,
  ) => Promise<SubagentMessageDto>
  readonly subagentResult: (
    changeId: ChangeId,
    id: string,
    options?: RequestOptions,
  ) => Promise<SubagentMessageDto | null>
  readonly waitSubagent: (
    changeId: ChangeId,
    query: { readonly id?: string; readonly any?: boolean; readonly all?: boolean; readonly since?: number },
    options?: RequestOptions,
  ) => Promise<SubagentWaitResponseDto>
  readonly nextSubagent: (
    changeId: ChangeId,
    id: string,
    after?: number,
    options?: RequestOptions,
  ) => Promise<SubagentNextResponseDto>
  readonly subagentTurn: (
    changeId: ChangeId,
    id: string,
    body: SubagentTurnRequestDto,
    idempotencyKey?: string,
  ) => Promise<SubagentMessageDto>
  readonly inspectRepositories: (changeId: ChangeId) => Promise<readonly RepositoryViewDto[]>
  /** What the app knows about updating itself: eligible, what is new, and the update journal.
   * Local reads only — the check runs on its own cadence, or when `checkUpdate` asks. */
  readonly updateStatus: (options?: RequestOptions) => Promise<AppUpdateStatusDto>
  /** Runs a check now (one fetch), and answers with the fresh status. */
  readonly checkUpdate: (options?: RequestOptions) => Promise<AppUpdateStatusDto>
  /** Starts the update and answers at once with the opening status — 202 while the steps run in
   * the background. A page watches the journal (`updateStatus().progress`), so a reload shows
   * where the run is. */
  readonly startUpdate: (options?: RequestOptions) => Promise<AppUpdateStatusDto>
}

/** A narrow fetch shape: tests script it, and the platform fetch satisfies it. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface ClientOptions {
  readonly baseUrl: string
  readonly fetch?: FetchLike
}

const mutableArray = <A, I>(schema: Schema.Schema<A, I>): Schema.Schema<A[], I[]> =>
  Schema.mutable(Schema.Array(schema))

/** The query a directory listing names: an explicit path wins over the context's start directory,
 * an empty path is not set, and hidden directories have to be asked for by name. Shared by the
 * browser and the settings picker so they cannot ask the same question differently. */
export const directoryListingQuery = (spec: DirectoryListingSpec): string => {
  const params = new URLSearchParams()
  if (spec.path) params.set("path", spec.path)
  else if (spec.workspace) params.set("workspace", spec.workspace)
  if (spec.hidden) params.set("hidden", "1")
  return params.toString()
}

/** A request against the server, decoded with a caller-supplied schema: for modules whose DTOs
 * are not part of the core contract (an included integration's browser half owns its own
 * schemas), with the same transport classification as the core client. */
export interface WireClient {
  readonly request: <A, I>(
    method: string,
    path: string,
    schema: Schema.Schema<A, I>,
    options?: RequestOptions & { readonly body?: unknown },
  ) => Promise<A>
}

/** The one transport: a transport failure or a non-ok answer is a `ClientError`; the payload is
 * handed back undecoded, so each operation validates it with its own schema. */
const transport = (
  options: ClientOptions,
): {
  send: (
    method: string,
    path: string,
    options?: { body?: unknown; signal?: AbortSignal },
  ) => Promise<unknown>
} => {
  const request = options.fetch ?? fetch
  const baseUrl = options.baseUrl.replace(/\/$/, "")

  const send = async (
    method: string,
    path: string,
    options: { body?: unknown; signal?: AbortSignal; headers?: Record<string, string> } = {},
  ): Promise<unknown> => {
    const headers = {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.headers ?? {}),
    };
    let response: Response
    try {
      response = await request(`${baseUrl}/api${path}`, {
        method,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      })
    } catch (cause) {
      throw new ClientError({ message: "the server could not be reached", cause })
    }
    // A response that is not JSON is not this server's: the page's own fallback or a proxy
    // answered. Saying that beats a JSON parse error the caller cannot act on.
    const contentType = response.headers.get("content-type") ?? ""
    if (!contentType.includes("json"))
      throw new ClientError({
        status: response.status,
        message: `the server has no ${path} — it is probably running older code, restart it`,
      })
    if (!response.ok) {
      // The body is read, not discarded: a structured refusal is how the dialogs learn what to
      // ask about. A body that is not JSON leaves it undefined, as an empty one would.
      const body = await response.json().catch(() => undefined)
      const message = (body as { error?: unknown } | undefined)?.error
      throw new ClientError({
        status: response.status,
        message:
          typeof message === "string"
            ? message
            : response.statusText || `request failed: ${response.status}`,
        body,
      })
    }
    return response.json()
  }

  return { send }
}

export const makeWireClient = (options: ClientOptions): WireClient => {
  const { send } = transport(options)
  return {
    request: async (method, path, schema, requestOptions = {}) =>
      Schema.decodeUnknownSync(schema)(await send(method, path, requestOptions)),
  }
}

export const makeChangesClient = (options: ClientOptions): ChangesClient => {
  const { send } = transport(options)

  const decode = <A, I>(schema: Schema.Schema<A, I>, payload: unknown): A =>
    Schema.decodeUnknownSync(schema)(payload)

  const change = (changeId: ChangeId): string => `/changes/${encodeURIComponent(changeId)}`

  return {
    list: async (options) =>
      decode(mutableArray(ChangeWireSchema), await send("GET", "/changes", options)),
    identity: async (options) =>
      decode(IdentityResponseSchema, await send("GET", "/identity", options)),
    read: async (changeId, options) =>
      decode(ChangeWireSchema, await send("GET", change(changeId), options)),
    summary: async (changeId, options) =>
      decode(ChangeSummarySchema, await send("GET", `${change(changeId)}/summary`, options)),
    cards: async (changeId, options) =>
      decode(mutableArray(CardInfoSchema), await send("GET", `${change(changeId)}/integrations`, options)),
    tabs: async (changeId, options) =>
      decode(ChangeTabsResponseSchema, await send("GET", `${change(changeId)}/tabs`, options)).tabs,
    widgets: async (changeId, options) =>
      decode(ChangeWidgetsResponseSchema, await send("GET", `${change(changeId)}/widgets`, options))
        .widgets,
    repoStates: async (changeId, options) =>
      decode(mutableArray(RepoStateSchema), await send("GET", `${change(changeId)}/repos`, options)),
    card: async (changeId, card, options) =>
      decode(WidgetSchema, await send("GET", `${change(changeId)}/${encodeURIComponent(card)}`, options)),
    cardRepo: async (changeId, card, repo, options) =>
      decode(
        RepoItemsSchema,
        await send(
          "GET",
          `${change(changeId)}/${encodeURIComponent(card)}/repo?path=${encodeURIComponent(repo)}`,
          options,
        ),
      ),
    completion: async (changeId, options) =>
      decode(CompletionSchema, await send("GET", `${change(changeId)}/complete`, options)),
    completionProgress: async (changeId, options) =>
      decode(
        Schema.NullOr(CompletionProgressSchema),
        await send("GET", `${change(changeId)}/complete/progress`, options),
      ),
    terminals: async (options) =>
      decode(TerminalsResponseSchema, await send("GET", "/terminals", options)),
    terminalUrl: async (changeId, options) =>
      decode(UrlSchema, await send("GET", `${change(changeId)}/terminal`, options)),
    wizard: async (workspace, options) =>
      decode(
        WizardResponseSchema,
        await send(
          "GET",
          `/wizard${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ""}`,
          options,
        ),
      ),
    pages: async (workspace, options) =>
      decode(
        PagesResponseSchema,
        await send(
          "GET",
          `/pages${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ""}`,
          options,
        ),
      ).pages,
    directories: async (spec, options) => {
      const query = directoryListingQuery(spec)
      return decode(
        DirectoryListingSchema,
        await send("GET", `/repos${query ? `?${query}` : ""}`, options),
      )
    },
    branches: async (path, options) =>
      decode(
        BranchesSchema,
        await send("GET", `/repos/branches?path=${encodeURIComponent(path)}`, options),
      ),
    settings: async (options) => decode(SettingsViewSchema, await send("GET", "/settings", options)),
    writeSettings: async (settings) =>
      decode(SettingsViewSchema, await send("PUT", "/settings", { body: settings })),
    workspaces: async (options) =>
      decode(WorkspacesResponseSchema, await send("GET", "/workspaces", options)),
    description: async (changeId, options) =>
      decode(TextSchema, await send("GET", `${change(changeId)}/description`, options)),
    plan: async (changeId, options) =>
      decode(PlanDocSchema, await send("GET", `${change(changeId)}/plan`, options)),
    writePlan: async (changeId, body, options) =>
      decode(PlanDocSchema, await send("PUT", `${change(changeId)}/plan`, { body, ...options })),
    create: async (body) =>
      decode(StartedResponseSchema, await send("POST", "/changes", { body })),
    start: async (changeId) =>
      decode(StartedResponseSchema, await send("POST", `${change(changeId)}/start`)),
    complete: async (changeId, options) =>
      decode(
        CompletedResponseSchema,
        await send("POST", `${change(changeId)}/complete`, { body: options ?? {} }),
      ),
    cancel: async (changeId, options) =>
      decode(
        CancelledResponseSchema,
        await send("POST", `${change(changeId)}/cancel`, { body: options ?? {} }),
      ),
    rename: async (changeId, patch) =>
      decode(ChangeWireSchema, await send("PATCH", change(changeId), { body: patch })),
    setRepositories: async (changeId, body) =>
      decode(ChangeWireSchema, await send("POST", `${change(changeId)}/repos`, { body })),
    cardAction: async (changeId, card, action, arg) =>
      decode(
        WidgetSchema,
        await send(
          "POST",
          `${change(changeId)}/${encodeURIComponent(card)}/${encodeURIComponent(action)}`,
          { body: arg === undefined ? {} : { arg } },
        ),
      ),
    cardRepoAction: async (changeId, card, action, arg) =>
      decode(
        RepoItemsSchema,
        await send(
          "POST",
          `${change(changeId)}/${encodeURIComponent(card)}/${encodeURIComponent(action)}`,
          { body: arg === undefined ? {} : { arg } },
        ),
      ),
    windowAction: async (changeId, action) =>
      decode(
        mutableArray(TerminalWindowSchema),
        await send("POST", `${change(changeId)}/terminal/windows`, { body: action }),
      ),
    terminalActions: async (changeId) =>
      decode(
        mutableArray(ActionSummarySchema),
        await send("GET", `${change(changeId)}/terminal/actions`),
      ),
    runAction: async (changeId, key, window) =>
      decode(
        RunActionResultSchema,
        await send("POST", `${change(changeId)}/terminal/actions`, { body: { key, window } }),
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
    subagentFiles: async () =>
      decode(SubagentFilesResponseSchema, await send("GET", "/subagents/files")),
    writeSubagentFile: async (file) =>
      decode(SubagentFilesResponseSchema, await send("PUT", "/subagents/files", { body: file })),
    deleteSubagentFile: async (ref) =>
      decode(
        SubagentFilesResponseSchema,
        await send(
          "DELETE",
          `/subagents/files?scope=${ref.scope}${
            ref.workspace ? `&workspace=${encodeURIComponent(ref.workspace)}` : ""
          }&id=${encodeURIComponent(ref.id)}`,
        ),
      ),
    subagents: async (changeId, options) =>
      decode(
        SubagentListResponseSchema,
        await send("GET", `${change(changeId)}/subagents`, options),
      ).instances,
    subagent: async (changeId, id, options) =>
      decode(SubagentInstanceSchema, await send("GET", `${change(changeId)}/subagents/${encodeURIComponent(id)}`, options)),
    createSubagent: async (changeId, body, idempotencyKey) =>
      decode(
        SubagentInstanceSchema,
        await send("POST", `${change(changeId)}/subagents`, {
          body,
          ...(idempotencyKey === undefined ? {} : { headers: { "idempotency-key": idempotencyKey } }),
        }),
      ),
    openSubagent: async (changeId, id) =>
      decode(
        SubagentInstanceSchema,
        await send("POST", `${change(changeId)}/subagents/${encodeURIComponent(id)}/open`),
      ),
    closeSubagent: async (changeId, id) =>
      decode(
        SubagentInstanceSchema,
        await send("POST", `${change(changeId)}/subagents/${encodeURIComponent(id)}/close`),
      ),
    sendSubagent: async (changeId, id, body, idempotencyKey) =>
      decode(
        SubagentMessageSchema,
        await send("POST", `${change(changeId)}/subagents/${encodeURIComponent(id)}/messages`, {
          body,
          ...(idempotencyKey === undefined ? {} : { headers: { "idempotency-key": idempotencyKey } }),
        }),
      ),
    subagentResult: async (changeId, id, options) =>
      decode(
        Schema.NullOr(SubagentMessageSchema),
        await send("GET", `${change(changeId)}/subagents/${encodeURIComponent(id)}/result`, options),
      ),
    waitSubagent: async (changeId, query, options) => {
      const params = new URLSearchParams();
      if (query.id) params.set("id", query.id);
      if (query.any) params.set("any", "1");
      if (query.all) params.set("all", "1");
      if (query.since !== undefined) params.set("since", String(query.since));
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      return decode(
        SubagentWaitResponseSchema,
        await send("GET", `${change(changeId)}/subagents/wait${suffix}`, options),
      );
    },
    nextSubagent: async (changeId, id, after, options) =>
      decode(
        SubagentNextResponseSchema,
        await send(
          "GET",
          `${change(changeId)}/subagents/${encodeURIComponent(id)}/next${
            after === undefined ? "" : `?after=${after}`
          }`,
          options,
        ),
      ),
    subagentTurn: async (changeId, id, body, idempotencyKey) =>
      decode(
        SubagentMessageSchema,
        await send("POST", `${change(changeId)}/subagents/${encodeURIComponent(id)}/turn`, {
          body,
          ...(idempotencyKey === undefined ? {} : { headers: { "idempotency-key": idempotencyKey } }),
        }),
      ),
    inspectRepositories: async (changeId) =>
      decode(mutableArray(RepositoryViewSchema), await send("GET", `${change(changeId)}/repositories`)),
    updateStatus: async (options) =>
      decode(AppUpdateStatusSchema, await send("GET", "/app/update", options)),
    checkUpdate: async (options) =>
      decode(AppUpdateStatusSchema, await send("POST", "/app/update/check", options)),
    startUpdate: async (options) =>
      decode(AppUpdateStatusSchema, await send("POST", "/app/update", options)),
  }
}
