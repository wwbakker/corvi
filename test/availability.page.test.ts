import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { type Browser } from "playwright";

import {
  budget,
  checkoutsOf,
  closePages,
  openEngine,
  runSh,
  testTempDir,
  until,
  startTestServer,
  stopTestServer,
  reservePort,
  withPage,
} from "./helpers.ts";
import { startFakeRemote, type FakeRemote } from "./fakeRemote.ts";

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
const usable = await openEngine((opened) => {
  browser = opened;
});

const REMOTE = "OFFLINE-1";
const LOCAL = "LOCAL-1";

const fakeRemote = (port: number): Promise<FakeRemote> =>
  startFakeRemote(port, { changeId: REMOTE, title: "Remote change" });

let tmp: string;
let url: string;
let server: ReturnType<typeof Bun.spawn>;
let remotePort: number;
let remote: FakeRemote | undefined;

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
  ({ server, url } = await startTestServer(tmp));
  const repo = join(tmp, "repo");
  await runSh(["git", "init", "-b", "main", repo]);
  await fetch(`${url}/api/changes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: LOCAL,
      title: "Local change",
      state: "Implementation",
      checkouts: checkoutsOf([repo]),
    }),
  });
}, budget(120_000));

afterAll(async () => {
  if (!usable) return;
  await closePages(browser, "availability");
  await browser?.close();
  remote?.close();
  await stopTestServer(server, tmp);
  await rm(tmp, { recursive: true, force: true });
}, budget(60_000));

test.skipIf(!usable)(
  "an offline remote is named unavailable, gated, and recovers on Retry now",
  async () => {
    return withPage(
      browser,
      async (page) => {
        const remoteRequests: string[] = [];
        page.on("request", (request) => {
          if (new URL(request.url()).pathname.startsWith("/remote/")) remoteRequests.push(request.url());
        });
        await page.goto(url, { waitUntil: "domcontentloaded" });
        const unavailableItem = page.getByText("Remote offline (Unavailable)", { exact: true });
        await page.locator("button.workspace").click();
        await unavailableItem.waitFor({ timeout: budget(20_000) });
        await unavailableItem.click();
        expect(await page.locator("button.workspace").innerText()).toContain("(Unavailable)");
        const banner = page.locator(".remote-unavailable");
        await banner.waitFor({ timeout: budget(20_000) });
        expect(await banner.innerText()).toContain("unavailable");
        const retry = banner.getByRole("button", { name: "Retry now" });
        expect(await retry.count()).toBe(1);
        expect(await banner.getByRole("button", { name: "Local settings" }).count()).toBe(1);
        expect(remoteRequests).toEqual([]);
        await retry.click();
        await page.waitForTimeout(500);
        await banner.waitFor();
        await page.goto(`${url}/changes/${LOCAL}/terminals`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(".terminal-screen[data-attached]", { timeout: budget(30_000) });
        remote = await fakeRemote(remotePort);
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await until(
          async () => (await page.locator("button.workspace").innerText()).includes("(Unavailable)"),
          false,
          budget(40_000),
        );
        await page.getByRole("button", { name: "Remote change" }).waitFor({ timeout: budget(30_000) });
        expect(remoteRequests.some((request) => request.includes("/api/changes"))).toBe(true);
      },
      { width: 1400, height: 900 },
    );
  },
  budget(180_000),
);
