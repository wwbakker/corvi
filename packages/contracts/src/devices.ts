/** Device identity and pairing: the shapes the server stores and the management API speaks.
 *
 * A paired device is a machine allowed to reach this server over its external listener. The
 * server stores only a hash of the device token, never the token itself; the raw token is shown
 * once, when the pairing code is redeemed. The persisted record is deliberately separate from
 * the view every read surface returns: `DeviceView` cannot carry the hash, so a list route
 * cannot leak it by accident. `revokedAt` leaves room for scopes later; nothing here grants
 * more than "this device is the owning user".
 */
import { Schema } from "effect"

/** One paired device as it is stored in the config file. */
export const DeviceSchema = Schema.Struct({
  id: Schema.String,
  /** What the user called this machine when pairing. */
  name: Schema.String,
  /** SHA-256 of the device token. Never handed to a list or read route. */
  tokenHash: Schema.String,
  createdAt: Schema.String,
  /** When the device last authenticated; absent until it does. */
  lastSeenAt: Schema.optional(Schema.String),
  /** When the device was revoked; absent while it may still authenticate. */
  revokedAt: Schema.optional(Schema.String),
})
export type DeviceDto = typeof DeviceSchema.Type

/** A device as the management API may return it: identity and lifecycle, never the token hash. */
export const DeviceViewSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  createdAt: Schema.String,
  lastSeenAt: Schema.optional(Schema.String),
  revokedAt: Schema.optional(Schema.String),
})
export type DeviceViewDto = typeof DeviceViewSchema.Type

/** A pairing code: short-lived, single-use, and exchanged for a device token. */
export const PairingCodeSchema = Schema.String.pipe(
  Schema.check(Schema.isMinLength(4), Schema.isMaxLength(64)),
)
export type PairingCodeDto = typeof PairingCodeSchema.Type

/** What creating a pairing code answers: the code and when it stops working. */
export const PairingCodeResponseSchema = Schema.Struct({
  code: PairingCodeSchema,
  expiresAt: Schema.String,
})
export type PairingCodeResponseDto = typeof PairingCodeResponseSchema.Type

/** What redeeming a pairing code sends back. */
export const RedeemPairingCodeRequestSchema = Schema.Struct({
  code: PairingCodeSchema,
  /** What the paired machine is called; absent or blank means a default. */
  name: Schema.optional(Schema.String),
})
export type RedeemPairingCodeRequestDto = typeof RedeemPairingCodeRequestSchema.Type

/** What redeeming a pairing code answers: the new device and the raw token, shown once and
 * never retrievable again. */
export const RedeemPairingCodeResponseSchema = Schema.Struct({
  device: DeviceViewSchema,
  token: Schema.String,
})
export type RedeemPairingCodeResponseDto = typeof RedeemPairingCodeResponseSchema.Type

/** The browser pairing endpoint takes the same code the redeem route does. */
export const PairDeviceRequestSchema = RedeemPairingCodeRequestSchema
export type PairDeviceRequestDto = RedeemPairingCodeRequestDto

/** What the browser pairing endpoint answers: the new device, never the raw token. The token
 * goes into the HttpOnly cookie the browser carries, so page JavaScript never sees it. */
export const PairDeviceResponseSchema = Schema.Struct({
  device: DeviceViewSchema,
})
export type PairDeviceResponseDto = typeof PairDeviceResponseSchema.Type

/** The page's bootstrap check: which listener answered (the local one is tokenless), and which
 * device is signed in when it is the external one. An unauthenticated external request is a
 * 401 before it reaches here. */
export const DeviceSessionResponseSchema = Schema.Struct({
  authenticated: Schema.Boolean,
  local: Schema.Boolean,
  device: Schema.optional(DeviceViewSchema),
})
export type DeviceSessionResponseDto = typeof DeviceSessionResponseSchema.Type

/** The devices paired to this server, as the management API lists them. */
export const DevicesResponseSchema = Schema.Struct({
  devices: Schema.mutable(Schema.Array(DeviceViewSchema)),
})
export type DevicesResponseDto = typeof DevicesResponseSchema.Type

/** What revoking a device answers: the device as it now stands. */
export const RevokeDeviceResponseSchema = Schema.Struct({
  device: DeviceViewSchema,
})
export type RevokeDeviceResponseDto = typeof RevokeDeviceResponseSchema.Type
