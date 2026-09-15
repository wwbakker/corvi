import { test, expect, beforeAll, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit, type Browser } from "playwright";
import { runSh, serverEnv, testRun, testTempDir, waitForUrl } from "./helpers.ts";
import { TITLE_BAR_HEIGHT, TRAFFIC_LIGHTS } from "../src/domain/chrome.ts";

/**
 * Every page, in the engine the app renders in.
 *
 * The app's window is Electron, and Electron is Chromium, so Chromium is the default here — it
 * is also the engine `bun run shot` drives, and the one every browser check in this repository
 * agrees on. `IWE_ENGINE=webkit` runs the same file in WebKit where Playwright's bundle starts
 * (on macOS natively; on Linux only where its Ubuntu-built libraries match), which is the
 * browser-side check for Safari. Skipped rather than failed where the chosen engine cannot
 * launch: a red suite for a missing browser says nothing about IWE.
 *
 * This is a smoke test with three teeth: it opens every route and fails on anything the engine
 * complains about; it round-trips the settings page through the real file; and it pins the
 * notes card's layout while its unsaved marker comes and goes. What each page *does* is tested
 * elsewhere, without a browser.
 */
let browser: Browser;
const engineName = process.env.IWE_ENGINE === "webkit" ? "webkit" : "chromium";
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
const id = "PROJ-PAGES";

beforeAll(async () => {
  if (!usable) return;
  tmp = await testTempDir("pages");
  const repo = join(tmp, "example-api");
  await runSh(["git", "init", "-b", "main", repo]);
  await Bun.write(join(repo, "README.md"), "example-api\n");
  await runSh(["git", "add", "."], repo);
  await runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], repo);

  // serverEnv gives the file its own changes, config, page build, cache and tmux socket, and
  // port 0: the OS picks a free one, so parallel workers never collide. Readiness is the
  // server's own `iwe on <url>` line.
  server = Bun.spawn(["node", "src/server.ts", `--iwe-test-run=${testRun()}`], {
    env: serverEnv(tmp, { IWE_REPOS_ROOT: tmp }),
    stdout: "pipe",
    stderr: process.env.IWE_TEST_LOUD ? "inherit" : "ignore",
  });
  url = await waitForUrl(server);
  await fetch(`${url}/api/changes`, {
    method: "POST",
    body: JSON.stringify({ id, branch: `${id}-x`, repos: [repo] }),
  });
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
  await page.goto(`${url}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(ready, { timeout: 15_000 });
  await page.waitForTimeout(500); // long enough for the first round of requests to come back
  await page.close();
  return complaints;
}

test.skipIf(!usable)("every page renders without the engine complaining", async () => {
  const pages: [string, string][] = [
    ["/", ".change-card"],
    ["/new", ".wizard"],
    ["/azure-devops", ".page"],
    ["/settings", ".tabs"],
    [`/changes/${id}`, ".widget"],
    [`/changes/${id}/review`, ".local"],
  ];

  const complaints: string[] = [];
  for (const [path, ready] of pages) complaints.push(...(await open(path, ready)));
  expect(complaints).toEqual([]);
}, 120_000);

test.skipIf(!usable)("the settings page reads and writes", async () => {
  // The page whose failure mode is a sentence about nothing: /api/settings answering with the
  // app's own HTML, parsed as JSON.
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${url}/settings`, { waitUntil: "domcontentloaded" });
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

  const written = (await fetch(`${url}/api/settings`).then((r) => r.json())) as {
    file: { extensionSettings?: { jira?: { doneTransition?: string } } };
  };
  // The Jira fields are the extension's own now, stored under its name rather than as
  // top-level config keys (src/extension-host/index.ts migrates top-level keys on load).
  expect(written.file.extensionSettings?.jira?.doneTransition).toBe("Ready for release");
}, 60_000);

