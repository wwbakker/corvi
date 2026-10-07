import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit, type Browser } from "playwright";

import { serve, type Serving } from "../apps/server/src/capabilities/serve.ts";
import { guard, json } from "../apps/server/src/capabilities/web.ts";
import {
  closePages,
  requireFreshWebBundle,
  serverEnv,
  stopRunHost,
  testRun,
  testTempDir,
  until,
  waitForUrl,
} from "./helpers.ts";

/**
 * The power control in the page: the sidebar's power icon opens a dialog that names the machines,
 * shows the agents each reports, arms this machine, cancels, and refetches when a `power` event
 * arrives — local or a remote's `source` envelope.
 *
 * The server is the ordinary one, started with a countdown of an hour so nothing can power
 * anything off during the run. A fake remote serves the remote machine's state and its event
 * stream, so the remote path goes through the real gateway and fan-in.
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
let server: ReturnType<typeof Bun.spawn>;
let remote: Serving;
let remotePowerReads = 0;
let remoteFailing = false;
let pushRemote: ((frame: string) => void) | undefined;

beforeEach(() => {
  remoteFailing = false;
});

beforeAll(async () => {
  if (!usable) return;
  tmp = await testTempDir("power-pages");
  remote = await serve<unknown>({
    port: 0,
    routes: guard({
      "/api/power": {
        GET: () => {
          remotePowerReads += 1;
          return remoteFailing
            ? json({ error: "the remote is offline" }, 500)
            : json({ phase: "disarmed", agents: [] });
        },
      },
      "/api/events": {
        GET: () =>
          new Response(
            new ReadableStream({
              start(controller) {
                const encoder = new TextEncoder();
                pushRemote = (frame) => controller.enqueue(encoder.encode(frame));
              },
              cancel() {
                pushRemote = undefined;
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      },
    }),
  });
  writeFileSync(
    join(tmp, "config.json"),
    JSON.stringify({
      workspaces: [
        { id: "local", name: "Local" },
        {
          id: "remote",
          name: "Remote",
          remote: { url: remote.url.origin, workspace: "remote", token: "remote-token" },
        },
      ],
    }),
  );
  server = Bun.spawn(["node", "apps/server/src/server.ts", `--corvi-test-run=${testRun()}`], {
    env: serverEnv(tmp, { CORVI_POWER_COUNTDOWN_MS: "3600000" }),
    stdout: "pipe",
    stderr: process.env.CORVI_TEST_LOUD ? "inherit" : "ignore",
  });
  url = await waitForUrl(server);
});

afterAll(async () => {
  if (!usable) return;
  await closePages(browser, "power");
  await browser?.close();
  server?.kill();
  remote?.stop();
  await stopRunHost(tmp);
  await rm(tmp, { recursive: true, force: true });
});

test.skipIf(!usable)("the dialog names this machine, arms it, and cancels", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(url, { waitUntil: "domcontentloaded" });

  await page.locator(".sidebar .icon-entry[aria-label='Power']").click();
  const dialog = page.locator("dialog.power-dialog");
  await dialog.waitFor();
  expect(await dialog.locator("h3").textContent()).toBe("Power down when done");

  // This machine is listed and ticked; the remote is listed but not ticked.
  const machine = dialog.locator(".power-machine", { hasText: "This machine" });
  await machine.waitFor();
  expect(await machine.locator("input").isChecked()).toBe(true);
  const remoteRow = dialog.locator(".power-machine", { hasText: "Remote" });
  await remoteRow.waitFor();
  expect(await remoteRow.locator("input").isChecked()).toBe(false);

  // Arm: the per-target result names this machine armed.
  await dialog.getByRole("button", { name: "Arm shutdown" }).click();
  await dialog.locator(".power-results", { hasText: "This machine" }).waitFor();
  expect(await dialog.locator(".power-results").textContent()).toContain("Armed");

  // Cancel: the result becomes disarmed.
  await dialog.getByRole("button", { name: "Disarm" }).click();
  await dialog.locator(".power-results", { hasText: "Disarmed" }).waitFor();

  await dialog.getByRole("button", { name: "Close" }).click();
  await dialog.waitFor({ state: "detached" });
});

test.skipIf(!usable)(
  "a machine whose read fails drops out of the selection and the rest still arm",
  async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.locator(".sidebar .icon-entry[aria-label='Power']").click();
    const dialog = page.locator("dialog.power-dialog");
    await dialog.waitFor();
    const remoteRow = dialog.locator(".power-machine", { hasText: "Remote" });
    await remoteRow.waitFor();

    // Tick the remote while its read works, then take it offline.
    await remoteRow.locator("input").check();
    expect(await remoteRow.locator("input").isChecked()).toBe(true);
    remoteFailing = true;

    // A remote power event refetches; the failed read drops it from the selection and disables
    // its row, so it cannot block this machine.
    expect(await until(async () => pushRemote !== undefined, true)).toBe(true);
    pushRemote!("event: power\ndata: \n\n");
    await dialog.locator(".power-machine .hint.error").first().waitFor();
    expect(await remoteRow.locator("input").isChecked()).toBe(false);
    expect(await remoteRow.locator("input").isDisabled()).toBe(true);

    // This machine alone still arms.
    await dialog.getByRole("button", { name: "Arm shutdown" }).click();
    await dialog.locator(".power-results", { hasText: "This machine" }).waitFor();
    expect(await dialog.locator(".power-results").textContent()).toContain("Armed");

    await page.close();
  },
);

test.skipIf(!usable)(
  "a local power event and a remote source power event each refetch",
  async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    let localReads = 0;
    await page.route(
      (u) => u.pathname === "/api/power",
      async (route) => {
        localReads += 1;
        await route.continue();
      },
    );
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.locator(".sidebar .icon-entry[aria-label='Power']").click();
    const dialog = page.locator("dialog.power-dialog");
    await dialog.waitFor();
    await dialog.locator(".power-machine", { hasText: "Remote" }).waitFor();

    // A local `power` event (this server's state changed) refetches the machines.
    const beforeLocal = localReads;
    await fetch(`${url}/api/power/arm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targets: [""] }),
    });
    expect(await until(async () => localReads > beforeLocal, true)).toBe(true);

    const beforeDisarm = localReads;
    await fetch(`${url}/api/power/disarm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targets: [""] }),
    });
    expect(await until(async () => localReads > beforeDisarm, true)).toBe(true);

    // A remote `power` event arrives on the local stream as a `source` envelope, and the page
    // refetches the remote machine through the gateway.
    expect(await until(async () => pushRemote !== undefined, true)).toBe(true);
    const beforeRemote = remotePowerReads;
    pushRemote!("event: power\ndata: \n\n");
    expect(await until(async () => remotePowerReads > beforeRemote, true)).toBe(true);

    await page.close();
  },
);
