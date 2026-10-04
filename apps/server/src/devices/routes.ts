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
import {
  checkRedeemLimit,
  createPairingCode,
  deviceCookie,
  isExternalListener,
  listDevices,
  redeemPairingCode,
  revokeDevice,
} from "./server/index.ts";

export const devicesRoutes = guard({
  "/api/devices": {
    GET: () => runRoute(Effect.map(listDevices(), (devices) => json({ devices }))),
  },

  // Mint a short-lived, single-use pairing code. The settings UI shows it (and, later, a QR).
  "/api/devices/pairing-codes": {
    POST: () => runRoute(Effect.map(createPairingCode(), (pairing) => json(pairing, 201))),
  },

  // Exchange a code for a device token. The token is in this response and nowhere else. On the
  // external listener the browser also gets it as an HttpOnly cookie; the local listener does
  // not need one, and the gateway/CLI read it from the body.
  "/api/devices/pairing-codes/redeem": {
    POST: (req) =>
      runRoute(
        Effect.gen(function* () {
          // Count the attempt before reading the body: this route is tokenless, so a flood of
          // malformed or oversized bodies must not be free.
          yield* checkRedeemLimit();
          const body = yield* bodyAs(req, RedeemPairingCodeRequestSchema);
          const redeemed = yield* redeemPairingCode(body);
          const headers = isExternalListener(req) ? { "set-cookie": deviceCookie(redeemed.token) } : undefined;
          return json(redeemed, 201, headers);
        }),
      ),
  },

  "/api/devices/:id": {
    DELETE: (req) =>
      runRoute(Effect.map(revokeDevice(req.params.id), (device) => json({ device }))),
  },
});
