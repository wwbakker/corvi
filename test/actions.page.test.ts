import { test, expect, beforeAll, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit, type Browser, type Page } from "playwright";
import { closePages, requireFreshWebBundle, serverEnv, testRun, testTempDir, waitForUrl } from "./helpers.ts";
import { editorText, fillEditor } from "./editor.ts";

/**
 * The Actions page's editor, through the page: an action file is edited in the frame the plan's
 * editor takes — the Markdown source in the shared editor, not a textarea — with the fields'
 * documentation docked to its right. The panel opens and closes and stays where it was left,
 * the field the caret is in is lit, and Save writes the file at once. The field vocabulary
 * itself is pinned in packages/actions/test/fields.test.ts; this is the product surface.
 *
 * The server's world is its own temp dir (serverEnv), so the action files it creates and writes
 * live there — `CORVI_CONFIG` moves the global actions directory with it. What is typed and not
 * saved is guarded on the way out, the same three answers the settings page asks for
 * (docs/decisions/unsaved-changes.md). If a browser is not
 * installed the page checks skip; the fixture's API assertions still run.
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

// The assertions below read the built bundle: a bundle older than the sources would be
// yesterday's UI, and is refused here (test/helpers.ts, docs/guides/testing.md).
if (usable) requireFreshWebBundle();

let tmp: string;
let url: string;
let server: ReturnType<typeof Bun.spawn>;

/** The action being edited: enough fields that the caret has somewhere to go. Its id is not a
 * built-in's, or the list would hold two rows naming the same file. */
const source = [
  "---",
  "label: Review",
  "kind: prompt",
  "target: active",
  "phases:",
  "  - Verification",
  "---",
  "Look it over, then send it.",
  "",
].join("\n");

/** What the file reads after the save test's typing: plain lines only — pressing Enter in a
 * list would (correctly) continue the list, which is the editor's business, not the save's. */
const typed = ["---", "label: Review it", "kind: prompt", "target: active", "---", "Look it over.", ""].join(
  "\n",
);

beforeAll(async () => {
  tmp = await testTempDir("actions-page");
  server = Bun.spawn(["node", "apps/server/src/server.ts", `--corvi-test-run=${testRun()}`], {
    env: serverEnv(tmp),
    stdout: "pipe",
    stderr: process.env.CORVI_TEST_LOUD ? "inherit" : "ignore",
  });
  url = await waitForUrl(server);
  const written = await fetch(`${url}/api/actions/files`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "global", id: "look-over", text: source }),
  });
  expect(written.status).toBe(200);
}, 60_000);

afterAll(async () => {
  // Whatever pages a failed test left open are screenshotted for CI's failure artifacts first.
  await closePages(browser, "actions");
  await browser?.close();
  server?.kill();
  await rm(tmp, { recursive: true, force: true });
});

/** On the list, the file's row is where an edit starts. */
const editReview = async (page: Page): Promise<void> => {
  await page.goto(`${url}/actions`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".actions-page");
  await page
    .locator(".widget p", { hasText: "look-over.md" })
    .getByRole("button", { name: "Edit" })
    .click();
  await page.waitForSelector(".actions-page.editing");
  // CodeMirror draws the placeholder while the document is still empty.
  await page.waitForSelector(".md-editor .cm-placeholder", { state: "detached" });
};

/** The documentation says which field the caret is in, once the page has caught up. */
const litIs = async (page: Page, name: string): Promise<void> => {
  await page.waitForFunction(
    (expected) => document.querySelector(".action-docs .field.at h4 code")?.textContent === expected,
    name,
  );
};

