/** The Tailscale publication of the external listener: whether the CLI is usable, whether the
 * tailnet is up, and the public HTTPS URL when this machine's external port is served.
 *
 * The transport is Tailscale only: `tailscale serve` publishes the loopback external port at
 * `https://<machine>.<tailnet>.ts.net/`, with a Tailscale-issued certificate. This shape is what
 * the settings page reads; the server capability (`apps/server/src/tailscale`) produces it.
 */
import { Schema } from "effect"

export const TailscaleStatusSchema = Schema.Struct({
  /** The `tailscale` CLI ran and answered: false means it is not installed. */
  available: Schema.Boolean,
  /** The Tailscale backend is up (`BackendState === "Running"`). */
  running: Schema.Boolean,
  /** This machine's tailnet DNS name, without the trailing dot. */
  dnsName: Schema.optional(Schema.String),
  /** The published HTTPS URL when this machine's external port is served on 443. */
  publishedUrl: Schema.optional(Schema.String),
  /** Why publication is unavailable (not installed, not connected, 443 already in use). */
  error: Schema.optional(Schema.String),
})
export type TailscaleStatusDto = typeof TailscaleStatusSchema.Type
