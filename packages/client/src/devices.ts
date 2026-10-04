/** Device identity and pairing operations. */
import {
  DeviceSessionResponseSchema,
  DevicesResponseSchema,
  PairDeviceResponseSchema,
  PairingCodeResponseSchema,
  RedeemPairingCodeResponseSchema,
  RevokeDeviceResponseSchema,
  type DeviceSessionResponseDto,
  type DeviceViewDto,
  type PairDeviceRequestDto,
  type PairDeviceResponseDto,
  type PairingCodeResponseDto,
  type RedeemPairingCodeRequestDto,
  type RedeemPairingCodeResponseDto,
  type RevokeDeviceResponseDto,
} from "@corvi/contracts/devices"

import { decode, type RequestOptions, type Send } from "./transport.ts"

export interface DevicesApi {
  /** The bootstrap check: whether this origin is the local listener, and which device is signed
   * in on the external one. An unauthenticated external request is a 401. */
  readonly session: (options?: RequestOptions) => Promise<DeviceSessionResponseDto>
  /** Mint a short-lived, single-use pairing code for the host to show. */
  readonly createPairingCode: (options?: RequestOptions) => Promise<PairingCodeResponseDto>
  /** Pair this browser: redeems the code through the cookie-only path, which never returns the
   * raw token to page JavaScript. */
  readonly pair: (
    input: PairDeviceRequestDto,
    options?: RequestOptions,
  ) => Promise<PairDeviceResponseDto>
  /** Redeem a code for the raw token. The gateway and CLI use this; the page does not. */
  readonly redeem: (
    input: RedeemPairingCodeRequestDto,
    options?: RequestOptions,
  ) => Promise<RedeemPairingCodeResponseDto>
  /** The devices paired to this server. */
  readonly list: (options?: RequestOptions) => Promise<DeviceViewDto[]>
  /** Revoke a device; it may no longer authenticate. */
  readonly revoke: (id: string, options?: RequestOptions) => Promise<RevokeDeviceResponseDto>
}

export const makeDevicesApi = (send: Send): DevicesApi => ({
  session: async (options) =>
    decode(DeviceSessionResponseSchema, await send("GET", "/devices/session", options)),
  createPairingCode: async (options) =>
    decode(PairingCodeResponseSchema, await send("POST", "/devices/pairing-codes", options)),
  pair: async (input, options) =>
    decode(PairDeviceResponseSchema, await send("POST", "/devices/pair", { body: input, ...options })),
  redeem: async (input, options) =>
    decode(
      RedeemPairingCodeResponseSchema,
      await send("POST", "/devices/pairing-codes/redeem", { body: input, ...options }),
    ),
  list: async (options) =>
    decode(DevicesResponseSchema, await send("GET", "/devices", options)).devices,
  revoke: async (id, options) =>
    decode(RevokeDeviceResponseSchema, await send("DELETE", `/devices/${encodeURIComponent(id)}`, options)),
})
