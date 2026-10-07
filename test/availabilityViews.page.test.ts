import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { chromium, webkit, type Browser } from "playwright";

import {
  budget,
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
 * A remote change opened by direct link while its server is down, then recovered in place:
 * the banner is by the viewed source, remote data is absent/read-only, and Retry now restores the
 * detail and plan without a reload.
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

const REMOTE = "REMOTE-1";
const CHANGE = {
  id: REMOTE,
  branch: "remote-1",
  workspace: "client",
  title: "Remote change",
  state: "Implementation",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const reservePort = async (): Promise<number> => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
};

/** The remote's server, only once it "comes up". */
const startRemote = (port: number): Server => {
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    const json = (value: unknown): void => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.startsWith("/api/events")) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(": open\n\n");
      const beat = setInterval(() => res.write(": ping\n\n"), 250);
      res.on("close", () => clearInterval(beat));
      return;
    }
    if (url.startsWith("/api/changes/") && url.includes("/plan")) return json({ text: "# REMOTE PLAN\n", revision: "1" });
    if (url.startsWith("/api/changes/")) return json(CHANGE);
    if (url.startsWith("/api/changes")) return json([CHANGE]);
    if (url.startsWith("/api/terminals")) return json({});
    if (url.startsWith("/api/dashboard/")) return json([]);
    if (url.startsWith("/api/pages")) return json({ pages: [] });
    if (url.startsWith("/api/workspaces")) return json({ workspaces: [] });
    json({});
  });
  server.listen(port, "127.0.0.1");
  return server;
};

let tmp: string;
let url: string;
let server: ReturnType<typeof Bun.spawn>;
let remotePort: number;
let remote: Server | undefined;

beforeAll(async () => {
  if (!usable) return;
  tmp = await testTempDir("availability-views");
  remotePort = await reservePort();
  writeFileSync(
    join(tmp, "config.json"),
    JSON.stringify({
      workspaces: [
        { id: "local", name: "Local" },
        {
          id: "remote-client",
          name: "Remote client",
          remote: { url: `http://127.0.0.1:${remotePort}`, workspace: "client", token: "remote-token" },
        },
      ],
    }),
  );
  server = Bun.spawn(["node", "apps/server/src/server.ts", `--corvi-test-run=${testRun()}`], {
    env: serverEnv(tmp),
    stdout: "pipe",
    stderr: process.env.CORVI_TEST_LOUD ? "inherit" : "ignore",
  });
  url = await waitForUrl(server);
}, budget(120_000));

afterAll(async () => {
  if (!usable) return;
  await closePages(browser, "availability-views");
  await browser?.close();
  remote?.close();
  server?.kill();
  await stopRunHost(tmp);
  await rm(tmp, { recursive: true, force: true });
}, budget(60_000));

test.skipIf(!usable)("a change opened while its remote is down banners, is read-only, and recovers in place", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${url}/changes/${REMOTE}/plan?source=remote-client`, { waitUntil: "domcontentloaded" });

    // The banner is by the viewed source, not the chosen workspace.
    const banner = page.locator(".remote-unavailable");
    await banner.waitFor({ timeout: budget(30_000) });
    expect(await banner.innerText()).toContain("unavailable");
    // The remote's document is not loaded: no stale-or-blank editor shows it as current.
    expect(await page.getByText("REMOTE PLAN").count()).toBe(0);

    // The remote comes up; Retry now recovers without a reload.
    remote = startRemote(remotePort);
    await banner.getByRole("button", { name: "Retry now" }).click();
    await until(async () => (await page.locator(".remote-unavailable").count()), 0, budget(40_000));
    expect(await page.locator(".remote-unavailable").count()).toBe(0);
    await until(async () => (await page.getByText("Remote change").count()) > 0, true, budget(30_000));
    expect(await page.getByText("Remote change").count()).toBeGreaterThan(0);
    await until(async () => (await page.getByText("REMOTE PLAN").count()) > 0, true, budget(30_000));
    expect(await page.getByText("REMOTE PLAN").count()).toBeGreaterThan(0);
  } finally {
    await page.close();
  }
}, budget(180_000));
