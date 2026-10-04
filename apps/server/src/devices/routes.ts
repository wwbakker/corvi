/** The local device-management API: pair a machine, list the devices, revoke one.
 *
 * These routes sit on the existing loopback listener, which is already owner-only, and are
 * guarded like every other route. There is no request enforcement here yet — the external
 * listener that presents a token is wired to this module later. The raw device token leaves the
 * server exactly once, in the redemption response; every other read is a `DeviceView`.
 */
import { Effect } from "effect";

import { RedeemPairingCodeRequestSchema } from "@corvi/contracts/devices";
import { BadRequestError } from "@corvi/contracts/errors";
import { deviceViewOf } from "@corvi/configuration/devices";
import { bodyAs, guard, json } from "../capabilities/web.ts";
import { runRoute } from "../capabilities/effect/run.ts";
import {
  authenticatedDevice,
  checkRedeemLimit,
  createPairingCode,
  deviceCookie,
  isExternalListener,
  listDevices,
  redeemPairingCode,
  revokeDevice,
} from "./server/index.ts";

/** A credential-bearing pairing response is never cached: `pair` and `redeem` carry a cookie (or
 * the token in the body), and a cached `Set-Cookie` would replay a credential. The cookie itself
 * is set only on the external listener, where the browser is the client. */
const pairingHeaders = (req: Request, token: string): Record<string, string> => ({
  "cache-control": "no-store",
  ...(isExternalListener(req) ? { "set-cookie": deviceCookie(token) } : {}),
});

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
          return json(redeemed, 201, pairingHeaders(req, redeemed.token));
        }),
      ),
  },

  // The browser's pairing endpoint: the same redemption path as `redeem`, but the raw token goes
  // into the HttpOnly cookie (on the external listener) and the body carries only the device. The
  // remote page never sees the token.
  "/api/devices/pair": {
    POST: (req) =>
      runRoute(
        Effect.gen(function* () {
          // Browser pairing is only meaningful where the cookie is the credential. On the local
          // listener there is nothing to pair, and consuming a code there would mint a device
          // whose token is thrown away: refuse it before the code is touched.
          if (!isExternalListener(req)) {
            return yield* new BadRequestError({
              message: "browser pairing is only available on the remote listener",
            });
          }
          yield* checkRedeemLimit();
          const body = yield* bodyAs(req, RedeemPairingCodeRequestSchema);
          const redeemed = yield* redeemPairingCode(body);
          return json({ device: redeemed.device }, 201, pairingHeaders(req, redeemed.token));
        }),
      ),
  },

  // The page's bootstrap check. An unauthenticated request on the external listener is refused
  // by the authorizer before it reaches here, so a 200 means a device is signed in — or that this
  // is the local, tokenless listener.
  "/api/devices/session": {
    GET: (req) =>
      runRoute(
        Effect.sync(() => {
          if (!isExternalListener(req)) return json({ authenticated: true, local: true });
          const device = authenticatedDevice(req);
          return json({
            authenticated: true,
            local: false,
            ...(device === undefined ? {} : { device: deviceViewOf(device) }),
          });
        }),
      ),
  },

  "/api/devices/:id": {
    DELETE: (req) =>
      runRoute(Effect.map(revokeDevice(req.params.id), (device) => json({ device }))),
  },
});
