/** Publishing the external listener through Tailscale. */
import { TailscaleStatusSchema, type TailscaleStatusDto } from "@corvi/contracts/tailscale"

import { decode, type RequestOptions, type Send } from "./transport.ts"

export interface TailscaleApi {
  /** What the Tailscale CLI is doing, and whether our external port is published. */
  readonly status: (options?: RequestOptions) => Promise<TailscaleStatusDto>
  /** Publish the external listener at https 443. Refused when 443 already serves something else. */
  readonly publish: (options?: RequestOptions) => Promise<TailscaleStatusDto>
  /** Remove only our own serve mapping. */
  readonly unpublish: (options?: RequestOptions) => Promise<TailscaleStatusDto>
}

export const makeTailscaleApi = (send: Send): TailscaleApi => ({
  status: async (options) =>
    decode(TailscaleStatusSchema, await send("GET", "/tailscale", options)),
  publish: async (options) =>
    decode(TailscaleStatusSchema, await send("POST", "/tailscale/publish", options)),
  unpublish: async (options) =>
    decode(TailscaleStatusSchema, await send("POST", "/tailscale/unpublish", options)),
})
