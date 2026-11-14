import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit, type Browser } from "playwright";
import { budget, closePages, requireFreshWebBundle, serverEnv, testRun, testTempDir, until, waitForUrl, stopRunHost } from "./helpers.ts";

/**
 * The dashboard's Subagents card: the change's instances — attached or not — and the three actions
 * the CLI otherwise owns (Open, Close, Continue). The routes behind them are pinned in
 * `test/subagents.instances.test.ts`; this is the product surface.
 *
 * The instance records are seeded directly, because creating one would launch a harness. A test
 * that needs a live window mocks the list and action routes instead: what is asserted here is the
 * card's wiring — which row offers which button, and what pressing it asks the server for. If a
 * browser is not installed the page checks skip.
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

/** The change the seeded instances belong to. */
const CHANGE = "SUB-CARD";
/** A change that never used a subagent: its dashboard has no card. */
const BARE = "SUB-CARD-BARE";

let tmp: string;
let url: string;
let server: ReturnType<typeof Bun.spawn>;

/** One change's directory, with the record the dashboard reads. */
const writeChange = async (id: string, title: string): Promise<string> => {
  const dir = join(tmp, "changes", id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "change.json"),
    JSON.stringify({
      id,
      branch: id,
      title,
      state: "Implementation",
      createdAt: "2026-01-01T00:00:00.000Z",
      formatVersion: 2,
    }),
    "utf8",
  );
  return dir;
};

/** One seeded instance: its record, and the one inbound message that starts it. */
const seedInstance = async (
  dir: string,
  id: string,
  label: string,
  session: Record<string, unknown>,
): Promise<void> => {
  const at = join(dir, "subagents", id);
  await mkdir(at, { recursive: true });
  await writeFile(
    join(at, "session.json"),
    JSON.stringify({
      id,
      changeId: CHANGE,
      profile: "builtin:reviewer",
      label,
      harness: "pi",
      createdBy: "orchestrator",
      createdAt: "2026-01-01T00:00:00.000Z",
      log: [{ kind: "created", at: "2026-01-01T00:00:00.000Z" }],
      ...session,
    }),
    "utf8",
  );
  await writeFile(
    join(at, "001-orchestrator.md"),
    "---\nfrom: orchestrator\nat: 2026-01-01T00:00:00.000Z\n---\nReview the plan\n",
    "utf8",
  );
};

/** A listed instance as the card sees it, for the tests that answer the list route themselves. */
const instance = (
  id: string,
  label: string,
  fields: { readonly presence: "attached" | "detached"; readonly interrupted?: boolean },
): Record<string, unknown> => ({
  id,
  changeId: CHANGE,
  profile: "builtin:reviewer",
  label,
  harness: "pi",
  createdBy: "orchestrator",
  createdAt: "2026-01-01T00:00:00.000Z",
  presence: fields.presence,
  activity: "idle",
  interrupted: fields.interrupted === true,
  awaitingReply: false,
  log: [],
  messages: [],
});

const listRoute = `**/api/changes/${CHANGE}/subagents`;
const openRoute = `**/api/changes/${CHANGE}/subagents/reviewer-1/open`;
const closeRoute = `**/api/changes/${CHANGE}/subagents/reviewer-1/close`;
const messagesRoute = `**/api/changes/${CHANGE}/subagents/reviewer-2/messages`;

beforeAll(async () => {
  tmp = await testTempDir("subagents-card-page");
  await writeChange(BARE, "No subagents");
  const dir = await writeChange(CHANGE, "Subagent card");
  // A closed instance and an interrupted one: both have no live window, and they are exactly what
  // the card exists to make visible.
  await seedInstance(dir, "reviewer-1", "Reviewer one", {});
  await seedInstance(dir, "reviewer-2", "Interrupted reviewer", {
    inFlight: 1,
    log: [
      { kind: "created", at: "2026-01-01T00:00:00.000Z" },
      { kind: "turn_started", at: "2026-01-01T00:05:00.000Z", note: "message 1" },
    ],
  });
  server = Bun.spawn(["node", "apps/server/src/server.ts", `--corvi-test-run=${testRun()}`], {
    env: serverEnv(tmp),
    stdout: "pipe",
    stderr: process.env.CORVI_TEST_LOUD ? "inherit" : "ignore",
  });
  url = await waitForUrl(server);
}, 60_000);

afterAll(async () => {
  await closePages(browser, "subagents-card");
  await browser?.close();
  server?.kill();
  await stopRunHost(tmp);
  await rm(tmp, { recursive: true, force: true });
});

