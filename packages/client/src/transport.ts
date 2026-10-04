/** The one transport every domain namespace rides on.
 *
 * Promise-facing: React consumes the namespaces directly. Request and response types come from
 * the canonical contracts schema, so the server and the client cannot disagree silently, and a
 * failure is a classified `ClientError` rather than a bare `Error`.
 */
import { Data, Schema } from "effect"

import type { DirectoryListingSpec } from "@corvi/contracts/api"
import type { ChangeId } from "@corvi/contracts/changes"

export class ClientError extends Data.TaggedError("ClientError")<{
  readonly status?: number
  readonly message: string
  /** The server's error body when there was one, as it sent it: a 409 refusal and its reasons
   * live here, so a caller can act on more than the status. */
  readonly body?: unknown
  readonly cause?: unknown
}> {}

export interface RequestOptions {
  readonly signal?: AbortSignal
}

/** A narrow fetch shape: tests script it, and the platform fetch satisfies it. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface ClientOptions {
  readonly baseUrl: string
  readonly fetch?: FetchLike
}

/** What a namespace factory composes over: one method call out, the payload back undecoded.
 * Headers ride along when an operation names one — an idempotency key on a retried write. */
export type Send = (
  method: string,
  path: string,
  options?: { body?: unknown; signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<unknown>

/** Decodes a payload with the operation's own schema: what arrives is never trusted as is. */
export const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  payload: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema)(payload)

export const mutableArray = <S extends Schema.Constraint>(
  schema: S,
): Schema.ConstraintCodec<
  S["Type"][],
  S["Encoded"][],
  S["DecodingServices"],
  S["EncodingServices"]
> => Schema.mutable(Schema.Array(schema))

/** A change's own path: the prefix every change-scoped operation extends. */
export const changePath = (changeId: ChangeId): string =>
  `/changes/${encodeURIComponent(changeId)}`

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
  readonly request: <S extends Schema.ConstraintDecoder<unknown>>(
    method: string,
    path: string,
    schema: S,
    options?: RequestOptions & { readonly body?: unknown },
  ) => Promise<S["Type"]>
}

/** The one transport: a transport failure or a non-ok answer is a `ClientError`; the payload is
 * handed back undecoded, so each operation validates it with its own schema. */
export const transport = (options: ClientOptions): { send: Send } => {
  const request = options.fetch ?? fetch
  const baseUrl = options.baseUrl.replace(/\/$/, "")

  const send: Send = async (method, path, sendOptions = {}) => {
    const headers = {
      ...(sendOptions.body === undefined ? {} : { "content-type": "application/json" }),
      ...(sendOptions.headers ?? {}),
    }
    let response: Response
    try {
      response = await request(`${baseUrl}/api${path}`, {
        method,
        ...(sendOptions.signal ? { signal: sendOptions.signal } : {}),
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
        ...(sendOptions.body === undefined
          ? {}
          : { body: JSON.stringify(sendOptions.body) }),
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
      decode(schema, await send(method, path, requestOptions)),
  }
}
