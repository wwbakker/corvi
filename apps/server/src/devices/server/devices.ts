/** Device identity and pairing for this server.
 *
 * A device is added by redeeming a pairing code: the code is short-lived and single-use, and the
 * raw 256-bit token it issues is shown once and never stored — the config holds a hash. This
 * module owns the pairing codes (in memory: they live for five minutes and a restart may forget
 * them) and the device records written through the config file's serialized mutation path.
 *
 * Nothing here enforces a request yet; the external listener that presents a token is wired in
 * later. `@corvi/configuration/node/devices` owns the hashing and constant-time comparison that
 * enforcement will use.
 */
import { Clock, Effect } from "effect";

import type {
  DeviceDto,
  DeviceViewDto,
  PairingCodeResponseDto,
  RedeemPairingCodeRequestDto,
  RedeemPairingCodeResponseDto,
} from "@corvi/contracts/devices";
import { BadRequestError, NotFoundError, TooManyRequestsError } from "@corvi/contracts/errors";
import { PAIRING_CODE_TTL_MS, deviceViewOf, isDeviceActive } from "@corvi/configuration/devices";
import {
  generateDeviceId,
  generateDeviceToken,
  generatePairingCode,
  hashDeviceToken,
} from "@corvi/configuration/node/devices";
import { mutateConfigFile, reloadConfig, runtimeConfig, updateConfigFile } from "../../workspace/server/index.ts";
import { runtimeRedeemLimiter } from "../../capabilities/runtime.ts";

/** Outstanding pairing codes, by code, with the epoch-millisecond instant each stops working.
 * In memory on purpose: a code is good for minutes and a restart forgetting it is the safe
 * direction. */
const pairingCodes = new Map<string, number>();

/** Drop codes that can no longer be redeemed, so the map does not grow with spent codes. */
const pruneExpired = (now: number): void => {
  for (const [code, expiresAt] of pairingCodes) {
    if (expiresAt <= now) pairingCodes.delete(code);
  }
};

const deviceName = (name: string | undefined): string => name?.trim() || "Unnamed device";

/** The devices paired to this server, as a read route may return them. */
export const listDevices = (): Effect.Effect<DeviceViewDto[]> =>
  Effect.sync(() => (runtimeConfig().devices ?? []).map(deviceViewOf));

/** Create a short-lived, single-use pairing code. */
export const createPairingCode = (): Effect.Effect<PairingCodeResponseDto> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    pruneExpired(now);
    const code = generatePairingCode();
    const expiresAt = now + PAIRING_CODE_TTL_MS;
    pairingCodes.set(code, expiresAt);
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  });

/** Count one redemption attempt and refuse past the global cap. The route calls this before it
 * reads the body, so a malformed or oversized unauthenticated body is counted too; per-code
 * failures are checked later, once the code is known. */
export const checkRedeemLimit = (): Effect.Effect<void, TooManyRequestsError> =>
  Effect.gen(function* () {
    const decision = runtimeRedeemLimiter().allowAttempt();
    if (!decision.allowed) {
      return yield* new TooManyRequestsError({
        message: "too many pairing attempts; try again later",
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }
  });

/** Redeem a pairing code: consume it, issue a token, and store only the token's hash. The raw
 * token is in the response and nowhere else.
 *
 * Rate-limited because the external listener makes this the one route reachable without a token;
 * the limiter lives in the process runtime so a test installs its own. */
export const redeemPairingCode = (
  request: RedeemPairingCodeRequestDto,
): Effect.Effect<RedeemPairingCodeResponseDto, BadRequestError | TooManyRequestsError> =>
  Effect.gen(function* () {
    // Normalize before the lookup: codes are minted uppercase, and a user retyping one should not
    // have to match its case.
    const code = request.code.trim().toUpperCase();
    const limiter = runtimeRedeemLimiter();
    // The per-code failure cap is checked before the first yield. The global attempt cap was
    // already counted by `checkRedeemLimit`, before the route read the body.
    const decision = limiter.allowCode(code);
    if (!decision.allowed) {
      return yield* new TooManyRequestsError({
        message: "too many pairing attempts; try again later",
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }
    // Consume the code (look up and delete) before the first yield, so two redemptions of the
    // same code cannot both succeed no matter how the scheduler interleaves them.
    const expiresAt = pairingCodes.get(code);
    if (expiresAt === undefined) {
      limiter.failed(code);
      return yield* new BadRequestError({ message: "that pairing code is not valid" });
    }
    pairingCodes.delete(code);
    const now = yield* Clock.currentTimeMillis;
    if (expiresAt <= now) {
      limiter.failed(code);
      return yield* new BadRequestError({ message: "that pairing code has expired" });
    }
    const token = generateDeviceToken();
    const device: DeviceDto = {
      id: generateDeviceId(),
      name: deviceName(request.name),
      tokenHash: hashDeviceToken(token),
      createdAt: new Date(now).toISOString(),
    };
    // Append inside the serialized mutation, based on the file as it is right now: two concurrent
    // redemptions both land.
    yield* updateConfigFile((file) => ({
      ...file,
      devices: [...(file.devices ?? []), device],
    }));
    yield* reloadConfig;
    limiter.succeeded(code);
    return { device: deviceViewOf(device), token };
  });

/** Revoke a device: it keeps its identity and history but may no longer authenticate. Revoking
 * an already-revoked device is a no-op that answers with the record as it stands. */
export const revokeDevice = (id: string): Effect.Effect<DeviceViewDto, NotFoundError> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const revoked = yield* mutateConfigFile((file) => {
      const devices = file.devices ?? [];
      const found = devices.find((device) => device.id === id);
      if (found === undefined) return { write: file, result: undefined };
      if (!isDeviceActive(found)) return { write: file, result: deviceViewOf(found) };
      const next: DeviceDto = { ...found, revokedAt: new Date(now).toISOString() };
      return {
        write: { ...file, devices: devices.map((device) => (device.id === id ? next : device)) },
        result: deviceViewOf(next),
      };
    });
    if (revoked === undefined) {
      return yield* new NotFoundError({ message: `no such device: ${id}` });
    }
    // Revocation ends the trust already handed out: an outstanding pairing code must not create a
    // fresh device after it.
    pairingCodes.clear();
    yield* reloadConfig;
    return revoked;
  });
