/** The local device-management API: pair a machine, list the devices, revoke one.
 *
 * These routes sit on the existing loopback listener, which is already owner-only, and are
 * guarded like every other route. There is no request enforcement here yet — the external
 * listener that presents a token is wired to this module later. The raw device token leaves the
 * server exactly once, in the redemption response; every other read is a `DeviceView`.
 */
import { Effect } from "effect";

import { RedeemPairingCodeRequestSchema } from "@corvi/contracts/devices";
import { bodyAs, guard, json } from "../capabilities/web.ts";
import { runRoute } from "../capabilities/effect/run.ts";
import { createPairingCode, listDevices, redeemPairingCode, revokeDevice } from "./server/index.ts";

export const devicesRoutes = guard({
  "/api/devices": {
    GET: () => runRoute(Effect.map(listDevices(), (devices) => json({ devices }))),
  },

  // Mint a short-lived, single-use pairing code. The settings UI shows it (and, later, a QR).
  "/api/devices/pairing-codes": {
    POST: () => runRoute(Effect.map(createPairingCode(), (pairing) => json(pairing, 201))),
  },

  // Exchange a code for a device token. The token is in this response and nowhere else.
  "/api/devices/pairing-codes/redeem": {
    POST: (req) =>
      runRoute(
        Effect.gen(function* () {
          const body = yield* bodyAs(req, RedeemPairingCodeRequestSchema);
          return json(yield* redeemPairingCode(body), 201);
        }),
      ),
  },

  "/api/devices/:id": {
    DELETE: (req) =>
      runRoute(Effect.map(revokeDevice(req.params.id), (device) => json({ device }))),
  },
});
