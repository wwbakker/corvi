/** The device vocabulary every module speaks: what a device is as a domain value, and the two
 * pure projections a read surface uses.
 *
 * The executable schema is `@corvi/contracts/devices`; this is the package's vocabulary, the
 * same split the workspace config uses. The token-hashing and token-generation operations are
 * OS work and live in `./node/devices`.
 */
import type { DeviceDto, DeviceViewDto } from "@corvi/contracts/devices"

/** How long a pairing code stays redeemable after it is created. */
export const PAIRING_CODE_TTL_MS = 5 * 60_000

/** A device as a domain value: the contract's record, named once here. */
export type Device = DeviceDto

/** A device as a read surface may see it: no token hash. The projection is explicit so a route
 * cannot accidentally hand over the stored record. */
export const deviceViewOf = (device: Device): DeviceViewDto => ({
  id: device.id,
  name: device.name,
  createdAt: device.createdAt,
  ...(device.lastSeenAt === undefined ? {} : { lastSeenAt: device.lastSeenAt }),
  ...(device.revokedAt === undefined ? {} : { revokedAt: device.revokedAt }),
})

/** Whether the device may still authenticate: revocation is the only thing that ends trust. */
export const isDeviceActive = (device: Device): boolean => device.revokedAt === undefined
