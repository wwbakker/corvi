import { test, expect, beforeAll, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { type Browser, type Locator, type Page } from "playwright";

import type { HostStatusDto } from "@corvi/contracts/api";

import { closePages, openEngine, startTestServer, stopTestServer, testTempDir, withPage } from "./helpers.ts";

/**
 * The terminal host's restart surface: the icon that appears only while the host is not the one
 * this server would have started, and the dialog that asks before it ends anything.
 *
 * The two routes are stubbed at the page (Playwright routes) so the flow is driven without a real
 * foreign host; what the stub serves is the wire shape the server's schema declares
 * (`packages/contracts`), and the server under it is the ordinary one.
 */
let browser: Browser;
const usable = await openEngine((opened) => {
  browser = opened;
});

let tmp: string;
let url: string;
let server: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  if (!usable) return;
  tmp = await testTempDir("host-pages");
  ({ server, url } = await startTestServer(tmp));
});

afterAll(async () => {
  if (!usable) return;
  await closePages(browser, "host");
  await browser?.close();
  await stopTestServer(server, tmp);
  await rm(tmp, { recursive: true, force: true });
});

const foreignBuild = (): HostStatusDto => ({
  running: true,
  identity: { checkout: "/repos/corvi", buildId: "000011112222", protocol: 1 },
  stale: [{ kind: "build", theirs: "000011112222", ours: "9f8e7d6c5b4a" }],
  sessions: { live: 0, working: 0 },
});

/** The stub's state: what `GET` serves, and how many restarts the button sent. */
const ours = (): HostStatusDto => ({
  running: true,
  identity: { checkout: "/repos/corvi", buildId: "9f8e7d6c5b4a", protocol: 1 },
  stale: [],
});

const foreign = (): HostStatusDto => ({
  running: true,
  identity: { checkout: "/repos/corvi-worktree", buildId: "9f8e7d6c5b4a", protocol: 1 },
  stale: [{ kind: "checkout", theirs: "/repos/corvi-worktree", ours: "/repos/corvi" }],
  sessions: { live: 3, working: 1 },
});

let status: HostStatusDto;
let restarts = 0;

const serve = async (page: Page): Promise<void> => {
  await page.route(
    (u) => u.pathname === "/api/terminals/host" || u.pathname === "/api/terminals/host/restart",
    async (route) => {
      const answer = (body: HostStatusDto): Promise<void> =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
      if (route.request().method() === "POST") {
        restarts += 1;
        status = ours();
        await answer(status);
        return;
      }
      await answer(status);
    },
  );
};

/** A token's value in the form `getComputedStyle` reports colours, resolved in the page: the
 * assertion is that the control wears the theme's token, not which shade the default theme uses. */
const resolved = (page: Page, token: string): Promise<string> =>
  page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  }, token);

const icon = (page: Page): Locator => page.locator(".sidebar .icon-entry.stale");

test.skipIf(!usable)(
  "a host this server did not start offers a restart, and asks before taking it",
  async () => {
    status = ours();
    restarts = 0;
    return withPage(browser, async (page) => {
      await serve(page);
      await page.goto(url, { waitUntil: "domcontentloaded" });

      // In step: there is nothing to offer, so there is no icon.
      await page.locator(".sidebar .bottom-row").waitFor();
      expect(await icon(page).count()).toBe(0);

      // A foreign host appears (another instance wrote the owner record): the icon turns up in
      // the warning colour, and its tooltip names what differs.
      status = foreign();
      await page.reload({ waitUntil: "domcontentloaded" });
      const restart = icon(page);
      await restart.waitFor();
      expect(await restart.getAttribute("title")).toBe(
        "Terminal host started from another checkout — restart it",
      );
      expect(await restart.evaluate((el) => getComputedStyle(el).color)).toBe(await resolved(page, "--warn"));

      // The click asks, with the reason and what it would end.
      await restart.click();
      const dialog = page.locator("dialog");
      await dialog.waitFor();
      expect(await dialog.locator("h3").textContent()).toBe("Restart the terminal host");
      const reasons = dialog.locator(".host-mismatches li");
      expect(await reasons.count()).toBe(1);
      expect(await reasons.first().textContent()).toBe(
        "It was started from /repos/corvi-worktree; this server runs from /repos/corvi.",
      );
      expect(await dialog.textContent()).toContain(
        "3 terminals will be closed with it. 1 of them is running an agent that reports working, and loses its turn.",
      );

      // Not now: nothing happens, and the host is still there to restart later.
      await dialog.locator("button", { hasText: "Not now" }).click();
      await dialog.waitFor({ state: "detached" });
      expect(restarts).toBe(0);
      await restart.waitFor();

      // Restart: one request, the dialog closes, and the icon is gone with the difference.
      await restart.click();
      await dialog.locator("button", { hasText: "Restart the terminal host" }).click();
      await dialog.waitFor({ state: "detached" });
      expect(restarts).toBe(1);
      await icon(page).waitFor({ state: "detached" });

      // An out-of-date host with nothing in it is still the user's to restart, and the dialog says
      // that it costs nothing: after an update this is the case most people meet.
      status = foreignBuild();
      await page.reload({ waitUntil: "domcontentloaded" });
      await icon(page).waitFor();
      expect(await icon(page).getAttribute("title")).toBe("Terminal host running another build — restart it");
      await icon(page).click();
      await dialog.waitFor();
      expect(await dialog.locator(".host-mismatches li").first().textContent()).toBe(
        "It is running build 000011112222; this server is build 9f8e7d6c5b4a.",
      );
      expect(await dialog.textContent()).toContain(
        "Nothing is running inside it, so the restart costs no work.",
      );
      await dialog.locator("button", { hasText: "Not now" }).click();
      await dialog.waitFor({ state: "detached" });
    });
  },
);
