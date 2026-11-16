/** The server's own identity: what a probe asks before anything else. */
import { IdentityResponseSchema, type IdentityResponseDto } from "@corvi/contracts/api";

import { decode, type RequestOptions, type Send, request } from "./transport.ts";

export interface ServerApi {
  /** What this server knows: the changes in its root. Discovery's probe, and the answer that
   * decides which of several candidate servers owns a change. */
  readonly identity: (options?: RequestOptions) => Promise<IdentityResponseDto>;
}

export const makeServerApi = (send: Send): ServerApi => ({
  identity: async (options) => request(send, "GET", "/identity", IdentityResponseSchema, options),
});
