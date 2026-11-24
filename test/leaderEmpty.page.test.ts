import { test, expect, beforeAll, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { type Browser, type Page } from "playwright";
import {
  closePages,
  openBrowser,
  startTestServer,
  stopTestServer,
  testTempDir,
  VIEWPORT,
  withPage,
} from "./helpers.ts";

/**
 * The column's groups when they are empty, through the page: a key that picks from a list is only
 * shown when the list has something to pick (apps/web/src/app-root/leader.tsx). Its slot stays, so
 * the keys below it do not move — but neither the cap nor the box is drawn, because a cap over
 * nothing is the same lie as a cap on a disabled control.
 *
 * An instance with no changes at all is the only way to see it: the leader suite's instance has
 * ideas and started changes from the moment it is up, and emptying it would break the rest of it.
 */
let browser: Browser;
const usable = await openBrowser((opened) => {
  browser = opened;
});

let tmp: string;
let url: string;
let server: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  if (!usable) return;
  tmp = await testTempDir("leader-empty");
  ({ server, url } = await startTestServer(tmp));
});

afterAll(async () => {
  if (!usable) return;
  await closePages(browser, "leader-empty");
  await browser?.close();
  await stopTestServer(server, tmp);
  await rm(tmp, { recursive: true, force: true });
});

test("a list with nothing in it wears no key and no box", async () => {
  if (!usable) return;
  await withPage(
    browser,
    async (page: Page) => {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".sidebar .list");
      await page.keyboard.press("Control+Space");
      await page.waitForSelector(".leader-layer");
      // The column's other keys arrive with the same render; wait for one of them.
      await page.waitForFunction(() =>
        [...document.querySelectorAll(".leader-key")].some((badge) => badge.textContent === "Y"),
      );

      const drawn = await page.evaluate(() => ({
        keys: [...document.querySelectorAll(".leader-key")].map((badge) => badge.textContent),
        outlines: document.querySelectorAll(".leader-outline").length,
      }));
      // E and R pick from the two lists, and there is nothing in either: no cap, and no box.
      expect(drawn.keys).not.toContain("E");
      expect(drawn.keys).not.toContain("R");
      expect(drawn.outlines).toBe(0);
      // The slots are still slots: the keys after the empty groups are where they always are.
      expect(drawn.keys).toContain("T");

      // Pressing the empty group's key does nothing at all — the mode stays, and nothing opens.
      await page.keyboard.press("e");
      expect(await page.locator(".leader-layer").count()).toBe(1);
      expect(new URL(page.url()).pathname).toBe("/");
    },
    VIEWPORT,
  );
}, 30_000);
