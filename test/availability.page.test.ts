import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { chromium, webkit, type Browser } from "playwright";

import {
  budget,
  checkoutsOf,
  closePages,
  requireFreshWebBundle,
  runSh,
  serverEnv,
  stopRunHost,
  testRun,
  testTempDir,
  until,
  waitForUrl,
} from "./helpers.ts";

/**
 * The page with a configured remote that is down, beside a local shell:
 *
 * - the selector names it `(Unavailable)` and stays selectable;
 * - the banner gives the reason, **Retry now**, and local settings;
 * - the local terminal works untouched;
 * - nothing is sent to the down remote (the gate refuses before the network);
 * - when it comes up and Retry now is pressed, it recovers without a reload.
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

const REMOTE = "OFFLINE-1";
const LOCAL = "LOCAL-1";

/** A port nothing listens on until the fake remote is started on it. */
const reservePort = async (): Promise<number> => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
};

const fakeRemote = (port: number): { readonly server: Server; readonly requests: string[]; readonly stop: () => void } => {
  const requests: string[] = [];
  const server = createServer((req, res: ServerResponse) => {
    requests.push(`${req.method ?? "GET"} ${req.url ?? ""}`);
    if (req.url?.startsWith("/api/events")) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(": open\n\n");
      const beat = setInterval(() => res.write(": ping\n\n"), 250);
      res.on("close", () => clearInterval(beat));
      return;
    }
    if (req.url?.startsWith("/api/changes")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify([
          {
            id: REMOTE,
            branch: REMOTE,
            workspace: "client",
            title: "Remote change",
            state: "Implementation",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ]),
      );
      return;
    }
    if (req.url?.startsWith("/api/terminals")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  return { server, requests, stop: () => server.close() };
};

let tmp: string;
let url: string;
let server: ReturnType<typeof Bun.spawn>;
let remotePort: number;
let remote: ReturnType<typeof fakeRemote> | undefined;

beforeAll(async () => {
  if (!usable) return;
  tmp = await testTempDir("availability-page");
  remotePort = await reservePort();
  writeFileSync(
    join(tmp, "config.json"),
    JSON.stringify({
      workspaces: [
        { id: "local", name: "Local" },
        {
          id: "remote-offline",
          name: "Remote offline",
          remote: { url: `http://127.0.0.1:${remotePort}`, workspace: "client", token: "offline-token" },
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
  const repo = join(tmp, "repo");
  await runSh(["git", "init", "-b", "main", repo]);
  await fetch(`${url}/api/changes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: LOCAL, title: "Local change", state: "Implementation", checkouts: checkoutsOf([repo]) }),
  });
}, budget(120_000));

afterAll(async () => {
  if (!usable) return;
  await closePages(browser, "availability");
  await browser?.close();
  remote?.stop();
  server?.kill();
  await stopRunHost(tmp);
  await rm(tmp, { recursive: true, force: true });
}, budget(60_000));

test.skipIf(!usable)("an offline remote is named unavailable, gated, and recovers on Retry now", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const remoteRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/remote/")) remoteRequests.push(request.url());
  });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });

    // The selector names the configured remote, marked unavailable once the health check fails.
    const unavailableItem = page.getByText("Remote offline (Unavailable)", { exact: true });
    await page.locator("button.workspace").click();
    await unavailableItem.waitFor({ timeout: budget(20_000) });
    // It is still selectable.
    await unavailableItem.click();
    expect(await page.locator("button.workspace").innerText()).toContain("(Unavailable)");

    // The banner explains and offers recovery plus local configuration.
    const banner = page.locator(".remote-unavailable");
    await banner.waitFor({ timeout: budget(20_000) });
    expect(await banner.innerText()).toContain("unavailable");
    const retry = banner.getByRole("button", { name: "Retry now" });
    expect(await retry.count()).toBe(1);
    expect(await banner.getByRole("button", { name: "Local settings" }).count()).toBe(1);

    // Nothing was sent to the down remote: the gate refused before the network.
    expect(remoteRequests).toEqual([]);
    // Retry now asks for a coordinated check; the remote is still down, so the banner stays.
    await retry.click();
    await page.waitForTimeout(500);
    await banner.waitFor();

    // The local shell is untouched.
    await page.goto(`${url}/changes/${LOCAL}/terminals`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".terminal-screen[data-attached]", { timeout: budget(30_000) });

    // The remote comes up: the bounded reconnect recovers it, and only then is it requested.
    remote = fakeRemote(remotePort);
    await new Promise<void>((resolve) => remote!.server.listen(remotePort, "127.0.0.1", () => resolve()));
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await until(
      async () => (await page.locator("button.workspace").innerText()).includes("(Unavailable)"),
      false,
      budget(40_000),
    );
    // The remote's change is now listed, read through the gateway.
    await page.getByRole("button", { name: "Remote change" }).waitFor({ timeout: budget(30_000) });
    expect(remoteRequests.some((request) => request.includes("/api/changes"))).toBe(true);
  } finally {
    await page.close();
  }
}, budget(180_000));
