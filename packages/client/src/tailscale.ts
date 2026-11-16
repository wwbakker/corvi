/** Publishing the external listener through Tailscale. */
import { TailscaleStatusSchema, type TailscaleStatusDto } from "@corvi/contracts/tailscale";

import { decode, type RequestOptions, type Send, request } from "./transport.ts";

export interface TailscaleApi {
  /** What the Tailscale CLI is doing, and whether our external port is published. */
  readonly status: (options?: RequestOptions) => Promise<TailscaleStatusDto>;
  /** Publish the external listener at https 443. Refused when 443 already serves something else. */
  readonly publish: (options?: RequestOptions) => Promise<TailscaleStatusDto>;
  /** Remove only our own serve mapping. */
  readonly unpublish: (options?: RequestOptions) => Promise<TailscaleStatusDto>;
}

export const makeTailscaleApi = (send: Send): TailscaleApi => ({
  status: async (options) => request(send, "GET", "/tailscale", TailscaleStatusSchema, options),
  publish: async (options) => request(send, "POST", "/tailscale/publish", TailscaleStatusSchema, options),
  unpublish: async (options) => request(send, "POST", "/tailscale/unpublish", TailscaleStatusSchema, options),
});
