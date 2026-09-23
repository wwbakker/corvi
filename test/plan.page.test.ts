import { test, expect, beforeAll, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit, type Browser, type Page } from "playwright";
import { closePages, serverEnv, testRun, testTempDir, waitForUrl } from "./helpers.ts";
import { editorText } from "./editor.ts";

/**
 * The plan tab and the wizard's description, through the page: `PLAN.md` as Markdown source in
 * the shared editor. The editor must show every character of the markup — colored, monospace —
 * keep its highlighting while typing, save through the existing debounce, and hold a finished
 * change's plan read-only. The tab rules are pinned in web.test.ts and the meaning of the colors
 * in markdownTheme.test.ts; this is the product surface.
 *
 * The change is created through the API as the wizard would, and finished the way a user
 * finishes an early change: cancelled, which turns the plan into a record. If no browser is
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

let tmp: string;
let url: string;
let server: ReturnType<typeof Bun.spawn>;

/** The plan the change is created with: something every colored role touches, fenced code
 * included. */
const source = [
  "# The plan",
  "",
  "**bold** and *italic* and ~~struck~~ and `code` and [link](https://example.test)",
  "",
  "> quoted",
  "",
  "- one",
  "- two",
  "",
  "```json",
  '{ "id": "improve-plan-view", "state": "Ideation" }',
  "```",
  "",
  "```python",
  "def plan():",
  "    return True  # shaped as we go",
  "```",
  "",
  "```scala",
  "object Plan extends App { println(1) }",
  "```",
  "",
].join("\n");

/** What the plan reads after the typing test below appends to it. */
const typed = "typed **more**";

