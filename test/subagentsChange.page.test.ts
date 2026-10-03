import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit, type Browser } from "playwright";
import { closePages, requireFreshWebBundle, serverEnv, testRun, testTempDir, waitForUrl, stopRunHost } from "./helpers.ts";

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

test.skipIf(!usable)("the Subagents section shows the conversation beside the terminal, and sends a message", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    await page.goto(`${url}/changes/${CHANGE}/subagents`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".subagents-layout");

    // The conversation, and the terminal beside it.
    await page.locator(".subagent-log", { hasText: "Review the plan" }).waitFor();
    await page.locator(".subagent-terminal .terminal.xterm").waitFor();

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
