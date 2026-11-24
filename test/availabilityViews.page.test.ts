import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { type Browser } from "playwright";

import {
  budget,
  closePages,
  openBrowser,
  testTempDir,
  until,
  startTestServer,
  stopTestServer,
  reservePort,
  withPage,
} from "./helpers.ts";
import { startFakeRemote, type FakeRemote } from "./fakeRemote.ts";

/**
 * A remote change opened by direct link while its server is down, then recovered in place:
 * the banner is by the viewed source, remote data is absent/read-only, and Retry now restores the
 * detail and plan without a reload.
 */
let browser: Browser;
const usable = await openBrowser((opened) => {
  browser = opened;
});

const REMOTE = "REMOTE-1";
/** The remote's server, only once it "comes up". */
const startRemote = (port: number): Promise<FakeRemote> =>
  startFakeRemote(port, { changeId: REMOTE, title: "Remote change", plan: "# REMOTE PLAN\n" });

let tmp: string;
let url: string;
let server: ReturnType<typeof Bun.spawn>;
let remotePort: number;
let remote: FakeRemote | undefined;

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
  ({ server, url } = await startTestServer(tmp));
}, budget(120_000));

afterAll(async () => {
  if (!usable) return;
  await closePages(browser, "availability-views");
  await browser?.close();
  remote?.close();
  await stopTestServer(server, tmp);
  await rm(tmp, { recursive: true, force: true });
}, budget(60_000));

test.skipIf(!usable)(
  "a change opened while its remote is down banners, is read-only, and recovers in place",
  async () => {
    return withPage(
      browser,
      async (page) => {
        await page.goto(`${url}/changes/${REMOTE}/plan?source=remote-client`, {
          waitUntil: "domcontentloaded",
        });
        const banner = page.locator(".remote-unavailable");
        await banner.waitFor({ timeout: budget(30_000) });
        expect(await banner.innerText()).toContain("unavailable");
        expect(await page.getByText("REMOTE PLAN").count()).toBe(0);
        remote = await startRemote(remotePort);
        await banner.getByRole("button", { name: "Retry now" }).click();
        await until(async () => await page.locator(".remote-unavailable").count(), 0, budget(40_000));
        expect(await page.locator(".remote-unavailable").count()).toBe(0);
        await until(async () => (await page.getByText("Remote change").count()) > 0, true, budget(30_000));
        expect(await page.getByText("Remote change").count()).toBeGreaterThan(0);
        await until(async () => (await page.getByText("REMOTE PLAN").count()) > 0, true, budget(30_000));
        expect(await page.getByText("REMOTE PLAN").count()).toBeGreaterThan(0);
      },
      { width: 1440, height: 900 },
    );
  },
  budget(180_000),
);
