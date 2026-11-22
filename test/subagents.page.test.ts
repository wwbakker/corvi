import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type Browser, type Page } from "playwright";
import {
  closePages,
  openEngine,
  runSh,
  serverEnv,
  testTempDir,
  startTestServer,
  stopTestServer,
  VIEWPORT,
  withPage,
} from "./helpers.ts";
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
const usable = await openEngine((opened) => {
  browser = opened;
});

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
  ({ server, url } = await startTestServer(tmp));
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
  await stopTestServer(server, tmp);
  await rm(tmp, { recursive: true, force: true });
});

const editMine = async (page: Page): Promise<void> => {
  await page.goto(`${url}/subagents`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".subagents-page");
  await page.locator(".widget p", { hasText: "mine.md" }).getByRole("button", { name: "Edit" }).click();
  await page.waitForSelector(".subagents-page.editing");
  await page.waitForSelector(".md-editor .cm-placeholder", { state: "detached" });
};

test.skipIf(!usable)(
  "a profile is edited in the editor's frame, its fields documented beside it",
  async () => {
    await withPage(browser, async (page) => {
      await editMine(page);

      expect(await editorText(page.locator(".md-editor"))).toBe(source);
      expect(await page.locator(".subagents-page textarea").count()).toBe(0);

      // Every field the vocabulary has is documented, named as the file names it.
      const names = await page.locator(".action-docs .field h4 code").allTextContents();
      expect(names).toEqual([
        "label",
        "harness",
        "agent",
        "model",
        "effort",
        "enabledModels",
        "instructions",
        "extensions",
        "skills",
        "packages",
        "mcp",
        "phases",
        "body",
      ]);
      // The harness is any id, so the field is text; the agent is the closed vocabulary.
      const harness = page.locator(".action-docs .field").filter({ hasText: /^harness/ });
      expect(await harness.textContent()).toContain("harness id");
      const agent = page.locator(".action-docs .field").filter({ hasText: /^agent/ });
      expect(await agent.locator(".values code").allTextContents()).toEqual(["pi", "opencode"]);
    });
  },
  60_000,
);

test.skipIf(!usable)(
  "New offers the built-ins as templates, and a copy lands in the scope",
  async () => {
    await withPage(browser, async (page) => {
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
      expect((await page.locator(".template-preview").textContent()) ?? "").toContain("Review the change");
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
    });
  },
  60_000,
);

test.skipIf(!usable)(
  "a write that is not a profile is refused, and says why",
  async () => {
    await withPage(browser, async (page) => {
      await editMine(page);
      await fillEditor(page.locator(".md-editor"), "no frontmatter at all");
      await page.getByRole("button", { name: "Save" }).click();

      // Still in the editor — a refused write is nothing but the notice and the text to fix.
      await page.waitForSelector(".subagents-page.editing");
      expect((await page.locator(".subagents-page header .summary").textContent()) ?? "").toContain(
        "frontmatter",
      );
    });
  },
  60_000,
);

test.skipIf(!usable)(
  "the Repositories block lists a change's checkout files, and creates, edits and deletes one",
  async () => {
    // A change with one real checkout on its branch, holding a good profile and a broken one: the
    // block shows what the change's checkouts carry — problems and all, never hidden.
    const branch = "PROJ-repo-page";
    const repo = join(tmp, "repo");
    await runSh(["git", "init", "-b", branch, repo]);
    await writeFile(join(repo, "README.md"), "hi\n");
    await runSh(["git", "add", "."], repo);
    await runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], repo);
    await mkdir(join(repo, ".corvi", "subagents"), { recursive: true });
    await writeFile(
      join(repo, ".corvi", "subagents", "broken.md"),
      "---\nlabel: X\nagent: cursor\n---\nbody\n",
    );
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

    await withPage(browser, async (page) => {
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
        "agent",
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
    });
  },
  60_000,
);