beforeAll(async () => {
  tmp = await testTempDir("plan-page");
  server = Bun.spawn(["node", "apps/server/src/server.ts", `--corvi-test-run=${testRun()}`], {
    env: serverEnv(tmp),
    stdout: "pipe",
    stderr: process.env.CORVI_TEST_LOUD ? "inherit" : "ignore",
  });
  url = await waitForUrl(server);
  // The idea with its plan, as the wizard's "Create idea" would write it.
  const created = await fetch(`${url}/api/changes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "PROJ-1", title: "A plan", state: "Ideation", plan: source }),
  });
  expect(created.status).toBe(201);
});

afterAll(async () => {
  // Whatever pages a failed test left open are screenshotted for CI's failure artifacts first.
  await closePages(browser, "plan");
  await browser?.close();
  server?.kill();
  await rm(tmp, { recursive: true, force: true });
});

/** Wait for the editor to hold the document: CodeMirror draws the placeholder while it is
 * still empty. Resolves at once when the content was already there. */
const loaded = (page: Page): Promise<unknown> =>
  page.waitForSelector(".md-editor .cm-placeholder", { state: "detached" });

/** What the plan route serves: the file the agent reads. */
const onDisk = async (): Promise<string> => {
  const response = await fetch(`${url}/api/changes/PROJ-1/plan`);
  return ((await response.json()) as { text: string }).text;
};

/** Every syntax span's text with the computed style the tokens below assert on. Adjacent
 * ranges wearing exactly the same style merge into one span (the quote's space and word), so a
 * token is found by its trimmed text and asserted by its style. */
type Painted = {
  text: string;
  color: string;
  weight: string;
  style: string;
  decoration: string;
};

const painted = (page: Page): Promise<Painted[]> =>
  page.locator(".md-editor .cm-line span").evaluateAll((nodes) =>
    nodes.map((n) => {
      const s = getComputedStyle(n);
      return {
        text: n.textContent ?? "",
        color: s.color,
        weight: s.fontWeight,
        style: s.fontStyle,
        decoration: s.textDecorationLine,
      };
    }),
  );

const heading = "rgb(108, 182, 255)"; // --md-heading
const code = "rgb(126, 231, 135)"; // --md-code
const link = "rgb(163, 113, 247)"; // --md-link
const quote = "rgb(139, 147, 161)"; // --md-quote
const mark = "rgb(86, 95, 108)"; // --md-mark

test.skipIf(!usable)(
  "the plan tab shows the markup as source: every character visible, colored like an editor",
  async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.goto(`${url}/changes/PROJ-1/plan`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".md-editor .cm-line");
      await loaded(page);

      // The editor is the tab's content, exactly: it reaches the window's edges the terminal
      // reaches — no padding around it. (Briefing the agent is the terminal page's action menu
      // now, so there is no floating button over the corner.)
      const frame = await page.locator(".plan-page .md-editor").boundingBox();
      if (!frame) throw new Error("the plan editor did not lay out");
      expect(Math.abs(frame.x + frame.width - 1280)).toBeLessThan(5);
      expect(Math.abs(frame.y + frame.height - 900)).toBeLessThan(5);
      // The two tab rows are one block of chrome on this tab too: nothing between them.
      const bar = await page.locator(".change-bar").boundingBox();
      const tabs = await page.locator(".change-tabs").boundingBox();
      if (!bar || !tabs) throw new Error("the change's tab rows did not lay out");
      expect(Math.abs(bar.y + bar.height - tabs.y)).toBeLessThan(2);

      // Every character visible: what the editor shows is the file, markup and all.
      expect(await editorText(page.locator(".md-editor"))).toBe(source);
      expect(await onDisk()).toBe(source);

      // Colored like an editor colors it: structure in color, emphasis in weight/slant/strike,
      // the marks dim. The exact values are the tokens' (markdownTheme.test.ts); this pins that
      // they survive to the DOM.
      const spans = await painted(page);
      const look = (text: string): Omit<Painted, "text"> | undefined => {
        const found = spans.find((s) => s.text.trim() === text);
        return found && { color: found.color, weight: found.weight, style: found.style, decoration: found.decoration };
      };
      expect(look("#")).toEqual({ color: mark, weight: "400", style: "normal", decoration: "none" });
      expect(look("The plan")).toEqual({ color: heading, weight: "700", style: "normal", decoration: "none" });
      expect(look("bold")).toEqual({ color: "rgb(223, 227, 234)", weight: "700", style: "normal", decoration: "none" });
      expect(look("italic")).toEqual({ color: "rgb(223, 227, 234)", weight: "400", style: "italic", decoration: "none" });
      expect(look("struck")).toEqual({ color: "rgb(223, 227, 234)", weight: "400", style: "normal", decoration: "line-through" });
      expect(look("code")).toEqual({ color: code, weight: "400", style: "normal", decoration: "none" });
      expect(look("link")).toEqual({ color: link, weight: "400", style: "normal", decoration: "none" });
      expect(look("https://example.test")).toEqual({ color: link, weight: "400", style: "normal", decoration: "none" });
      expect(look(">")).toEqual({ color: mark, weight: "400", style: "normal", decoration: "none" });
      expect(look("quoted")).toEqual({ color: quote, weight: "400", style: "italic", decoration: "none" });
      expect(look("-")).toEqual({ color: mark, weight: "400", style: "normal", decoration: "none" });
      // In a fence whose language the editor knows, the grammar colors the code through the same
      // roles: a key in the keyword blue, a literal purple, the punctuation around them dim —
      // `brace` and `separator` reach `punctuation` through their parents.
      expect(look('"id"')).toEqual({ color: heading, weight: "400", style: "normal", decoration: "none" });
      expect(look('"improve-plan-view"')).toEqual({ color: link, weight: "400", style: "normal", decoration: "none" });
      expect(look("{")).toEqual({ color: mark, weight: "400", style: "normal", decoration: "none" });
      expect(look("}")).toEqual({ color: mark, weight: "400", style: "normal", decoration: "none" });
      // The other curated languages reach the same roles — a Lezer grammar (Python) and a legacy
      // stream parser (Scala) alike: keywords wear the keyword blue, comments the quote grey.
      expect(look("def")).toEqual({ color: heading, weight: "400", style: "normal", decoration: "none" });
      expect(look("object")).toEqual({ color: heading, weight: "400", style: "normal", decoration: "none" });
      expect(look("# shaped as we go")).toEqual({ color: quote, weight: "400", style: "italic", decoration: "none" });
    } finally {
      await page.close();
    }
  },
  60_000,
);

test.skipIf(!usable)("typing keeps the highlighting and saves through the debounce", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(`${url}/changes/PROJ-1/plan`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".md-editor .cm-line");
    await loaded(page);

    // Type on the document's empty last line (the plan ends in a newline).
    await page.locator(".md-editor .cm-line").last().click();
    const saved = page.waitForResponse(
      (r) => r.request().method() === "PUT" && r.url().endsWith("/plan"),
    );
    await page.keyboard.type(typed);
    await saved;

    // The new markup is highlighted as it is typed, and what was saved is what is shown.
    const spans = await painted(page);
    expect(spans.find((s) => s.text === "more")?.weight).toBe("700");
    expect(await editorText(page.locator(".md-editor"))).toBe(source + typed);
    expect(await onDisk()).toBe(source + typed);
  } finally {
    await page.close();
  }
}, 60_000);

test.skipIf(!usable)("the editor's affordances are there: a section folds and Ctrl-F finds", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(`${url}/changes/PROJ-1/plan`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".md-editor .cm-line");
    await loaded(page);

    // A heading folds its section at the gutter's mark — the fold ranges are the Markdown
    // grammar's own — and unfolds again. The mark is the gutter's span on foldable lines; the
    // gutter's hidden width-measuring spacer carries copies of every mark, so visible ones.
    await page.locator('.cm-foldGutter span[title="Fold line"]:visible').first().click();
    await page.locator(".cm-foldPlaceholder").first().waitFor();
    await page.locator('.cm-foldGutter span[title="Unfold line"]:visible').first().click();
    await page.waitForSelector(".cm-foldPlaceholder", { state: "detached" });

    // Find opens the search panel and finds the plan's own words. The shortcut needs the
    // editor's focus — the fold marks live outside its keymap.
    await page.locator(".md-editor .cm-content").click();
    await page.keyboard.press("ControlOrMeta+f");
    const panel = page.locator(".cm-panel");
    await panel.waitFor();
    // The panel commits on keystrokes (its field listens for keyup), so type the query.
    await panel.locator("input").first().pressSequentially("quoted");
    await page.locator(".cm-searchMatch").first().waitFor();
    await page.keyboard.press("Escape");
    await page.waitForSelector(".cm-panel", { state: "detached" });
  } finally {
    await page.close();
  }
}, 60_000);

test.skipIf(!usable)("a finished change's plan is a read-only record", async () => {
  // Finished the way an early change is: abandoned. No checkouts, so nothing goes but the idea.
  const cancelled = await fetch(`${url}/api/changes/PROJ-1/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ force: true }),
  });
  expect(cancelled.status).toBe(200);

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(`${url}/changes/PROJ-1/plan`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".md-editor .cm-line");
    await loaded(page);

    // The record is readable and uneditable: the markup is still all there.
    expect(await page.locator(".md-editor .cm-content").getAttribute("contenteditable")).toBe(
      "false",
    );
    expect(await editorText(page.locator(".md-editor"))).toBe(source + typed);
  } finally {
    await page.close();
  }
}, 60_000);

test.skipIf(!usable)("the wizard's description is the same editor", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(`${url}/new`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("nav.steps");
    // The details step is the wizard's own "Idea" step, wherever the extensions put it.
    await page.locator("nav.steps button.step", { hasText: "Idea" }).first().click();
    await page.waitForSelector(".form .md-editor .cm-line");

    await page.locator(".form .md-editor .cm-content").click();
    await page.keyboard.type("# Starting **plan**");

    expect(await editorText(page.locator(".form .md-editor"))).toBe("# Starting **plan**");
    const spans = await painted(page);
    expect(spans.find((s) => s.text === "#")?.color).toBe(mark);
    expect(spans.find((s) => s.text === "plan")?.weight).toBe("700");

    // A bracket closes itself, and typing its end replaces the offered one.
    await page.keyboard.type(" (parens)");
    expect(await editorText(page.locator(".form .md-editor"))).toBe("# Starting **plan** (parens)");
  } finally {
    await page.close();
  }
}, 60_000);
