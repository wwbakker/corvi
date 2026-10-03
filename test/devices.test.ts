import { expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { Effect, TestClock } from "effect";

import type { DeviceDto, PairingCodeResponseDto, RedeemPairingCodeResponseDto } from "@corvi/contracts/devices";
import { deviceTokenMatches, hashDeviceToken } from "@corvi/configuration/node/devices";
import { createPairingCode, listDevices, redeemPairingCode, revokeDevice } from "../apps/server/src/devices/server/index.ts";
import { devicesRoutes } from "../apps/server/src/devices/routes.ts";
import { settingsViewSync, writeSettings } from "../apps/server/src/settings/server/index.ts";
import { MASK } from "../apps/server/src/settings/server/secrets.ts";
import { configPath, readFileSync, reloadConfigSync, runtimeConfig } from "../apps/server/src/workspace/server/index.ts";
import { runEffect, runEffectWithTestClock } from "./helpers.ts";

/**
 * Device identity and pairing: a code is single-use and expires, redemption stores only a hash
 * and shows the token once, revocation ends trust, no read surface — the device list or the
 * settings view — ever carries the stored hash, and concurrent config mutations cannot lose a
 * redemption or resurrect a revoked device.
 */

type RouteTable = Record<string, { readonly [method: string]: (req: Request) => Promise<Response> }>;
const routes = devicesRoutes as unknown as RouteTable;

const request = (path: string, method: string, body?: unknown): Promise<Response> =>
  routes[path]![method]!(
    new Request(`http://127.0.0.1:4000${path}`, {
      method,
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

/** A parameter route is called directly, so Bun's own router is not there to fill `req.params`;
 * the test states the path parameter the way the router would. */
const revoke = (id: string): Promise<Response> => {
  const req = new Request(`http://127.0.0.1:4000/api/devices/${id}`, {
    method: "DELETE",
    headers: { "sec-fetch-site": "same-origin" },
  });
  Object.assign(req, { params: { id } });
  return routes["/api/devices/:id"]!.DELETE!(req);
};

const newCode = (): Promise<PairingCodeResponseDto> =>
  request("/api/devices/pairing-codes", "POST").then((r) => r.json()) as Promise<PairingCodeResponseDto>;

const redeem = (code: string, name?: string): Promise<RedeemPairingCodeResponseDto> =>
  request("/api/devices/pairing-codes/redeem", "POST", { code, name }).then(
    (r) => r.json(),
  ) as Promise<RedeemPairingCodeResponseDto>;

const pair = async (name?: string): Promise<RedeemPairingCodeResponseDto> =>
  redeem((await newCode()).code, name);

/** Put a config file in place and refill the snapshot, so a tolerance case starts from a known
 * file rather than whatever earlier cases left behind. */
const writeConfig = async (value: unknown): Promise<void> => {
  await Bun.write(configPath(), JSON.stringify(value));
  reloadConfigSync();
};

test("a pairing code is single-use", async () => {
  const created = await newCode();
  expect(created.code).toMatch(/^[0-9A-F]{16}$/);
  expect(new Date(created.expiresAt).getTime()).toBeGreaterThan(Date.now());

  const first = await request("/api/devices/pairing-codes/redeem", "POST", {
    code: created.code,
    name: "Laptop",
  });
  expect(first.status).toBe(201);
  const body = (await first.json()) as RedeemPairingCodeResponseDto;
  expect(body.device.name).toBe("Laptop");
  // 256 bits in base64url: at least 43 characters worth of token.
  expect(body.token.length).toBeGreaterThanOrEqual(43);
  expect(body.device).not.toHaveProperty("tokenHash");

  // The second attempt is refused, and it is the caller's mistake, not a missing route.
  const second = await request("/api/devices/pairing-codes/redeem", "POST", { code: created.code });
  expect(second.status).toBe(400);

  // A code that was never issued is refused too.
  const unknown = await request("/api/devices/pairing-codes/redeem", "POST", { code: "ZZZZZZZZZZZZZZZZ" });
  expect(unknown.status).toBe(400);
});

test("a pairing code is accepted regardless of case and surrounding space", async () => {
  const created = await newCode();
  const redeemed = await redeem(`  ${created.code.toLowerCase()}  `, "Typed by hand");
  expect(redeemed.device.name).toBe("Typed by hand");
});

test("a pairing code expires after its TTL", async () => {
  const outcome = await runEffectWithTestClock(
    Effect.gen(function* () {
      const created = yield* createPairingCode();
      yield* TestClock.adjust("6 minutes");
      return yield* Effect.either(redeemPairingCode({ code: created.code }));
    }),
  );
  expect(outcome._tag).toBe("Left");
  if (outcome._tag === "Left") expect(outcome.left.message).toContain("expired");
});

test("a device can be revoked, and revoking an unknown one is not found", async () => {
  const { device } = await pair("Phone");
  const revoked = await revoke(device.id);
  expect(revoked.status).toBe(200);
  const body = (await revoked.json()) as { device: { revokedAt?: string } };
  expect(body.device.revokedAt).toBeDefined();

  const missing = await runEffect(Effect.either(revokeDevice("no-such-device")));
  expect(missing._tag).toBe("Left");
});

test("the raw token is stored as a hash and never returned by a read", async () => {
  const { device, token } = await pair();
  const text = await readFile(configPath(), "utf8");
  expect(text).not.toContain(token);
  const stored = (JSON.parse(text) as { devices: DeviceDto[] }).devices.find((d) => d.id === device.id);
  expect(stored?.tokenHash).toBe(hashDeviceToken(token));
  // The file may hold tokens, so the device write is owner-only like the settings write; the
  // replaced version is kept owner-only too.
  expect((await stat(configPath())).mode & 0o777).toBe(0o600);
  expect((await stat(`${configPath()}.bak`)).mode & 0o777).toBe(0o600);

  // The comparison is the one enforcement will use: right token matches, wrong or malformed one
  // does not.
  expect(deviceTokenMatches(token, stored!.tokenHash)).toBe(true);
  expect(deviceTokenMatches(`${token}x`, stored!.tokenHash)).toBe(false);
  expect(deviceTokenMatches(token, "not-a-hash")).toBe(false);

  const listed = (await request("/api/devices", "GET").then((r) => r.json())) as {
    devices: { id: string; tokenHash?: string }[];
  };
  const seen = listed.devices.find((d) => d.id === device.id);
  expect(seen).toBeDefined();
  expect(seen).not.toHaveProperty("tokenHash");
  expect(JSON.stringify(listed)).not.toContain(token);
});

test("the settings view masks device hashes and a save keeps the stored one", async () => {
  const { device, token } = await pair("Desktop");
  const storedHash = hashDeviceToken(token);

  const view = settingsViewSync();
  expect(view.file.devices?.find((d) => d.id === device.id)?.tokenHash).toBe(MASK);
  expect(view.effective.devices?.find((d) => d.id === device.id)?.tokenHash).toBe(MASK);
  // Neither the hash nor the raw token appears anywhere in the read.
  expect(JSON.stringify(view)).not.toContain(storedHash);
  expect(JSON.stringify(view)).not.toContain(token);
  // The redaction copies: the config a request is reading still holds the real hash.
  expect(runtimeConfig().devices.find((d) => d.id === device.id)?.tokenHash).toBe(storedHash);

  // A settings-page save hands the masked list back; the stored device wins, so the mask never
  // becomes the stored hash.
  await runEffect(writeSettings(view.file));
  expect(readFileSync().devices?.find((d) => d.id === device.id)?.tokenHash).toBe(storedHash);
  const written = await readFile(configPath(), "utf8");
  expect(written).not.toContain(MASK);
  expect(written).toContain(storedHash);
});

test("pairing preserves the rest of the config file", async () => {
  await writeConfig({
    changesRoot: "/tmp/corvi-preserve-changes",
    extensionSettings: { jira: { project: "PROJ" } },
    workspaces: [{ id: "client", name: "Client" }],
  });
  const { device } = await pair("Preserve");
  const written = JSON.parse(await readFile(configPath(), "utf8")) as {
    changesRoot?: string;
    extensionSettings?: unknown;
    workspaces?: unknown[];
    devices?: DeviceDto[];
  };
  expect(written.changesRoot).toBe("/tmp/corvi-preserve-changes");
  expect(written.extensionSettings).toEqual({ jira: { project: "PROJ" } });
  expect(written.workspaces).toEqual([{ id: "client", name: "Client" }]);
  expect(written.devices?.some((d) => d.id === device.id)).toBe(true);
});

test("two concurrent redemptions of distinct codes both land", async () => {
  const [first, second] = await Promise.all([newCode(), newCode()]);
  const [a, b] = await Promise.all([
    runEffect(redeemPairingCode({ code: first.code, name: "Concurrent A" })),
    runEffect(redeemPairingCode({ code: second.code, name: "Concurrent B" })),
  ]);
  const listed = await runEffect(listDevices());
  expect(listed.some((d) => d.id === a.device.id)).toBe(true);
  expect(listed.some((d) => d.id === b.device.id)).toBe(true);
});

test("a settings save cannot resurrect a concurrently revoked device", async () => {
  const { device } = await pair("Interleaved");
  await Promise.all([
    runEffect(writeSettings({ notificationSound: false })),
    runEffect(revokeDevice(device.id)),
  ]);
  const listed = await runEffect(listDevices());
  expect(listed.find((d) => d.id === device.id)?.revokedAt).toBeDefined();
});

test("one malformed device does not cost the rest of the config", async () => {
  const good: DeviceDto = {
    id: "good-device",
    name: "Good",
    tokenHash: hashDeviceToken("good-token"),
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  await writeConfig({
    changesRoot: "/tmp/corvi-tolerant-changes",
    extensionSettings: { jira: { project: "TOLERANT" } },
    workspaces: [{ id: "client", name: "Client" }],
    devices: [good, { id: "bad-device", name: 7 }, "not a device"],
  });

  // The valid device and the rest of the file survive the malformed entry.
  expect(runtimeConfig().devices).toEqual([good]);
  expect(runtimeConfig().workspaces).toEqual([{ id: "client", name: "Client" }]);
  expect(runtimeConfig().extensionSettings).toEqual({ jira: { project: "TOLERANT" } });
  // The file still holds the workspace and the extension bag, not just the resolved snapshot.
  const written = readFileSync();
  expect(written.workspaces).toEqual([{ id: "client", name: "Client" }]);
  expect(written.extensionSettings).toEqual({ jira: { project: "TOLERANT" } });

  // The page's file view is filtered too: no bogus device is spread into the page's copy, and
  // its type is honest.
  expect(settingsViewSync().file.devices?.map((d) => d.id)).toEqual(["good-device"]);
});
