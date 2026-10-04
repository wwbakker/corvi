/** Device-token authentication for the external listener.
 *
 * The local listener is loopback-only and tokenless, exactly as it always was. The external
 * listener is loopback too, but it is published to the tailnet, so every `/api/*` request on it
 * must present a device token: the gateway and CLI as `Authorization: Bearer`, the page as an
 * `HttpOnly` cookie that its SSE and same-origin terminal WebSocket carry for it. The one
 * exception is redemption itself — a client has no token before it redeems a code — which is why
 * that route is rate-limited separately.
 *
 * Loopback traffic to the local listener never reaches this module, so "local trusted / remote
 * authenticated" is a property of the listener, not of a peer address.
 */
import { Effect } from "effect";

import type { DeviceDto } from "@corvi/contracts/devices";
import { isDeviceActive } from "@corvi/configuration/devices";
import { deviceTokenMatches } from "@corvi/configuration/node/devices";
import { mutateConfigFile, reloadConfig, runtimeConfig } from "../../workspace/server/index.ts";

/** The cookie the remote page carries. The page never reads it; the browser sends it for the
 * page, its SSE stream and its same-origin terminal WebSocket. */
export const DEVICE_COOKIE = "corvi_device";

/** A year: the device token is long-lived and revocation — not expiry — is the control. */
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** The property the external listener marks a request with, so the redeem route can tell which
 * listener answered and set the cookie only on the external one. */
const EXTERNAL_LISTENER = "corviExternalListener";
type MarkedRequest = Request & { [EXTERNAL_LISTENER]?: true };

/** Whether this request arrived on the external (token-required) listener. */
export const isExternalListener = (request: Request): boolean =>
  (request as MarkedRequest)[EXTERNAL_LISTENER] === true;

/** The paths reachable without a token: pairing happens before a token exists. Redeem returns
 * the raw token for the gateway/CLI; pair puts it in the HttpOnly cookie and returns no token. */
const PAIRING_PATHS = new Set(["/api/devices/pairing-codes/redeem", "/api/devices/pair"]);

const bearerToken = (request: Request): string | undefined => {
  const header = request.headers.get("authorization");
  if (header === null) return undefined;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header);
  return match?.[1]?.trim() || undefined;
};

const cookieToken = (request: Request): string | undefined => {
  const header = request.headers.get("cookie");
  if (header === null) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== DEVICE_COOKIE) continue;
    const raw = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
};

/** The token the request presents, from the bearer header the gateway/CLI use or the cookie the
 * page uses. */
export const deviceTokenOf = (request: Request): string | undefined =>
  bearerToken(request) ?? cookieToken(request);

/** The active, non-revoked device whose stored hash matches the presented token. Constant-time
 * per comparison; a revoked device never matches, which is what makes revocation take effect on
 * the next request. */
export const authenticatedDevice = (request: Request): DeviceDto | undefined => {
  const token = deviceTokenOf(request);
  if (token === undefined) return undefined;
  return runtimeConfig().devices.find(
    (device) => isDeviceActive(device) && deviceTokenMatches(token, device.tokenHash),
  );
};

/** Whether this request must present a token. The page and its assets are open — they carry no
 * data — while the API and the gateway to a remote workspace are not: the gateway injects the
 * remote's device token, so it must not be an open proxy. The redeem bootstrap is open because
 * it is how a device gets a token. */
const requiresToken = (request: Request): boolean => {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith("/api/") && !pathname.startsWith("/remote/")) return false;
  // The router treats a trailing slash as the same path; this allowlist must too.
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return !(request.method === "POST" && PAIRING_PATHS.has(path));
};

/** The external listener's authorizer: refuse an unauthenticated `/api/*` request, let
 * everything else through. Called for plain requests and WebSocket upgrades alike. */
export const authorizeExternalRequest = async (request: Request): Promise<Response | undefined> => {
  Object.assign(request, { [EXTERNAL_LISTENER]: true });
  if (!requiresToken(request)) return undefined;
  const device = authenticatedDevice(request);
  if (device === undefined) return new Response("unauthorized", { status: 401 });
  await touchDevice(device.id);
  return undefined;
};

/** The cookie the external page carries: `HttpOnly` (the page never reads it), `Secure` and
 * `SameSite=Strict` (the external listener is only published over Tailscale HTTPS, same origin),
 * and `Path=/` for the whole app. */
export const deviceCookie = (token: string): string =>
  `${DEVICE_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}`;

/** How often one device's `lastSeenAt` is written, at most. Every touch rewrites config.json and
 * copies config.json.bak, so an active remote device must not age the recovery copy every
 * minute; ten minutes is fresh enough to see who is connected. */
const TOUCH_INTERVAL_MS = 10 * 60_000;

const lastTouchedAt = new Map<string, number>();

/** Drop entries for devices that are gone or revoked, so an id is never remembered longer than
 * the device behind it exists. Called before each touch, with the device list already in hand. */
const pruneTouched = (devices: readonly DeviceDto[]): void => {
  const live = new Set(devices.filter(isDeviceActive).map((device) => device.id));
  for (const id of lastTouchedAt.keys()) {
    if (!live.has(id)) lastTouchedAt.delete(id);
  }
};

/** Record that a device was seen, at most once per interval. Best effort: a failed write costs a
 * stale timestamp, never the request. */
const touchDevice = async (id: string): Promise<void> => {
  pruneTouched(runtimeConfig().devices);
  const at = Date.now();
  const last = lastTouchedAt.get(id);
  if (last !== undefined && at - last < TOUCH_INTERVAL_MS) return;
  lastTouchedAt.set(id, at);
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* mutateConfigFile((file) => {
        const devices = file.devices ?? [];
        const found = devices.find((device) => device.id === id);
        if (found === undefined || !isDeviceActive(found)) return { write: file, result: undefined };
        const next: DeviceDto = { ...found, lastSeenAt: new Date(at).toISOString() };
        return {
          write: { ...file, devices: devices.map((device) => (device.id === id ? next : device)) },
          result: undefined,
        };
      });
      yield* reloadConfig;
    }),
  ).catch(() => undefined);
};