test.skipIf(!usable)("the unsaved marker does not resize the notes card", async () => {
  // The marker sits in the heading's flex line and comes and goes as you type, so any size or
  // margin it contributes changes the height of the heading — and the whole card — on every
  // keystroke. It must be smaller than the title and take no space of its own.
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${url}/changes/${id}`, { waitUntil: "domcontentloaded" });
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
test.skipIf(!usable)("the documents sit left of the status cards", async () => {
  // The dashboard's two regions: the change's documents (the plan, notes) on the left, the
  // status cards on the right. At this width both are present, so the grid has two columns and
  // the status region starts where the documents end.
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${url}/changes/${id}`, { waitUntil: "domcontentloaded" });
  const documents = page.locator(".column.documents");
  await documents.locator("textarea.plan").waitFor();
  await documents.locator("textarea.notes").waitFor();
  const status = page.locator(".column.status");
  await status.locator(".widget").first().waitFor();
  expect(await status.locator(".widget").count()).toBeGreaterThan(0);

  const docBox = await documents.boundingBox();
  const statusBox = await status.boundingBox();
  if (!docBox || !statusBox) throw new Error("the dashboard's columns did not lay out");
  expect(statusBox.x).toBeGreaterThanOrEqual(docBox.x + docBox.width);
  await page.close();
}, 30_000);

