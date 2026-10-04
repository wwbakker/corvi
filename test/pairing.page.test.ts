import { test, expect, beforeAll, afterAll } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit, type Browser, type Page } from "playwright";
import { instanceRecords } from "../apps/cli/src/discovery.ts";
import { DEVICE_COOKIE } from "../apps/server/src/devices/server/index.ts";
import { closePages, requireFreshWebBundle, serverEnv, testRun, testTempDir, waitForUrl, stopRunHost } from "./helpers.ts";

/**
 * Pairing and device management through the page.
 *
 * The server runs with remote access on, so there are two origins: the local, tokenless one that
 * renders the app as always, and the external one that refuses an unauthenticated browser. The
 * pairing screen and the host's Devices section are driven here; the API shapes and rate limit
 * are pinned in test/externalListener.test.ts.
 */
let browser: Browser;
const engineName = process.env.CORVI_ENGINE === "webkit" ? "webkit" : "chromium";
const usable = await (async (): Promise<boolean> => {
  try {
    const engine = engineName === "webkit" ? webkit : chromium;
    if (!(await Bun.file(engine.executablePath()).exists())) return false;
    browser = await engine.launch();
    return true;
  } catch {
    return false;
  }
})();

if (usable) requireFreshWebBundle();

let tmp: string;
let url: string;
let remoteUrl: string;
let server: ReturnType<typeof Bun.spawn>;

/** A page in a fresh context, with no device cookie: the remote origin treats it as unpaired. */
const unpairedPage = async (): Promise<Page> => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  return context.newPage();
};

const freePort = async (): Promise<number> => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
};

/** The external URL the server recorded, once it has bound the listener. */
const waitForRemoteUrl = async (): Promise<string> => {
  const dir = join(tmp, "state", "corvi");
  for (let i = 0; i < 200; i++) {
    const record = (await instanceRecords(dir)).find((candidate) => candidate.remoteUrl);
    if (record?.remoteUrl) return record.remoteUrl.replace(/\/$/, "");
    await Bun.sleep(50);
  }
  throw new Error("the server never recorded a remote URL");
};

beforeAll(async () => {
  if (!usable) return;
  tmp = await testTempDir("pairing-page");
  const port = await freePort();
  await writeFile(join(tmp, "config.json"), JSON.stringify({ remoteAccess: { enabled: true, port } }));
  server = Bun.spawn(["node", "apps/server/src/server.ts", `--corvi-test-run=${testRun()}`], {
    env: serverEnv(tmp),
    stdout: "pipe",
    stderr: process.env.CORVI_TEST_LOUD ? "inherit" : "ignore",
  });
  url = await waitForUrl(server);
  remoteUrl = await waitForRemoteUrl();
});

afterAll(async () => {
  if (!usable) return;
  await closePages(browser, "pairing");
  await browser?.close();
  server?.kill();
  await stopRunHost(tmp);
  await rm(tmp, { recursive: true, force: true });
});

test.skipIf(!usable)(
  "a remote page without a device shows the pairing screen, refuses a bad code, and pairs",
  async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(remoteUrl, { waitUntil: "domcontentloaded" });

    // The unauthenticated session check is a 401, so the pairing screen is what renders.
    await page.getByRole("heading", { name: "Pair this device" }).waitFor();

    // A code nobody minted is refused with the server's own words.
    await page.getByLabel("Pairing code").fill("0000000000000000");
    await page.getByRole("button", { name: "Pair" }).click();
    await page.locator(".error-banner").waitFor();
    expect(await page.locator(".error-banner").textContent()).toContain("not valid");

    // The host mines a code on the local listener and the remote page redeems it. The response
    // is captured inside the route because the page reloads as soon as it resolves, which would
    // otherwise take the body with it.
    const created = (await (
      await fetch(`${url}/api/devices/pairing-codes`, { method: "POST" })
    ).json()) as { code: string };
    let paired:
      | { status: number; body: { device: { name: string }; token?: string }; setCookie: string }
      | undefined;
    await page.route("**/api/devices/pair", async (route) => {
      const response = await route.fetch();
      const text = await response.text();
      paired = {
        status: response.status(),
        body: JSON.parse(text) as { device: { name: string }; token?: string },
        setCookie: response.headers()["set-cookie"] ?? "",
      };
      await route.fulfill({ status: response.status(), headers: response.headers(), body: text });
    });
    await page.getByLabel("Pairing code").fill(created.code);
    await page.getByLabel("This device's name").fill("Remote browser");
    await page.getByRole("button", { name: "Pair" }).click();
    for (let i = 0; i < 100 && paired === undefined; i++) await Bun.sleep(50);
    expect(paired?.status).toBe(201);
    // The body page JS sees carries no token.
    expect(paired?.body.device.name).toBe("Remote browser");
    expect(paired?.body).not.toHaveProperty("token");

    // The HttpOnly cookie the pair set is what authenticates the page. A `Secure` cookie is not
    // stored on this plain-HTTP loopback origin, so the test carries it explicitly, as the
    // browser would over the tailnet's HTTPS.
    const value = paired!.setCookie.split(";")[0]!.split("=").slice(1).join("=");
    await page.context().addCookies([
      { name: DEVICE_COOKIE, value, url: remoteUrl, httpOnly: true, secure: true, sameSite: "Strict" },
    ]);
    await page.goto(remoteUrl, { waitUntil: "domcontentloaded" });
    await page.locator(".sidebar").waitFor();
    expect(await page.getByRole("heading", { name: "Pair this device" }).count()).toBe(0);
    await page.close();
  },
  60_000,
);