test.skipIf(!usable)("an action is edited in the editor's frame, its fields documented beside it", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await editReview(page);

    // The source is the file, every character of it — the editor, not a textarea.
    expect(await editorText(page.locator(".md-editor"))).toBe(source);
    expect(await page.locator(".actions-page textarea").count()).toBe(0);

    // The frame: the editor fills what the header and the path line leave, the documentation
    // docks to its right at its fixed width, and both end where the page's padding begins —
    // 24px at the window's right edge and 48px above its bottom.
    const editor = await page.locator(".action-editor .md-editor").boundingBox();
    const docs = await page.locator(".action-docs").boundingBox();
    if (!editor || !docs) throw new Error("the editor and its documentation did not lay out");
    expect(Math.abs(editor.y - docs.y)).toBeLessThan(2);
    expect(Math.abs(editor.height - docs.height)).toBeLessThan(2);
    expect(Math.abs(docs.x + docs.width - (1280 - 24))).toBeLessThan(5);
    expect(Math.abs(editor.y + editor.height - (900 - 48))).toBeLessThan(8);
    expect(Math.abs(docs.width - 320)).toBeLessThan(5);

    // Every field the vocabulary has is documented, named as the file names it.
    const names = await page.locator(".action-docs .field h4 code").allTextContents();
    expect(names).toEqual([
      "label",
      "kind",
      "target",
      "start",
      "submit",
      "phases",
      "notify",
      "keepOpen",
      "body",
    ]);
    // The possible values are the vocabulary's own.
    expect(
      await page
        .locator(".action-docs .field", { hasText: "kind" })
        .locator(".values code")
        .allTextContents(),
    ).toEqual(["prompt", "command"]);
    // And what the file says is wrong with it is on the page, beside its path.
    expect((await page.locator(".hint code").first().textContent()) ?? "").toContain("look-over.md");

    // The controls are named and where they were: one write on Save, back to the list on Cancel.
    for (const control of ["Hide docs", "Cancel", "Save", "Delete"]) {
      await page.getByRole("button", { name: control }).waitFor();
    }
  } finally {
    await page.close();
  }
}, 60_000);

test.skipIf(!usable)("the documentation opens and closes, and stays where it was left", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await editReview(page);
    await page.waitForSelector(".action-docs");

    await page.getByRole("button", { name: "Hide docs" }).click();
    await page.waitForSelector(".action-docs", { state: "detached" });

    // Left closed, it stays closed: the state is a preference (a cookie), not the page's mood —
    // and editing is the page's own state, so the reload comes back to the list and its Edit.
    await editReview(page);
    await page.waitForSelector(".action-docs", { state: "detached" });
    await page.getByRole("button", { name: "Show docs" }).click();
    await page.waitForSelector(".action-docs");
  } finally {
    await page.close();
  }
}, 60_000);

test.skipIf(!usable)("the field the caret is in is lit", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await editReview(page);

    // On a field's own line, that field.
    await page.locator(".cm-line", { hasText: "kind: prompt" }).click();
    await litIs(page, "kind");
    // On a phase in its list, the field the list belongs to.
    await page.locator(".cm-line", { hasText: "- Verification" }).click();
    await litIs(page, "phases");
    // Below the frontmatter, the body.
    await page.locator(".cm-line", { hasText: "Look it over" }).click();
    await litIs(page, "body");
  } finally {
    await page.close();
  }
}, 60_000);

test.skipIf(!usable)("a write that is not an action is refused, and says why", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await editReview(page);
    await fillEditor(page.locator(".md-editor"), "no frontmatter at all");
    await page.getByRole("button", { name: "Save" }).click();

    // Still in the editor — a refused write is nothing but the notice and the text to fix.
    await page.waitForSelector(".actions-page.editing");
    expect((await page.locator(".actions-page header .summary").textContent()) ?? "").toContain(
      "frontmatter",
    );
  } finally {
    await page.close();
  }
}, 60_000);

/** What the save-guard tests type in: a valid document that is not the file's. Plain lines
 * only (Enter continues a list — the editor's business, not the guard's). */
const guarded = [
  "---",
  "label: Guarded",
  "kind: prompt",
  "target: active",
  "---",
  "Hold these edits.",
  "",
].join("\n");

