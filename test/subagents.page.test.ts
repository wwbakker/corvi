import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { chromium, webkit, type Browser, type Page } from "playwright";
import { closePages, requireFreshWebBundle, runSh, serverEnv, testRun, testTempDir, waitForUrl } from "./helpers.ts";
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

test.skipIf(!usable)("New offers the built-ins as templates, and a copy lands in the scope", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(`${url}/subagents`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".subagents-page");
    // The shipped profile is a template in the create flow, not a row of its own.
    expect(await page.locator(".widget h3", { hasText: "Built-in" }).count()).toBe(0);

    // Blank: the id typed, the smallest file that parses.
    await page.locator(".widget", { hasText: "Global" }).getByRole("button", { name: "New" }).click();
    await page.waitForSelector("dialog.template-picker");
    await page.getByLabel("new profile id").fill("blank-one");
    await page.getByRole("button", { name: "Create" }).click();
    await page.waitForSelector(".subagents-page.editing");
    await page.getByRole("button", { name: "Cancel" }).click();

    // The built-in as a template: its label and one-line description in the row, its text in
    // the preview, and the id defaulting to the template's own.
    await page.locator(".widget", { hasText: "Global" }).getByRole("button", { name: "New" }).click();
    await page.waitForSelector("dialog.template-picker");
    const choice = page.locator(".template-choice", { hasText: "Reviewer" });
    expect((await choice.textContent()) ?? "").toContain("Review the change");
    await choice.click();
    expect((await page.locator(".template-preview").textContent()) ?? "").toContain(
      "Review the change",
    );
    await page.getByRole("button", { name: "Create" }).click();
    await page.waitForSelector(".subagents-page.editing");

    // The copy lands in Global with the template's id — shadowing the shipped one by
    // precedence, which stays listed beside it.
    const listing = (await (await fetch(`${url}/api/subagents/files`)).json()) as {
      files: { id: string; scope: string }[];
    };
    expect(listing.files.some((file) => file.id === "reviewer" && file.scope === "global")).toBe(true);
    expect(listing.files.some((file) => file.id === "reviewer" && file.scope === "builtin")).toBe(true);
    expect(listing.files.some((file) => file.id === "blank-one" && file.scope === "global")).toBe(true);
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

test.skipIf(!usable)("the Repositories block lists a change's checkout files, and creates, edits and deletes one", async () => {
  // A change with one real checkout on its branch, holding a good profile and a broken one: the
  // block shows what the change's checkouts carry — problems and all, never hidden.
  const branch = "PROJ-repo-page";
  const repo = join(tmp, "repo");
  await runSh(["git", "init", "-b", branch, repo]);
  await writeFile(join(repo, "README.md"), "hi\n");
  await runSh(["git", "add", "."], repo);
  await runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], repo);
  await mkdir(join(repo, ".corvi", "subagents"), { recursive: true });
  await writeFile(join(repo, ".corvi", "subagents", "broken.md"), "---\nlabel: X\n---\nbody\n");
  await writeFile(join(repo, ".corvi", "subagents", "repo-mine.md"), source);
  const dir = join(tmp, "changes", branch);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "change.json"),
    JSON.stringify({
      id: branch,
      branch,
      title: "Repo page",
      state: "Implementation",
      createdAt: "2026-01-01T00:00:00.000Z",
      formatVersion: 2,
      checkouts: [{ path: repo, location: "original", branch: { kind: "change" } }],
    }),
    "utf8",
  );
  // A finished change with its own record: the dropdown must not offer it (decision 9).
  const done = join(tmp, "changes", "PROJ-done-page");
  await mkdir(done, { recursive: true });
  await writeFile(
    join(done, "change.json"),
    JSON.stringify({
      id: "PROJ-done-page",
      branch: "PROJ-done-page",
      title: "Done page",
      state: "Completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      formatVersion: 2,
    }),
    "utf8",
  );

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(`${url}/subagents`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".subagents-page");
    await page.locator('select[aria-label="change"]').selectOption({ label: "Repo page" });
    await page.waitForSelector(`h4:text-is("${basename(repo)}")`);
    // Only active changes are offered: the completed one is not in the dropdown.
    const options = await page.locator('select[aria-label="change"] option').allTextContents();
    expect(options).toContain("Repo page");
    expect(options).not.toContain("Done page");

    // The good row and the broken one with its reasons, both in the repository's block.
    expect(await page.locator(".widget p", { hasText: "repo-mine.md" }).count()).toBe(1);
    expect((await page.locator(".widget p", { hasText: "broken.md" }).textContent()) ?? "").toContain(
      "harness",
    );

    // Editing the checkout's file is the same editor's frame; Save writes the checkout file.
    const edited = ["---", "label: Edited", "harness: pi", "---", "Edited body", ""].join("\n");
    await page
      .locator(".widget p", { hasText: "repo-mine.md" })
      .getByRole("button", { name: "Edit" })
      .click();
    await page.waitForSelector(".subagents-page.editing");
    await fillEditor(page.locator(".md-editor"), edited);
    await page.getByRole("button", { name: "Save" }).click();
    await page.waitForSelector(".subagents-page:not(.editing)");
    expect(await readFile(join(repo, ".corvi", "subagents", "repo-mine.md"), "utf8")).toBe(edited);

    // Delete asks, and takes the checkout's file away with it.
    page.on("dialog", (dialog) => void dialog.accept());
    await page
      .locator(".widget p", { hasText: "repo-mine.md" })
      .getByRole("button", { name: "Delete" })
      .click();
    await page.waitForSelector(".widget p:has-text('repo-mine.md')", { state: "detached" });
    expect(await Bun.file(join(repo, ".corvi", "subagents", "repo-mine.md")).exists()).toBe(false);

    // The block creates from the template picker too (decision 14): the copy lands in the
    // checkout.
    await page
      .locator(".widget h4", { hasText: basename(repo) })
      .getByRole("button", { name: "New" })
      .click();
    await page.waitForSelector("dialog.template-picker");
    await page.locator(".template-choice", { hasText: "Reviewer" }).click();
    await page.getByLabel("new profile id").fill("repo-copy");
    await page.getByRole("button", { name: "Create" }).click();
    await page.waitForSelector(".subagents-page.editing");
    expect(await Bun.file(join(repo, ".corvi", "subagents", "repo-copy.md")).exists()).toBe(true);
  } finally {
    await page.close();
  }
}, 60_000);
