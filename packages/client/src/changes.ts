/** Named network operations for browser consumers.
 *
 * Promise-facing: React consumes these directly. Request and response types come from the
 * canonical contracts schema, so the server and the client cannot disagree silently, and a
 * failure is a classified `ClientError` rather than a bare `Error`.
 */
import { Data, Schema } from "effect"

import {
  ActionSummarySchema,
  RunActionResultSchema,
  type ActionSummaryDto,
  type RunActionResultDto,
} from "@corvi/contracts/actions"

import {
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
  PagesResponseSchema,
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
  type PageInfoDto,
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
  type WizardStepInfoDto,
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
  readonly wizardSteps: (workspace?: string, options?: RequestOptions) => Promise<WizardStepInfoDto[]>
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
  readonly plan: (changeId: ChangeId, options?: RequestOptions) => Promise<TextDto>
  readonly writePlan: (changeId: ChangeId, text: string) => Promise<TextDto>
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
  readonly inspectRepositories: (changeId: ChangeId) => Promise<readonly RepositoryViewDto[]>
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
    options: { body?: unknown; signal?: AbortSignal } = {},
  ): Promise<unknown> => {
    let response: Response
    try {
      response = await request(`${baseUrl}/api${path}`, {
        method,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(options.body) }),
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
    wizardSteps: async (workspace, options) =>
      decode(
        WizardResponseSchema,
        await send(
          "GET",
          `/wizard${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ""}`,
          options,
        ),
      ).steps,
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
      decode(TextSchema, await send("GET", `${change(changeId)}/plan`, options)),
    writePlan: async (changeId, text) =>
      decode(TextSchema, await send("PUT", `${change(changeId)}/plan`, { body: { text } })),
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
    inspectRepositories: async (changeId) =>
      decode(mutableArray(RepositoryViewSchema), await send("GET", `${change(changeId)}/repositories`)),
  }
}
