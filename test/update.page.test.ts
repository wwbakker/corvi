import { test, expect, beforeAll, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { type Browser, type Page } from "playwright";
import {
  closePages,
  openBrowser,
  testTempDir,
  startTestServer,
  stopTestServer,
  VIEWPORT,
  withPage,
} from "./helpers.ts";

/**
 * The auto-update surface in the engine the app renders in: the notice, the icon, and the
 * dialog from "new version" to "Restart now".
 *
 * The update API is stubbed at the page (Playwright routes) and the host bridge is injected
 * with a restart counter, so the flow is driven end to end without a real remote, without
 * `bun install`, and without the installed app — the server under it is the ordinary one,
 * serving the built page (docs/guides/testing.md). What the stub serves is the same wire shape
 * the server's schema declares (packages/client's test pins the encoding).
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
  tmp = await testTempDir("update-pages");
  ({ server, url } = await startTestServer(tmp));
});

afterAll(async () => {
  if (!usable) return;
  await closePages(browser, "update");
  await browser?.close();
  await stopTestServer(server, tmp);
  await rm(tmp, { recursive: true, force: true });
});

// --- What the stub serves --------------------------------------------------------

type StubStatus = Record<string, unknown>;

const commits = [
  {
    sha: "1111111aaaa",
    subject: "Fix the sidebar layout",
    url: "https://github.com/acme/app/commit/1111111aaaa",
  },
  {
    sha: "2222222bbbb",
    subject: "Refactor the widget rows",
    url: "https://github.com/acme/app/commit/2222222bbbb",
  },
];

const available = (): StubStatus => ({
  eligible: true,
  checkedAt: new Date().toISOString(),
  behind: 2,
  commits,
  compareUrl: "https://github.com/acme/app/compare/x...y",
  progress: null,
  restartPending: false,
});

const runningPlan = (): StubStatus => ({
  startedAt: new Date().toISOString(),
  steps: [
    { id: "pull", label: "pull the latest code", state: "running" },
    { id: "install", label: "install dependencies", state: "waiting" },
    { id: "reinstall", label: "rebuild and reinstall the app", state: "waiting" },
  ],
});

const stoppedRun = (): StubStatus => ({
  ...available(),
  progress: {
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    error: "bun install failed: boom",
    steps: [
      { id: "pull", label: "pull the latest code", state: "done" },
      {
        id: "install",
        label: "install dependencies",
        state: "failed",
        detail: "bun install failed: boom",
      },
      { id: "reinstall", label: "rebuild and reinstall the app", state: "waiting" },
    ],
  },
});

const updated = (): StubStatus => ({
  eligible: true,
  behind: 0,
  commits: [],
  progress: {
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    steps: [
      { id: "pull", label: "pull the latest code", state: "done" },
      { id: "install", label: "install dependencies", state: "done" },
      { id: "reinstall", label: "rebuild and reinstall the app", state: "done" },
    ],
  },
  restartPending: true,
});

/** The stub's state: what `GET` serves next, and what the two POSTs counted. */
let status: StubStatus = available();
let starts = 0;
let checks = 0;

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

const serve = async (page: Page): Promise<void> => {
  await page.route(
    (u) => u.pathname.startsWith("/api/app/update"),
    async (route) => {
      const request = route.request();
      const answer = (body: StubStatus, code = 200): Promise<void> =>
        route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(body) });
      if (request.method() === "POST" && request.url().endsWith("/check")) {
        checks += 1;
        await answer(status);
        return;
      }
      if (request.method() === "POST") {
        starts += 1;
        // The run's verdict arrives through the journal the dialog polls — the POST itself only
        // ever carries the opening (202).
        status = starts === 1 ? stoppedRun() : updated();
        await answer({ ...status, progress: runningPlan() }, 202);
        return;
      }
      await answer(status);
    },
  );
  // The bridge's whole contract, restart included, with the restart counted where the test can
  // read it (the pattern apps/web/src/domain/host.ts documents).
  await page.addInitScript(() => {
    const win = window as unknown as { corviHost?: unknown; restarts: number };
    win.restarts = 0;
    win.corviHost = {
      platform: "linux",
      notify: () => {},
      onOpenWindow: () => {},
      setContextMenu: () => {},
      restart: () => {
        win.restarts += 1;
      },
    };
  });
};

