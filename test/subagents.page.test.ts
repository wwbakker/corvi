import { test, expect, beforeAll, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { chromium, webkit, type Browser, type Page } from "playwright";
import { closePages, requireFreshWebBundle, serverEnv, testRun, testTempDir, waitForUrl } from "./helpers.ts";
import { editorText, fillEditor } from "./editor.ts";

/**
 * The Subagents page through the page: a profile file is edited in the editor's frame — the
 * Markdown source in the shared editor, not a textarea — with the fields' documentation docked
 * to its right. The field vocabulary itself is pinned in packages/agents/test/profile.test.ts;
 * this is the product surface.
 *
 * The server's world is its own temp dir (serverEnv), so `CORVI_CONFIG` moves the global
 * profiles directory with it. If a browser is not installed the page checks skip.
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

let tmp: string;
let url: string;
let server: ReturnType<typeof Bun.spawn>;

const source = [
  "---",
  "label: Mine",
  "harness: pi",
  "model: zai/glm-5.3-flash",
  "phases:",
  "  - Implementation",
  "---",
  "Review {prompt}",
  "",
].join("\n");

beforeAll(async () => {
  tmp = await testTempDir("subagents-page");
  server = Bun.spawn(["node", "apps/server/src/server.ts", `--corvi-test-run=${testRun()}`], {
    env: serverEnv(tmp),
    stdout: "pipe",
    stderr: process.env.CORVI_TEST_LOUD ? "inherit" : "ignore",
  });
  url = await waitForUrl(server);
  const written = await fetch(`${url}/api/subagents/files`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "global", id: "mine", text: source }),
  });
  expect(written.status).toBe(200);
}, 60_000);

afterAll(async () => {
  await closePages(browser, "subagents");
  await browser?.close();
  server?.kill();
  await rm(tmp, { recursive: true, force: true });
});

const editMine = async (page: Page): Promise<void> => {
  await page.goto(`${url}/subagents`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".subagents-page");
  await page
    .locator(".widget p", { hasText: "mine.md" })
    .getByRole("button", { name: "Edit" })
    .click();
  await page.waitForSelector(".subagents-page.editing");
  await page.waitForSelector(".md-editor .cm-placeholder", { state: "detached" });
};

test.skipIf(!usable)("a profile is edited in the editor's frame, its fields documented beside it", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await editMine(page);

    expect(await editorText(page.locator(".md-editor"))).toBe(source);
    expect(await page.locator(".subagents-page textarea").count()).toBe(0);

    // Every field the vocabulary has is documented, named as the file names it.
    const names = await page.locator(".action-docs .field h4 code").allTextContents();
    expect(names).toEqual(["label", "harness", "model", "effort", "phases", "body"]);
    const harness = page.locator(".action-docs .field").filter({ hasText: /^harness/ });
    expect(await harness.locator(".values code").allTextContents()).toEqual(["pi", "opencode"]);
  } finally {
    await page.close();
  }
}, 60_000);

test.skipIf(!usable)("saving a built-in profile copies it to Global", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(`${url}/subagents`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".subagents-page");
    // The built-in section's reviewer row: its Save is a copy to Global, not a write to the
    // shipped file.
    await page
      .locator(".widget", { hasText: "Built-in" })
      .locator("p", { hasText: "reviewer.md" })
      .getByRole("button", { name: "Edit" })
      .click();
    await page.waitForSelector(".subagents-page.editing");
    expect((await page.locator(".subagents-page header h2").textContent()) ?? "").toContain(
      "saving copies it to Global",
    );
    await page.getByRole("button", { name: "Save" }).click();
    await page.waitForSelector(".subagents-page:not(.editing)");

    const listing = (await (await fetch(`${url}/api/subagents/files`)).json()) as {
      files: { id: string; scope: string }[];
    };
    expect(listing.files.some((file) => file.id === "reviewer" && file.scope === "global")).toBe(true);
    expect(listing.files.some((file) => file.id === "reviewer" && file.scope === "builtin")).toBe(true);
  } finally {
    await page.close();
  }
}, 60_000);

test.skipIf(!usable)("a write that is not a profile is refused, and says why", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await editMine(page);
    await fillEditor(page.locator(".md-editor"), "no frontmatter at all");
    await page.getByRole("button", { name: "Save" }).click();

    // Still in the editor — a refused write is nothing but the notice and the text to fix.
    await page.waitForSelector(".subagents-page.editing");
    expect((await page.locator(".subagents-page header .summary").textContent()) ?? "").toContain(
      "frontmatter",
    );
  } finally {
    await page.close();
  }
}, 60_000);
