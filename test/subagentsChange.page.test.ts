import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit, type Browser } from "playwright";
import { budget, closePages, requireFreshWebBundle, serverEnv, testRun, testTempDir, until, waitForUrl, stopRunHost } from "./helpers.ts";

/**
 * The change page's Subagents section: the selected subagent's conversation beside its terminal,
 * with a composer that appends a logged, submitted message. The API is pinned in
 * `test/subagents.instances.test.ts`; this is the product surface.
 *
 * The instance is seeded directly (create would launch a harness). If a browser is not installed
 * the page checks skip.
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

const CHANGE = "SUB-PAGE";

/** Create a real terminal window in the seeded change and return its registry id and live pane. */
const newWindow = async (): Promise<{ readonly id: string; readonly paneId: string }> => {
  const list = (await (
    await fetch(`${url}/api/changes/${CHANGE}/terminal/windows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "new" }),
    })
  ).json()) as { id: string; active: boolean; activePane: string }[];
  const created = list.find((window) => window.active);
  if (created === undefined) throw new Error("the created window is not active in its own answer");
  return { id: created.id, paneId: created.activePane };
};

/** A live subagent DTO with a stable pane/window identity, for the browser tests that mock the
 * list route (the seeded instances are detached). */
const attachedInstance = (id: string, label: string, windowId: string): Record<string, unknown> => ({
  id,
  changeId: CHANGE,
  profile: "builtin:reviewer",
  label,
  harness: "pi",
  createdBy: "orchestrator",
  createdAt: "2026-01-01T00:00:00.000Z",
  presence: "attached",
  activity: "idle",
  interrupted: false,
  awaitingReply: false,
  // A deliberately wrong index: the click must focus by the stable ids, never by this position.
  windowIndex: 99,
  windowId,
  paneId: windowId,
  log: [],
  messages: [],
});

let tmp: string;
let url: string;
let server: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  tmp = await testTempDir("subagents-change-page");
  const dir = join(tmp, "changes", CHANGE);
  await mkdir(join(dir, "subagents", "reviewer-1"), { recursive: true });
  await writeFile(
    join(dir, "change.json"),
    JSON.stringify({
      id: CHANGE,
      branch: CHANGE,
      title: "Subagent page",
      state: "Implementation",
      createdAt: "2026-01-01T00:00:00.000Z",
      formatVersion: 2,
    }),
    "utf8",
  );
  await writeFile(
    join(dir, "subagents", "reviewer-1", "session.json"),
    JSON.stringify({
      id: "reviewer-1",
      changeId: CHANGE,
      profile: "builtin:reviewer",
      label: "Reviewer",
      harness: "pi",
      createdBy: "orchestrator",
      createdAt: "2026-01-01T00:00:00.000Z",
      log: [{ kind: "created", at: "2026-01-01T00:00:00.000Z" }],
    }),
    "utf8",
  );
  await writeFile(
    join(dir, "subagents", "reviewer-1", "001-orchestrator.md"),
    "---\nfrom: orchestrator\nat: 2026-01-01T00:00:00.000Z\n---\nReview the plan\n",
    "utf8",
  );
  // A second, interrupted instance: a turn in flight with no live window.
  await mkdir(join(dir, "subagents", "reviewer-2"), { recursive: true });
  await writeFile(
    join(dir, "subagents", "reviewer-2", "session.json"),
    JSON.stringify({
      id: "reviewer-2",
      changeId: CHANGE,
      profile: "builtin:reviewer",
      label: "Interrupted reviewer",
      harness: "pi",
      createdBy: "orchestrator",
      createdAt: "2026-01-01T00:00:00.000Z",
      inFlight: 1,
      log: [
        { kind: "created", at: "2026-01-01T00:00:00.000Z" },
        { kind: "turn_started", at: "2026-01-01T00:05:00.000Z", note: "message 1" },
      ],
    }),
    "utf8",
  );
  await writeFile(
    join(dir, "subagents", "reviewer-2", "001-orchestrator.md"),
    "---\nfrom: orchestrator\nat: 2026-01-01T00:00:00.000Z\n---\nDo the thing\n",
    "utf8",
  );
  server = Bun.spawn(["node", "apps/server/src/server.ts", `--corvi-test-run=${testRun()}`], {
    env: serverEnv(tmp),
    stdout: "pipe",
    stderr: process.env.CORVI_TEST_LOUD ? "inherit" : "ignore",
  });
  url = await waitForUrl(server);
}, 60_000);

afterAll(async () => {
  await closePages(browser, "subagents-change");
  await browser?.close();
  server?.kill();
  await stopRunHost(tmp);
  await rm(tmp, { recursive: true, force: true });
});

test.skipIf(!usable)("an interrupted subagent is badged, and Continue restarts it explicitly", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    await page.goto(`${url}/changes/${CHANGE}/subagents`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".subagents-layout");

    // Selecting another subagent is a selection, not a navigation: the Subagents page stays put.
    await page.locator(".subagent-list .entry", { hasText: "Interrupted reviewer" }).click();
    expect(new URL(page.url()).pathname).toBe(`/changes/${CHANGE}/subagents`);
    await page.locator(".badge.warn", { hasText: "interrupted" }).first().waitFor();

    // Continue sends the fixed note as a new inbound message.
    await page.getByRole("button", { name: "Continue" }).click();
    await page.locator(".subagent-message.orchestrator", { hasText: "interrupted mid-task" }).waitFor();
  } finally {
    await page.close();
  }
}, 60_000);

test.skipIf(!usable)("the Subagents section shows the conversation beside the pane, and sends a message", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    await page.goto(`${url}/changes/${CHANGE}/subagents`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".subagents-layout");

    // The conversation. The seeded subagents are detached, so the pane area says there is no live
    // terminal rather than attaching this page to whatever shell the change happens to have active.
    await page.locator(".subagent-log", { hasText: "Review the plan" }).waitFor();
    await page.locator(".subagent-terminal .hint", { hasText: "no live terminal" }).waitFor();
    expect(await page.locator(".subagent-terminal .terminal-screen").count()).toBe(0);

    // The composer appends a logged, submitted message.
    await page.locator(".subagent-composer textarea").fill("Please look closer");
    await page.getByRole("button", { name: "Send" }).click();
    await page.locator(".subagent-log", { hasText: "Please look closer" }).waitFor();

    // It is an inbound orchestrator message in the log, not only in the box.
    await page.locator(".subagent-message.orchestrator", { hasText: "Please look closer" }).waitFor();
  } finally {
    await page.close();
  }
}, 60_000);

test.skipIf(!usable)("an attached subagent renders its own pane; a reorder-before-click still focuses by id", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    // Two real windows: the second was created last and is active, so focusing the first is a real
    // registry change, not a no-op. The subagent's DTO names the first by id and carries the
    // deliberately wrong index 99, so an index-based focus would target a window that is not there.
    const first = await newWindow();
    const second = await newWindow();
    expect(second.id).not.toBe(first.id);
    const attached = attachedInstance("attached-1", "Attached reviewer", first.id);
    attached.paneId = first.paneId;
    await page.route(`**/api/changes/${CHANGE}/subagents`, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ instances: [attached] }),
      });
    });
    await page.goto(`${url}/changes/${CHANGE}/subagents`, { waitUntil: "domcontentloaded" });
    await page.locator(".subagent-list .entry", { hasText: "Attached reviewer" }).waitFor();

    // The default presentation is the attached subagent's own live pane, by stable id, and it
    // attaches for real (the named pane exists on the server).
    const subagentPane = page.locator(".subagent-terminal .terminal-screen");
    await subagentPane.waitFor();
    expect(await subagentPane.getAttribute("data-session")).toBe(first.paneId);
    await page.locator(".subagent-terminal .terminal-screen[data-attached]").waitFor({ timeout: budget(30_000) });

    // An explicit click focuses its window immediately (no waiting for an unrelated refresh), by
    // the window id rather than the position the instances snapshot happened to carry.
    const focus = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname.endsWith(`/api/changes/${CHANGE}/terminal/windows`),
    );
    await page.locator(".subagent-list .entry", { hasText: "Attached reviewer" }).click();
    const body = JSON.parse((await focus).postData() ?? "{}") as { action?: string; window?: string; index?: number };
    expect(body).toMatchObject({ action: "select", window: first.id });
    expect(body.index).toBeUndefined();

    // The server's active window really moved to the subagent's window.
    await until(
      async () => {
        const list = (await (await fetch(`${url}/api/changes/${CHANGE}/terminal/windows`)).json()) as {
          id: string;
          active: boolean;
        }[];
        return list.find((window) => window.active)?.id === first.id;
      },
      true,
      10_000,
    );
  } finally {
    await page.close();
  }
}, 60_000);

test.skipIf(!usable)("a selected subagent that disappears asks for another, without switching input", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const gone = attachedInstance("gone-1", "Gone reviewer", "w-gone");
  const kept = attachedInstance("kept-2", "Kept reviewer", "w-kept");
  let removed = false;
  let listCalls = 0;
  try {
    await page.route(`**/api/changes/${CHANGE}/subagents`, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      listCalls += 1;
      const instances = removed ? [kept] : [gone, kept];
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ instances }) });
    });
    await page.goto(`${url}/changes/${CHANGE}/subagents`, { waitUntil: "domcontentloaded" });
    const pane = page.locator(".subagent-terminal .terminal-screen");
    await pane.waitFor();
    expect(await pane.getAttribute("data-session")).toBe("w-gone");

    // The pinned subagent's record disappears while another remains. A real window creation makes
    // the server announce `windows`, so the list reloads without it.
    removed = true;
    await fetch(`${url}/api/changes/${CHANGE}/terminal/windows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "new" }),
    });
    await until(async () => listCalls >= 2, true, 10_000);
    await page.waitForTimeout(300);

    // No auto-switch to the survivor and no input target: the placeholder asks for another choice
    // because a record that is not there has no Open button.
    await page.locator(".subagent-terminal .hint", { hasText: "no longer here" }).waitFor();
    expect(await page.locator(".subagent-terminal .terminal-screen").count()).toBe(0);

    // Choosing the survivor shows its own pane and focuses its window by id.
    const focus = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname.endsWith(`/api/changes/${CHANGE}/terminal/windows`),
    );
    await page.locator(".subagent-list .entry", { hasText: "Kept reviewer" }).click();
    const body = JSON.parse((await focus).postData() ?? "{}") as { action?: string; window?: string };
    expect(body).toMatchObject({ action: "select", window: "w-kept" });
    await page.locator(".subagent-terminal .terminal-screen").waitFor();
    expect(await page.locator(".subagent-terminal .terminal-screen").getAttribute("data-session")).toBe("w-kept");
  } finally {
    await page.close();
  }
}, 60_000);

test.skipIf(!usable)("a background-created subagent does not move the pinned pane", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const first = attachedInstance("pinned-1", "Pinned reviewer", "w-a");
  const later = attachedInstance("created-2", "Created reviewer", "w-b");
  let released = false;
  let listCalls = 0;
  try {
    await page.route(`**/api/changes/${CHANGE}/subagents`, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      listCalls += 1;
      // Once the background window exists, the server's list puts the new subagent first.
      const instances = released ? [later, first] : [first];
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ instances }) });
    });
    await page.goto(`${url}/changes/${CHANGE}/subagents`, { waitUntil: "domcontentloaded" });
    const pane = page.locator(".subagent-terminal .terminal-screen");
    await pane.waitFor();
    expect(await pane.getAttribute("data-session")).toBe("w-a");

    // A real background window creation makes the server announce `windows`, so the list reloads
    // with the new subagent first. The displayed pane must stay the one that was already shown.
    released = true;
    await fetch(`${url}/api/changes/${CHANGE}/terminal/windows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "new" }),
    });
    await until(async () => listCalls >= 2, true, 10_000);
    await page.waitForTimeout(500);
    expect(await pane.getAttribute("data-session")).toBe("w-a");
  } finally {
    await page.close();
  }
}, 60_000);
