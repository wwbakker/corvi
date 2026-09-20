/** Named network operations for browser consumers.
 *
 * Promise-facing: React consumes these directly. Request and response types come from the
 * canonical contracts schema, so the server and the client cannot disagree silently, and a
 * failure is a classified `ClientError` rather than a bare `Error`.
 */
import { Data, Schema } from "effect"

import { RepositoryViewSchema, type RepositoryViewDto } from "@corvi/contracts/api"
import type { ChangeId } from "@corvi/contracts/changes"

export class ClientError extends Data.TaggedError("ClientError")<{
  readonly status?: number
  readonly message: string
  readonly cause?: unknown
}> {}

export interface ChangesClient {
  readonly inspectRepositories: (changeId: ChangeId) => Promise<readonly RepositoryViewDto[]>
}

/** A narrow fetch shape: tests script it, and the platform fetch satisfies it. */
export type FetchLike = (input: string) => Promise<Response>

export interface ClientOptions {
  readonly baseUrl: string
  readonly fetch?: FetchLike
}

export const makeChangesClient = (options: ClientOptions): ChangesClient => {
  const request = options.fetch ?? fetch
  const baseUrl = options.baseUrl.replace(/\/$/, "")
  return {
    inspectRepositories: async (changeId) => {
      let response: Response
      try {
        response = await request(`${baseUrl}/api/changes/${encodeURIComponent(changeId)}/repositories`)
      } catch (cause) {
        throw new ClientError({ message: "the server could not be reached", cause })
      }
      if (!response.ok)
        throw new ClientError({ status: response.status, message: `request failed: ${response.status}` })
      return Schema.decodeUnknownSync(Schema.Array(RepositoryViewSchema))(await response.json())
    },
  }
}
