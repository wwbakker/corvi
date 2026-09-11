import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webkit, type Browser } from "playwright";
import { runSh } from "./helpers.ts";

/**
 * Every page, in the engine the app actually uses.
 *
 * The macOS app is a WKWebView, which is Safari's engine, and the development server is looked at
 * in Chrome. That gap is where WebKit reports what Chrome tolerates: a missing route comes back as
 * HTML and WebKit calls it "The string did not match the expected pattern", and `confirm()` —
 * which a WKWebView does not implement unless the app does — silently returns false, so cancelling
 * a change quietly does nothing. Loading the pages here catches both.
 *
 * This is a smoke test, deliberately: it opens every route, fails on anything the engine
 * complains about, and checks that the page rendered rather than crashed. What each page *does*
 * is tested elsewhere, without a browser.
 */
// Skipped rather than failed where the engine has not been downloaded: `bunx playwright install
// webkit` is a 100MB step, and the rest of the suite needs none of it.
const usable = await (async (): Promise<boolean> => {
  try {
    return await Bun.file(webkit.executablePath()).exists();
  } catch {
    return false;
  }
})();

let tmp: string;
let browser: Browser;
let port: number;
let server: ReturnType<typeof Bun.spawn>;
const id = "PROJ-WEBKIT";

beforeAll(async () => {
  if (!usable) return;
  tmp = await mkdtemp(join(tmpdir(), "iwe-webkit-"));
  port = 4500 + Math.floor(Math.random() * 200);
  const repo = join(tmp, "example-api");
  await runSh(["git", "init", "-b", "main", repo]);
  await Bun.write(join(repo, "README.md"), "example-api\n");
  await runSh(["git", "add", "."], repo);
  await runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], repo);

  server = Bun.spawn(["bun", "src/server.ts", "--iwe-test-run"], {
    env: {
      ...process.env,
      IWE_ROOT: join(tmp, "changes"),
      IWE_REPOS_ROOT: tmp,
      IWE_PORT: String(port),
      // A config file of its own: the settings page reads and writes a real one, and it must not
      // be yours.
      IWE_CONFIG: join(tmp, "config.json"),
    },
    stdout: "ignore",
    stderr: process.env.IWE_TEST_LOUD ? "inherit" : "ignore",
  });
  for (let i = 0; i < 60; i++) {
    if ((await fetch(`http://127.0.0.1:${port}/api/changes`).catch(() => null))?.ok) break;
    await Bun.sleep(100);
  }
  await fetch(`http://127.0.0.1:${port}/api/changes`, {
    method: "POST",
    body: JSON.stringify({ id, branch: `${id}-x`, repos: [repo] }),
  });
  browser = await webkit.launch();
});

afterAll(async () => {
  if (!usable) return;
  await browser?.close();
  server?.kill();
  await rm(tmp, { recursive: true, force: true });
});

/** Open a page and hand back whatever the engine objected to. */
async function open(path: string, ready: string): Promise<string[]> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const complaints: string[] = [];
  page.on("pageerror", (e) => complaints.push(`${path}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && complaints.push(`${path}: ${m.text()}`));
  // Not networkidle: the pages poll, so there is no idle moment to wait for.
  await page.goto(`http://127.0.0.1:${port}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(ready, { timeout: 15_000 });
  await page.waitForTimeout(500); // long enough for the first round of requests to come back
  await page.close();
  return complaints;
}

test.skipIf(!usable)("every page renders in WebKit without the engine complaining", async () => {
  const pages: [string, string][] = [
    ["/", ".change-cards"],
    ["/new", ".wizard"],
    ["/deployments", ".page"],
    ["/settings", ".tabs"],
    [`/changes/${id}`, ".widget"],
    [`/changes/${id}/review`, ".local-pane, .page"],
  ];

  const complaints: string[] = [];
  for (const [path, ready] of pages) complaints.push(...(await open(path, ready)));
  expect(complaints).toEqual([]);
}, 120_000);

test.skipIf(!usable)("the settings page reads and writes in WebKit", async () => {
  // The page whose failure mode is a sentence about nothing: /api/settings answering with the
  // app's own HTML, parsed as JSON.
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/settings`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("nav.tabs");
  expect(await page.locator(".error-banner").count()).toBe(0);

  // One section at a time: the page opens on the first tab, and the Jira field is not there
  // until its tab is chosen.
  expect((await page.locator(".tabs .tab.current").innerText()).trim()).toBe("Locations");
  expect(await page.getByLabel("Transition on completing one").count()).toBe(0);

  // The extension's settings are on its own tab now, so the page has to be asked for it.
  await page.locator(".tabs .tab", { hasText: "Jira" }).click();
  await page.getByLabel("Transition on completing one").fill("Ready for release");
  await page.getByRole("button", { name: "Save" }).click();
  await page.waitForSelector(".hint.saved", { timeout: 10_000 });
  await page.close();

  const written = (await fetch(`http://127.0.0.1:${port}/api/settings`).then((r) => r.json())) as {
    file: { extensionSettings?: { jira?: { doneTransition?: string } } };
  };
  // The Jira fields are the extension's own now, stored under its name rather than as
  // top-level config keys (src/core/host/index.ts migrates top-level keys on load).
  expect(written.file.extensionSettings?.jira?.doneTransition).toBe("Ready for release");
}, 60_000);

test.skipIf(!usable)("the unsaved marker does not resize the notes card in WebKit", async () => {
  // The marker sits in the heading's flex line and comes and goes as you type, so any size or
  // margin it contributes changes the height of the heading — and the whole card — on every
  // keystroke. It must be smaller than the title and take no space of its own.
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/changes/${id}`, { waitUntil: "domcontentloaded" });
  const card = page.locator(".widget:has(textarea.notes)");
  await card.waitFor();
  const heading = card.locator("h3");
  const height = (): Promise<number> =>
    heading.evaluate((h) => h.getBoundingClientRect().height);
  const cardHeight = (): Promise<number> =>
    card.evaluate((section) => section.getBoundingClientRect().height);

  const before = { heading: await height(), card: await cardHeight() };
  await card.locator("textarea.notes").fill("a note");
  await card.locator("h3 .summary", { hasText: "unsaved" }).waitFor();

  expect(await height()).toBe(before.heading);
  expect(await cardHeight()).toBe(before.card);
  const sizes = await heading.evaluate((h) => ({
    title: parseFloat(getComputedStyle(h).fontSize),
    marker: parseFloat(getComputedStyle(h.querySelector(".summary")!).fontSize),
  }));
  expect(sizes.marker).toBeLessThan(sizes.title);
  await page.close();
}, 30_000);

test.skipIf(!usable)("Home and End move to the line's edges in the notes", async () => {
  // WebKit gives Home and End the whole note's edges, unlike the line semantics macOS text
  // views — and Cmd-Left / Cmd-Right — use. A long note is the wrong place to learn that.
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/changes/${id}`, { waitUntil: "domcontentloaded" });
  const notes = page.locator("textarea.notes");
  await notes.waitFor();
  await notes.fill("first line\nsecond line\nthird");
  await page.evaluate(() => {
    (document.querySelector("textarea.notes") as HTMLTextAreaElement).setSelectionRange(15, 15);
  });

  // The caret is in "second line": Home to its start (after the first newline), End past it.
  await page.keyboard.press("Home");
  expect(await notes.evaluate((el) => (el as HTMLTextAreaElement).selectionStart)).toBe(11);
  await page.keyboard.press("End");
  expect(await notes.evaluate((el) => (el as HTMLTextAreaElement).selectionStart)).toBe(22);
  await page.close();
}, 30_000);

