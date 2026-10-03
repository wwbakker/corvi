/** The device token hash is a secret in the config file, and the settings page is one of the
 * read surfaces for that file: this is where its value is replaced by the mask and where the
 * write path keeps what is stored.
 *
 * Devices are managed by their own API, not by the settings page. The page may see that a device
 * exists and what it is called; it never sees the hash, and a save that hands the masked list
 * back cannot change what is stored (`redactDeviceHashes` only redacts, and the write path in
 * `./settings.ts` always keeps the stored devices).
 */
import type { DeviceDto } from "@corvi/contracts/devices";
import { MASK } from "./secrets.ts";

/** The part of a config that carries devices. `Config` (what is in effect) and `ConfigFile`
 * (what is written) have the same shape here, which is why this is generic over it. */
type WithDevices = { devices?: readonly DeviceDto[] };

/** A copy of the value with every stored device token hash replaced by the mask. The device
 * records themselves are copied, so rewriting a hash never reaches the config object a request
 * in flight is reading. */
export const redactDeviceHashes = <T extends WithDevices>(value: T): T => ({
  ...value,
  ...(value.devices === undefined
    ? {}
    : { devices: value.devices.map((device) => ({ ...device, tokenHash: MASK })) }),
});