// --- The flow --------------------------------------------------------------------

test.skipIf(!usable)(
  "a new version toasts once, and the dialog takes it all the way to Restart now",
  async () => {
    status = available();
    starts = 0;
    checks = 0;
    return withPage(
      browser,
      async (page) => {
        await serve(page);
        await page.goto(url, { waitUntil: "domcontentloaded" });

        // The notice says it once; the icon keeps saying it in yellow after the notice is gone.
        const toast = page.locator(".toast", { hasText: "New version available" });
        await toast.waitFor();
        expect(await toast.locator(".toast-body").textContent()).toContain("2 new commits");
        const icon = page.locator(".sidebar .icon-entry.update.available");
        await icon.waitFor();
        expect(await icon.evaluate((el) => getComputedStyle(el).color)).toBe(await resolved(page, "--warn"));
        await page.locator(".toast-close").click();
        await toast.waitFor({ state: "detached" });
        await icon.waitFor();

        // The dialog: what is new, each commit linked to GitHub, and the one button that takes it.
        await icon.click();
        const dialog = page.locator("dialog");
        await dialog.waitFor();
        expect(await dialog.locator("h3").textContent()).toContain("Update available — 2 commits behind");
        const links = dialog.locator(".commits li a");
        expect(await links.count()).toBe(2);
        expect(await links.first().getAttribute("href")).toContain("/commit/1111111aaaa");
        expect(await dialog.locator("a", { hasText: "compare on GitHub" }).getAttribute("href")).toContain(
          "/compare/",
        );

        // Update now: the run stops at the install step, and the journal is what says so.
        await dialog.getByRole("button", { name: "Update now" }).click();
        await dialog.getByRole("button", { name: "Try again" }).waitFor();
        expect(await dialog.locator(".progress-steps li.failed").count()).toBe(1);
        expect(await dialog.textContent()).toContain("stopped: bun install failed: boom");

        // Try again picks up what is left; the last thing offered is the restart itself.
        await dialog.getByRole("button", { name: "Try again" }).click();
        await dialog.getByRole("button", { name: "Restart now" }).waitFor();
        expect(await dialog.textContent()).toContain("The new version is ready.");
        await dialog.getByRole("button", { name: "Restart now" }).click();
        expect(await page.evaluate(() => (window as unknown as { restarts: number }).restarts)).toBe(1);
        expect(starts).toBe(2);
      },
      VIEWPORT,
    );
  },
  60_000,
);

test.skipIf(!usable)(
  "a refused update stands in place of the button, in the same words",
  async () => {
    status = {
      ...available(),
      behind: 1,
      commits: [commits[0]],
      refusal: "uncommitted changes in the checkout",
    };
    return withPage(
      browser,
      async (page) => {
        await serve(page);
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await page.locator(".sidebar .icon-entry.update.available").click();
        const dialog = page.locator("dialog");
        await dialog.waitFor();
        expect(await dialog.textContent()).toContain("uncommitted changes in the checkout");
        expect(await dialog.getByRole("button", { name: "Update now" }).count()).toBe(0);
      },
      VIEWPORT,
    );
  },
  60_000,
);

test.skipIf(!usable)(
  "an up-to-date app says so, and offers to check",
  async () => {
    status = { eligible: true, behind: 0, commits: [], progress: null, restartPending: false };
    checks = 0;
    return withPage(
      browser,
      async (page) => {
        await serve(page);
        await page.goto(url, { waitUntil: "domcontentloaded" });
        // Gray, not yellow: no update is waiting.
        const icon = page.locator(".sidebar .icon-entry.update");
        await icon.waitFor();
        expect(await icon.evaluate((el) => getComputedStyle(el).color)).toBe(
          await resolved(page, "--nav-muted"),
        );
        await icon.click();
        const dialog = page.locator("dialog");
        await dialog.waitFor();
        expect(await dialog.locator("h3").textContent()).toBe("Corvi is up to date");
        await dialog.getByRole("button", { name: "Check again" }).click();
        for (let i = 0; i < 100 && checks === 0; i++) await Bun.sleep(50);
        expect(checks).toBe(1);
      },
      VIEWPORT,
    );
  },
  60_000,
);