/** The text the file holds right now. */
const onDisk = async (): Promise<string | undefined> => {
  const response = await fetch(`${url}/api/actions/files`);
  const listing = (await response.json()) as { files: { id: string; scope: string; text: string }[] };
  return listing.files.find((f) => f.id === "look-over" && f.scope === "global")?.text;
};

test.skipIf(!usable)("leaving the editor with unsaved edits asks first", async () => {
  // The draft is the editor's until Save, so leaving would take it with it — unless the
  // question is answered first, the same three answers the settings page asks for. The prompt
  // names what is at stake (the file being edited); Stay keeps the edit, Discard leaves it
  // behind, Save and leave writes it on the way out.
  const before = await onDisk();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    const prompt = page.locator("dialog", { hasText: "Unsaved changes to look-over.md" });
    await editReview(page);
    await fillEditor(page.locator(".md-editor"), guarded);

    // Stay: asked, and nothing else happens.
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await prompt.waitFor();
    expect(new URL(page.url()).pathname).toBe("/actions");
    await page.getByRole("button", { name: "Stay", exact: true }).click();
    await prompt.waitFor({ state: "detached" });
    expect(new URL(page.url()).pathname).toBe("/actions");
    expect(await editorText(page.locator(".md-editor"))).toBe(guarded);

    // Discard and leave: the overview shows, and the file never saw the edit.
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await prompt.waitFor();
    await page.getByRole("button", { name: "Discard and leave", exact: true }).click();
    await page.waitForFunction(() => location.pathname === "/");
    expect(await onDisk()).toBe(before);

    // Save and leave: the same question, and the edit is written on the way out.
    await editReview(page);
    await fillEditor(page.locator(".md-editor"), guarded);
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await prompt.waitFor();
    await page.getByRole("button", { name: "Save and leave", exact: true }).click();
    await page.waitForFunction(() => location.pathname === "/");
    expect(await onDisk()).toBe(guarded);
  } finally {
    await page.close();
  }
}, 60_000);

test.skipIf(!usable)("an editor with nothing unsaved leaves without a question", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await editReview(page);
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await page.waitForFunction(() => location.pathname === "/");
    expect(await page.locator("dialog").count()).toBe(0);
  } finally {
    await page.close();
  }
}, 60_000);

test.skipIf(!usable)("a save the server refuses keeps you there with the draft", async () => {
  // Save and leave runs the page's own save, so its failure is the page's own: the dialog
  // closes, the notice explains, and the draft is still there to fix or to leave.
  const before = await onDisk();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await editReview(page);
    await fillEditor(page.locator(".md-editor"), "no frontmatter at all");
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    const prompt = page.locator("dialog", { hasText: "Unsaved changes to look-over.md" });
    await prompt.waitFor();
    await page.getByRole("button", { name: "Save and leave", exact: true }).click();
    await prompt.waitFor({ state: "detached" });
    expect(new URL(page.url()).pathname).toBe("/actions");
    expect(await editorText(page.locator(".md-editor"))).toBe("no frontmatter at all");
    expect((await page.locator(".actions-page header .summary").textContent()) ?? "").toContain(
      "frontmatter",
    );
    expect(await onDisk()).toBe(before);
  } finally {
    await page.close();
  }
}, 60_000);

test.skipIf(!usable)("Save writes the file at once and returns to the list", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await editReview(page);
    await fillEditor(page.locator(".md-editor"), typed);
    await page.getByRole("button", { name: "Save" }).click();

    // Back on the list — the row that edit started from is there again.
    await page.waitForSelector(".actions-page:not(.editing)");
    await page.locator(".widget p", { hasText: "look-over.md" }).waitFor();
    const response = await fetch(`${url}/api/actions/files`);
    const listing = (await response.json()) as {
      files: { id: string; scope: string; text: string }[];
    };
    expect(listing.files.find((f) => f.id === "look-over" && f.scope === "global")?.text).toBe(typed);
  } finally {
    await page.close();
  }
}, 60_000);