test.skipIf(!usable)("the change's own row is the page's first, and it stays there", async () => {
  // The terminals are the window's title bar in the app, which is the page's first row whether or not
  // a host is there (docs/decisions/window-titlebar.md): full-bleed, and one height everywhere so it
  // lines up with the column beside it. The change's own name is not in it — the column's entry says
  // it, and so does the window's title.
  await fetch(`${url}/api/changes/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ title: "Anonymise customer names" }),
  });
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  await page.goto(`${url}/changes/${id}`, { waitUntil: "domcontentloaded" });
  const strip = page.locator(".change-bar");
  await strip.locator(".window-tab.overview").waitFor();

  expect(await strip.locator(".subject").count()).toBe(0);
  // The name went to the window's title (src/app-root/app.tsx), which the OS window switcher reads:
  // it arrives with the change's record rather than with the page, so it is waited for.
  await page.waitForFunction(() => document.title === "Anonymise customer names");
  expect(await page.title()).toBe("Anonymise customer names");
  // The terminals are tabs in that same row, not a row of their own.
  expect(await strip.locator(".window-tab.overview").count()).toBe(1);

  // Edge to edge: the row is as wide as the column it is in, because the page's padding is given
  // back on it.
  const stripBox = await strip.boundingBox();
  const columnBox = await page.locator(".content").boundingBox();
  if (!stripBox || !columnBox) throw new Error("the change's row did not lay out");
  expect(Math.abs(stripBox.width - columnBox.width)).toBeLessThanOrEqual(1);
  expect(Math.round(stripBox.height)).toBe(TITLE_BAR_HEIGHT);

  // The change's own row — its views, its state and its actions — is the one under it.
  const tabsRow = page.locator(".change-tabs");
  await tabsRow.locator("select").waitFor();
  expect(await tabsRow.locator(".tab").count()).toBeGreaterThan(0);

  // Both stay put while the page scrolls: they are the window's chrome, not part of what you read.
  await page.evaluate(() => window.scrollTo(0, 400));
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  const [stoppedStrip, stoppedTabs] = await Promise.all([
    strip.boundingBox(),
    tabsRow.boundingBox(),
  ]);
  expect(stoppedStrip!.y).toBe(0);
  expect(Math.abs(stoppedTabs!.y - TITLE_BAR_HEIGHT)).toBeLessThanOrEqual(1);

  // The navigation column: one line per change, its name, and no id of its own. The branch — the id
  // with a slug after it — is the entry's tooltip.
  await page.locator(".sidebar .entry.change .subject").waitFor();
  expect(await page.locator(".sidebar .entry.change .id").count()).toBe(0);
  expect((await page.locator(".sidebar .entry.change .subject").innerText()).trim()).toBe(
    "Anonymise customer names",
  );
  expect(await page.locator(".sidebar .entry.change").first().getAttribute("title")).toContain(id);

  await page.close();
}, 30_000);

test.skipIf(!usable)("in the app window the row is also the window's chrome", async () => {
  // The host bridge is what says the page is inside the app window (src/domain/host.ts), and only
  // then is the first row chrome as well: what you drag the window by, and clear of the traffic
  // lights the main process placed in it (docs/decisions/window-titlebar.md). Injected rather than
  // driven through Electron, because the page's half of the contract is what is being checked — the
  // lights' pixels are the main process's, and only a real window has those.
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(() => {
    (window as unknown as { iweHost?: unknown }).iweHost = {
      platform: "darwin",
      notify: () => {},
      onOpenWindow: () => {},
    };
  });
  await page.goto(`${url}/changes/${id}`, { waitUntil: "domcontentloaded" });
  const strip = page.locator(".change-bar");
  await strip.locator(".window-tab.overview").waitFor();
  const region = (sel: string): Promise<string> =>
    page
      .locator(sel)
      .first()
      .evaluate((el) => getComputedStyle(el).getPropertyValue("-webkit-app-region"))
      .then((value) => value.trim());

  expect(await region(".change-bar")).toBe("drag");
  // The row is the window's and nothing else is in it: no name to click, and the terminals' tabs are
  // controls — their own drag reorders them. Renaming is an action in the menu in the row below,
  // which is not part of the drag region at all (docs/decisions/window-titlebar.md).
  expect(await strip.locator(".subject").count()).toBe(0);
  expect(await region(".change-bar .window-tab")).toBe("no-drag");

  // The switcher is a compact pill at the column's right edge: about half the width the heading took,
  // and clear of the lights by being on the far side of the column from them.
  const switcher = page.locator(".sidebar button.workspace");
  const switcherBox = await switcher.boundingBox();
  const sidebar = await page.locator(".sidebar").boundingBox();
  if (!switcherBox || !sidebar) throw new Error("the sidebar did not lay out");
  expect(sidebar.x + sidebar.width - (switcherBox.x + switcherBox.width)).toBeLessThanOrEqual(12);
  expect(switcherBox.width).toBeLessThan(sidebar.width / 2);
  expect(switcherBox.x).toBeGreaterThanOrEqual(TRAFFIC_LIGHTS.inset);
  expect(sidebar.width).toBeGreaterThanOrEqual(TRAFFIC_LIGHTS.inset + 160);
  expect(await region(".sidebar > .band")).toBe("drag");

  // The column's line begins below that row rather than beside it: the band and the column are one
  // surface, and a line between them would draw the seam the palette is there to avoid. It is drawn
  // (a pseudo-element) rather than a border, because a border cannot start partway down its edge.
  const column = page.locator(".sidebar");
  expect(await column.evaluate((el) => getComputedStyle(el).borderRightWidth)).toBe("0px");
  expect(await column.evaluate((el) => getComputedStyle(el, "::after").top)).toBe(
    `${TITLE_BAR_HEIGHT}px`,
  );
  expect(
    await column.evaluate((el) => getComputedStyle(el, "::after").backgroundColor),
  ).not.toBe("rgba(0, 0, 0, 0)");

  // The switcher's list opens inside the window rather than past its edge, and the click reaches the
  // control at all: the row it sits in is the region you drag the window by.
  await switcher.click();
  const menu = await page.locator(".menu-items").boundingBox();
  if (!menu) throw new Error("the workspace menu did not open");
  const viewport = await page.evaluate(() => window.innerWidth);
  expect(menu.x).toBeGreaterThanOrEqual(0);
  expect(menu.x + menu.width).toBeLessThanOrEqual(viewport);
  await page.close();
}, 30_000);
test.skipIf(!usable)("the name is renamed from the actions menu", async () => {
  // Renaming is an action in the change's own row (docs/decisions/window-titlebar.md): the menu's
  // Rename change opens a field beside the state and the actions, and what it is given is what the
  // column's entry and the window's title say afterwards.
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${url}/changes/${id}`, { waitUntil: "domcontentloaded" });
  await page.locator(".change-bar .window-tab.overview").waitFor();

  await page.locator(".change-tabs button", { hasText: "Actions" }).click();
  await page.getByRole("button", { name: "Rename change" }).click();
  const input = page.locator(".change-tabs input.subject");
  await input.waitFor();
  await input.fill("A name of my own");
  await input.press("Enter");

  await page
    .locator(".sidebar .entry.change .subject", { hasText: "A name of my own" })
    .waitFor();
  expect(await page.title()).toBe("A name of my own");
  await page.close();
}, 30_000);

test.skipIf(!usable)("New starts an idea from the column or the overview", async () => {
  // One control in two places: the overview's header has it, and so does the column beside the
  // Changes entry — from there it is one click from anywhere in the app. Both say the same word and
  // open the same wizard.
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".change-card");

  expect((await page.locator(".page > header .create").innerText()).trim()).toBe("New");
  expect((await page.locator(".sidebar .changes-row .create").innerText()).trim()).toBe("New");

  await page.locator(".sidebar .changes-row .create").click();
  await page.waitForSelector(".wizard");
  expect(new URL(page.url()).pathname).toBe("/new");
  await page.close();
}, 30_000);
