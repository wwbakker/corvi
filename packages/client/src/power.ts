/** The power control's server API: this machine's arm state, arming it, disarming it.
 *
 * Each machine owns its own state, so the page reads each with that machine's own client (the
 * local server, or a remote workspace through its gateway prefix). Arm and disarm always go to
 * the local server, which fans the command out to the selected remotes. */
import {
  PowerArmResponseSchema,
  PowerStateSchema,
  type PowerArmResponseDto,
  type PowerStateDto,
} from "@corvi/contracts/power"

import { decode, type RequestOptions, type Send } from "./transport.ts"

export interface PowerApi {
  /** This server's arm state plus the agents its countdown waits on. */
  readonly state: (options?: RequestOptions) => Promise<PowerStateDto>
  /** Arm the named targets; `""` is the local machine. */
  readonly arm: (
    targets: readonly string[],
    options?: RequestOptions,
  ) => Promise<PowerArmResponseDto>
  /** Disarm the named targets; `""` is the local machine. */
  readonly disarm: (
    targets: readonly string[],
    options?: RequestOptions,
  ) => Promise<PowerArmResponseDto>
}

export const makePowerApi = (send: Send): PowerApi => ({
  state: async (options) => decode(PowerStateSchema, await send("GET", "/power", options)),
  arm: async (targets, options) =>
    decode(
      PowerArmResponseSchema,
      await send("POST", "/power/arm", { body: { targets }, ...options }),
    ),
  disarm: async (targets, options) =>
    decode(
      PowerArmResponseSchema,
      await send("POST", "/power/disarm", { body: { targets }, ...options }),
    ),
})