test.skipIf(!usable)(
  "the pairing screen shows the expired and rate-limit refusals",
  async () => {
    const page = await unpairedPage();
    await page.route("**/api/devices/pair", (route) =>
      route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "that pairing code has expired" }),
      }),
    );
    await page.goto(remoteUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Pair this device" }).waitFor();
    await page.getByLabel("Pairing code").fill("0000000000000000");
    await page.getByRole("button", { name: "Pair" }).click();
    await page.locator(".error-banner", { hasText: "expired" }).waitFor();

    // The 429 path reads the limiter's message, not a bare status.
    await page.unroute("**/api/devices/pair");
    await page.route("**/api/devices/pair", (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ error: "too many pairing attempts; try again later" }),
      }),
    );
    await page.getByRole("button", { name: "Pair" }).click();
    await page.locator(".error-banner", { hasText: "too many" }).waitFor();
    await page.context().close();
  },
  60_000,
);

test.skipIf(!usable)("a non-401 session failure leaves the app rendering", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route("**/api/devices/session", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "boom" }),
    }),
  );
  await page.goto(url, { waitUntil: "domcontentloaded" });
  // A 5xx is the pages' own to show; the app is not replaced by the pairing or error screen.
  await page.locator(".sidebar").waitFor();
  expect(await page.getByRole("heading", { name: "Pair this device" }).count()).toBe(0);
  expect(await page.getByRole("button", { name: "Retry" }).count()).toBe(0);
  await page.context().close();
});

test.skipIf(!usable)("the local origin renders the app, never the pairing screen", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator(".sidebar").waitFor();
  expect(await page.getByRole("heading", { name: "Pair this device" }).count()).toBe(0);
  await page.close();
});

test.skipIf(!usable)("the Devices section mines a code, lists a paired device, and revokes it", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${url}/settings`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("nav.tabs");
  await page.getByRole("button", { name: "Devices" }).click();

  // No code yet, and no devices beyond whatever earlier tests paired.
  await page.getByRole("button", { name: "Create a pairing code" }).click();
  const code = (await page.locator(".pairing-code").textContent())?.trim() ?? "";
  expect(code).toMatch(/^[0-9A-F]{16}$/);

  // Pair a device with it through the external browser endpoint.
  const paired = await fetch(`${remoteUrl}/api/devices/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name: "Listed device" }),
  });
  expect(paired.status).toBe(201);

  // Leaving and returning remounts the section, which refetches the list.
  await page.getByRole("button", { name: "Locations" }).click();
  await page.getByRole("button", { name: "Devices" }).click();
  const row = page.locator("tr", { hasText: "Listed device" });
  await row.waitFor();
  await row.getByRole("button", { name: "Revoke" }).click();
  await row.getByText("revoked").waitFor();
  // The revoke button is gone once revoked.
  expect(await row.getByRole("button", { name: "Revoke" }).count()).toBe(0);
  await page.close();
}, 60_000);

test.skipIf(!usable)(
  "revoking a device clears the pairing code on display",
  async () => {
    // A device paired before the section opens, so the list already holds something to revoke.
    const seed = (await (
      await fetch(`${url}/api/devices/pairing-codes`, { method: "POST" })
    ).json()) as { code: string };
    const paired = await fetch(`${remoteUrl}/api/devices/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: seed.code, name: "Seed device" }),
    });
    expect(paired.status).toBe(201);

    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${url}/settings`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("nav.tabs");
    await page.getByRole("button", { name: "Devices" }).click();
    const row = page.locator("tr", { hasText: "Seed device" });
    await row.waitFor();

    // A code is on display when the device is revoked: revoking invalidates it, so it must not
    // keep counting down to a refusal on the remote machine.
    await page.getByRole("button", { name: "Create a pairing code" }).click();
    await page.locator(".pairing-code").waitFor();
    await row.getByRole("button", { name: "Revoke" }).click();
    await row.getByText("revoked").waitFor();
    expect(await page.locator(".pairing-code").count()).toBe(0);
    await page.getByText("Revoking a device invalidates outstanding pairing codes").waitFor();
    await page.close();
  },
  60_000,
);
