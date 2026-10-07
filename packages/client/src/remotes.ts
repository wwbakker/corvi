/** Remote workspaces' reachability: the current map, and a coordinated retry. */
import {
  RemoteAvailabilitySnapshotSchema,
  type RemoteAvailabilitySnapshotDto,
} from "@corvi/contracts/availability"

import { decode, type RequestOptions, type Send } from "./transport.ts"

export interface RemotesApi {
  /** The local server's current availability map. A page reconciles from this after reconnecting:
   * the stream's events are a live invalidation, not durable history. */
  readonly availability: (options?: RequestOptions) => Promise<RemoteAvailabilitySnapshotDto>
  /** Ask for an immediate coordinated health check of one source. It never replays a failed
   * write; the answer is the map as it stands. */
  readonly retry: (source: string, options?: RequestOptions) => Promise<RemoteAvailabilitySnapshotDto>
}

export const makeRemotesApi = (send: Send): RemotesApi => ({
  availability: async (options) =>
    decode(RemoteAvailabilitySnapshotSchema, await send("GET", "/remotes/availability", options)),
  retry: async (source, options) =>
    decode(
      RemoteAvailabilitySnapshotSchema,
      await send("POST", `/remotes/${encodeURIComponent(source)}/availability/retry`, options),
    ),
})