test.skipIf(!usable)("the card lists every subagent, and a change with none has no card", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    // A change with no subagents: the card is absent, not empty. The read is counted so the
    // assertion waits for the answer rather than for the card's absence.
    let asked = 0;
    await page.route(`**/api/changes/${BARE}/subagents`, async (route) => {
      asked += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ instances: [] }) });
    });
    await page.goto(`${url}/changes/${BARE}/dashboard`, { waitUntil: "domcontentloaded" });
    await until(async () => asked > 0, true, budget(10_000));
    expect(await page.locator('[data-testid="subagents"]').count()).toBe(0);

    // The tab is not one of a change's views any more, and a URL that still names it is a stale id
    // the page resolves to the plan.
    await page.goto(`${url}/changes/${BARE}/subagents`, { waitUntil: "domcontentloaded" });
    await page.locator(".change-tabs .tab.current").waitFor();
    expect((await page.locator(".change-tabs .tab.current").innerText()).trim()).toBe("Plan");

    // A change that has subagents lists all of them, attached or not.
    await page.goto(`${url}/changes/${CHANGE}/dashboard`, { waitUntil: "domcontentloaded" });
    const card = page.locator('[data-testid="subagents"]');
    await card.waitFor();
    expect((await card.locator(".item .label").allInnerTexts()).map((s) => s.trim()).sort()).toEqual([
      "Interrupted reviewer",
      "Reviewer one",
    ]);
    // No live window on either, so both offer Open and neither offers Close.
    expect(await card.getByRole("button", { name: "Open" }).count()).toBe(2);
    expect(await card.getByRole("button", { name: "Close" }).count()).toBe(0);

    const interrupted = card.locator(".item", { hasText: "Interrupted reviewer" });
    expect((await interrupted.locator(".badge.warn").allInnerTexts()).map((s) => s.trim())).toEqual([
      "interrupted",
    ]);
    expect(await interrupted.getByRole("button", { name: "Continue" }).count()).toBe(1);
    // The healthy row carries no rescue.
    expect(await card.locator(".item", { hasText: "Reviewer one" }).getByRole("button", { name: "Continue" }).count()).toBe(0);
  } finally {
    await page.close();
  }
}, 60_000);

test.skipIf(!usable)("Open reopens a closed subagent and lands on the terminal it opened", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    await page.route(listRoute, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ instances: [instance("reviewer-1", "Reviewer one", { presence: "detached" })] }),
      });
    });
    let opened = 0;
    await page.route(openRoute, async (route) => {
      opened += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(instance("reviewer-1", "Reviewer one", { presence: "attached" })),
      });
    });

    await page.goto(`${url}/changes/${CHANGE}/dashboard`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-testid="subagents"] .item', { hasText: "Reviewer one" }).getByRole("button", { name: "Open" }).click();

    // The server selects the recreated window, so the terminal page is already showing it.
    await page.waitForURL(`**/changes/${CHANGE}/terminals`);
    expect(opened).toBe(1);
    expect(await page.locator('[data-testid="subagents"]').count()).toBe(0);
  } finally {
    await page.close();
  }
}, 60_000);

test.skipIf(!usable)("Close leaves the row closed, and the card offers to reopen it", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  let attached = true;
  try {
    await page.route(listRoute, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          instances: [instance("reviewer-1", "Reviewer one", { presence: attached ? "attached" : "detached" })],
        }),
      });
    });
    await page.route(closeRoute, async (route) => {
      attached = false;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(instance("reviewer-1", "Reviewer one", { presence: "detached" })),
      });
    });

    await page.goto(`${url}/changes/${CHANGE}/dashboard`, { waitUntil: "domcontentloaded" });
    const row = page.locator('[data-testid="subagents"] .item', { hasText: "Reviewer one" });
    await row.getByRole("button", { name: "Close" }).click();

    // The card re-reads after the close: presence is the server's answer, not a local guess.
    await until(async () => (await row.innerText()).includes("detached"), true, budget(10_000));
    expect(await row.getByRole("button", { name: "Open" }).count()).toBe(1);
    expect(await row.getByRole("button", { name: "Close" }).count()).toBe(0);
  } finally {
    await page.close();
  }
}, 60_000);

test.skipIf(!usable)("Continue sends the fixed note once, as a submitted message", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  let sent: { body: Record<string, unknown>; key: string | undefined } | undefined;
  try {
    await page.route(listRoute, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          instances: [instance("reviewer-2", "Interrupted reviewer", { presence: "detached", interrupted: true })],
        }),
      });
    });
    await page.route(messagesRoute, async (route) => {
      const request = route.request();
      sent = {
        body: JSON.parse(request.postData() ?? "{}") as Record<string, unknown>,
        key: request.headers()["idempotency-key"],
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          number: 2,
          role: "orchestrator",
          at: "2026-01-01T00:06:00.000Z",
          body: "the note",
          ...(sent.key === undefined ? {} : { key: sent.key }),
        }),
      });
    });

    await page.goto(`${url}/changes/${CHANGE}/dashboard`, { waitUntil: "domcontentloaded" });
    const row = page.locator('[data-testid="subagents"] .item', { hasText: "Interrupted reviewer" });
    await row.getByRole("button", { name: "Continue" }).click();

    await until(async () => sent !== undefined, true, budget(10_000));
    expect(String(sent?.body.text)).toContain("interrupted mid-task");
    // A retried request is the same message rather than a second one.
    expect(sent?.key).toMatch(/^[0-9a-f-]{36}$/);
  } finally {
    await page.close();
  }
}, 60_000);
