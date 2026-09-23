import { test, expect, beforeAll, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit, type Browser } from "playwright";
import { checkoutsOf, runSh, serverEnv, testRun, testTempDir, waitForUrl  } from "./helpers.ts";
import { TITLE_BAR_HEIGHT, TRAFFIC_LIGHTS } from "@corvi/web/chrome";

/**
 * Every page, in the engine the app renders in.
 *
 * The app's window is Electron, and Electron is Chromium, so Chromium is the default here — it
 * is also the engine `bun run shot` drives, and the one every browser check in this repository
 * agrees on. `CORVI_ENGINE=webkit` runs the same file in WebKit where Playwright's bundle starts
 * (on macOS natively; on Linux only where its Ubuntu-built libraries match), which is the
 * browser-side check for Safari. Skipped rather than failed where the chosen engine cannot
 * launch: a red suite for a missing browser says nothing about Corvi.
 *
 * This is a smoke test with three teeth: it opens every route and fails on anything the engine
 * complains about; it round-trips the settings page through the real file; and it pins the
 * notes card's layout while its unsaved marker comes and goes. What each page *does* is tested
 * elsewhere, without a browser.
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
const id = "PROJ-PAGES";
/** A second change, for the page states that only differ once you leave one: the switch from one
 * change to another is where a widget's state has to follow the change. */
const other = "PROJ-PAGES-2";

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
  // server's own `corvi on <url>` line.
  server = Bun.spawn(["node", "apps/server/src/server.ts", `--corvi-test-run=${testRun()}`], {
    env: serverEnv(tmp, { CORVI_REPOSITORIES_DIRECTORY: tmp }),
    stdout: "pipe",
    stderr: process.env.CORVI_TEST_LOUD ? "inherit" : "ignore",
  });
  url = await waitForUrl(server);
  const first = await fetch(`${url}/api/changes`, {
    method: "POST",
    body: JSON.stringify({ id, branch: `${id}-x`, checkouts: checkoutsOf([repo]) }),
  });
  expect(first.ok).toBe(true);
  const second = await fetch(`${url}/api/changes`, {
    method: "POST",
    body: JSON.stringify({ id: other, branch: `${other}-x`, checkouts: checkoutsOf([repo]) }),
  });
  expect(second.ok).toBe(true);
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

/** Write one change's notes through the extension's own route, the way the card does. */
const writeNotes = (change: string, text: string): Promise<Response> =>
  fetch(`${url}/api/ext/notes/changes/${change}/notes`, {
    method: "PUT",
    body: JSON.stringify({ text }),
  });

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

  // The window's own section, whose one setting so far is the right-click menu: taking it away is
  // the decision that gets written down, since a menu is the default.
  const box = page.getByLabel("Right-click menu");
  await page.locator(".tabs .tab", { hasText: "Window" }).click();
  await box.uncheck();
  await page.getByRole("button", { name: "Save" }).click();
  await page.waitForSelector(".hint.saved", { timeout: 10_000 });
  expect(await box.isChecked()).toBe(false);

  // And putting it back clears the decision, so the default applies again. The box reads the
  // decision or the default — never the effective value, which *is* the file's value, and which
  // made "off" the only state you could reach.
  await box.check();
  expect(await box.isChecked()).toBe(true);
  await page.getByRole("button", { name: "Save" }).click();
  await page.waitForSelector(".hint.saved", { timeout: 10_000 });
  expect(await box.isChecked()).toBe(true);
  await page.close();

  const written = (await fetch(`${url}/api/settings`).then((r) => r.json())) as {
    file: { extensionSettings?: { jira?: { doneTransition?: string } }; contextMenu?: boolean };
    effective: { contextMenu: boolean };
  };
  // The Jira fields are the extension's own now, stored under its name rather than as
  // top-level config keys (apps/server/src/integrations/index.ts migrates top-level keys on load).
  expect(written.file.extensionSettings?.jira?.doneTransition).toBe("Ready for release");
  expect(written.file.contextMenu).toBe(true);
  expect(written.effective.contextMenu).toBe(true);
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

test.skipIf(!usable)("the checkouts card reads the change's repositories through the typed client", async () => {
  // The first browser consumer of the new slice: the card fetches the typed operation, decodes
  // the DTO, and shows the projected state and the branch the worktree actually holds.
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${url}/changes/${id}`, { waitUntil: "domcontentloaded" });
  const card = page.locator('[data-testid="checkouts"]');
  await card.locator(".checkout-row").first().waitFor();
  expect(await card.locator(".checkout-name").first().innerText()).toBe("example-api");
  expect(await card.locator(".checkout-state").first().innerText()).toBe("Active");
  expect(await card.locator(".checkout-detail").first().innerText()).toContain(`${id}-x`);
  await page.close();
}, 30_000);

test.skipIf(!usable)("switching changes shows the new change's notes, not the one just left", async () => {
  // A change's notes are its own: the change you open must show them, not the ones you were
  // typing into the change you left. The read is asynchronous, so this waits for what ends up
  // on screen rather than for a single tick.
  const left = "notes of the change you leave";
  const opened = "notes of the change you open";
  await writeNotes(id, left);
  await writeNotes(other, opened);

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${url}/changes/${id}`, { waitUntil: "domcontentloaded" });
  const notes = page.locator("textarea.notes");
  await notes.waitFor();
  /** The notes card's text, once it is what it should be; the load is asynchronous like every
   * other, so this is the page's own answer after a bounded wait rather than immediately. */
  const notesAre = async (want: string): Promise<string> => {
    let shown = "";
    for (let i = 0; i < 25; i++) {
      shown = await notes.inputValue();
      if (shown === want) break;
      await Bun.sleep(200);
    }
    return shown;
  };
  expect(await notesAre(left)).toBe(left);

  // Type into it, then switch before the debounced save has landed: the in-flight text must not
  // be inherited by the change you open.
  await notes.fill("typed into the change you leave");
  await page.locator(".sidebar .entry.change", { hasText: `${other}-x` }).click();
  await page.waitForFunction((want) => location.pathname === `/changes/${want}`, other);
  expect(await notesAre(opened)).toBe(opened);
  await page.close();
}, 30_000);

test.skipIf(!usable)("a read from the change you left does not land on the one you opened", async () => {
  // The load is asynchronous, so a change's notes can still be on their way when you switch.
  // The card that asked for them is the one that must take the answer: a response from the
  // change you left, arriving after the new change's, would otherwise write its text into the
  // notes you are now looking at — and nothing would read them again until the page remounts.
  await writeNotes(id, "notes of the change you leave");
  await writeNotes(other, "notes of the change you open");

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  // Held back long enough that the switch happens while this read is in flight, which is the
  // race: a slow read, not a wrong one.
  await page.route(
    (url) => url.pathname === `/api/ext/notes/changes/${id}/notes`,
    async (route) => {
      await Bun.sleep(1500);
      await route.continue();
    },
  );
  await page.goto(`${url}/changes/${id}`, { waitUntil: "domcontentloaded" });
  await page.locator("textarea.notes").waitFor();
  await page.locator(".sidebar .entry.change", { hasText: `${other}-x` }).click();
  await page.waitForFunction((want) => location.pathname === `/changes/${want}`, other);

  // The change you opened answered first, and stays: the late answer is for a page that is gone.
  const notes = page.locator("textarea.notes");
  let shown = "";
  for (let i = 0; i < 25; i++) {
    shown = await notes.inputValue();
    if (shown === "notes of the change you open") break;
    await Bun.sleep(200);
  }
  expect(shown).toBe("notes of the change you open");
  await Bun.sleep(2000); // past the held response
  expect(await notes.inputValue()).toBe("notes of the change you open");
  await page.close();
}, 30_000);

test.skipIf(!usable)("the change's own row is the page's first, and it stays there", async () => {
  // The terminals are the window's title bar in the app, which is the page's first row whether or not
  // a host is there (docs/manual/interface.md): full-bleed, and one height everywhere so it
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
  // The name went to the window's title (apps/web/src/app-root/app.tsx), which the OS window switcher reads:
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
  // with a slug after it — is the entry's tooltip. Scoped to this change's own entry, since the
  // column holds every change in the workspace (test/pages.test.ts's second one included).
  const entry = page.locator(".sidebar .entry.change", { hasText: "Anonymise customer names" });
  await entry.locator(".subject").waitFor();
  expect(await entry.locator(".id").count()).toBe(0);
  expect((await entry.locator(".subject").innerText()).trim()).toBe("Anonymise customer names");
  expect(await entry.getAttribute("title")).toContain(id);

  await page.close();
}, 30_000);

test.skipIf(!usable)("in the app window the row is also the window's chrome", async () => {
  // The host bridge is what says the page is inside the app window (apps/web/src/domain/host.ts), and only
  // then is the first row chrome as well: what you drag the window by, and clear of the traffic
  // lights the main process placed in it (docs/manual/interface.md). Injected rather than
  // driven through Electron, because the page's half of the contract is what is being checked — the
  // lights' pixels are the main process's, and only a real window has those.
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  // The bridge's whole contract, or the page is right to complain: a host missing a method makes a
  // React tree that throws on mount, which shows up as a test that waits for a selector forever.
  const complaints: string[] = [];
  page.on("pageerror", (e) => complaints.push(e.message));
  await page.addInitScript(() => {
    (window as unknown as { corviHost?: unknown }).corviHost = {
      platform: "darwin",
      notify: () => {},
      onOpenWindow: () => {},
      setContextMenu: () => {},
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
  // which is not part of the drag region at all (docs/manual/interface.md).
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
  expect(complaints).toEqual([]);
  await page.close();
}, 30_000);
test.skipIf(!usable)("the name is renamed from the actions menu", async () => {
  // Renaming is an action in the change's own row (docs/manual/interface.md): the menu's
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
  // Ideas heading — the entries it adds to. Both say the same word and open the same wizard.
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".change-card");

  expect((await page.locator(".page > header .create").innerText()).trim()).toBe("New");
  expect((await page.locator(".sidebar .ideas-row .create").innerText()).trim()).toBe("New");

  await page.locator(".sidebar .ideas-row .create").click();
  await page.waitForSelector(".wizard");
  expect(new URL(page.url()).pathname).toBe("/new");
  await page.close();
}, 30_000);

test.skipIf(!usable)("a half-filled idea is still there after leaving the wizard", async () => {
  // The promise this change is about: leaving /new loses nothing. The form lives in the App
  // (apps/web/src/wizard/draft.ts), and the column's row under Ideas is the way back to it.
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".change-card");

  await page.locator(".sidebar .ideas-row .create").click();
  await page.waitForSelector(".wizard");
  // The draft row is where "here" is while the wizard is open, not the overview entry.
  expect(await page.locator(".sidebar .entry.change.state-ideation.current").count()).toBe(1);
  expect(await page.locator(".sidebar > button.entry.current").count()).toBe(0);

  await page.locator(".steps button.step", { hasText: "Idea" }).click();
  await page.getByLabel("Title").fill("A half-written idea");
  await page.getByLabel("Description").fill("The first paragraph of the plan.");

  // The row says what the draft is called while it is being typed.
  const row = page.locator(".sidebar .entry.change.state-ideation");
  await page.waitForFunction(
    () =>
      document.querySelector(".sidebar .entry.change.state-ideation .subject")?.textContent ===
      "A half-written idea",
  );

  // Leave for the overview: the draft is no longer the page, and the row is where it waits.
  await page.locator(".sidebar > button.entry", { hasText: "Changes" }).click();
  await page.waitForSelector(".change-card");
  expect(await row.count()).toBe(1);
  expect(await page.locator(".sidebar .entry.change.state-ideation.current").count()).toBe(0);

  // Back through the row: the fields and the step are where they were left.
  await row.click();
  await page.waitForSelector(".wizard .form");
  expect(new URL(page.url()).pathname).toBe("/new");
  expect((await page.locator(".steps button.step.active").innerText()).trim()).toContain("Idea");
  expect(await page.getByLabel("Title").inputValue()).toBe("A half-written idea");
  expect(await page.getByLabel("Description").inputValue()).toBe("The first paragraph of the plan.");

  // The other way in — the New button — opens the same draft, not a second, empty one.
  await page.locator(".sidebar > button.entry", { hasText: "Changes" }).click();
  await page.waitForSelector(".change-card");
  await page.locator(".sidebar .ideas-row .create").click();
  await page.waitForSelector(".wizard .form");
  expect(await page.getByLabel("Title").inputValue()).toBe("A half-written idea");
  expect(await row.count()).toBe(1);

  // Discarding is the one thing that throws it away.
  await page.getByRole("button", { name: "Discard" }).click();
  await page.waitForSelector(".change-card");
  expect(await row.count()).toBe(0);
  await page.close();
}, 30_000);

test.skipIf(!usable)(
  "the repository browser asks where the checkout lives and which branch it uses",
  async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".change-card");

    await page.locator(".sidebar .ideas-row .create").click();
    await page.waitForSelector(".wizard");
    // Straight to the repositories step: the wizard opens wherever the integrations' issue steps
    // end, and this is about the browser, not the idea's fields.
    await page.locator(".steps button.step", { hasText: "Repositories" }).click();
    await page.waitForSelector(".browser");

    // The fixture repository is in the configured start directory, one Add away.
    await page
      .locator(".listing .entries li", { hasText: "example-api" })
      .getByRole("button", { name: "Add", exact: true })
      .click();
    const row = page.locator(".selected-pane li.selection");
    await row.waitFor();

    // The two questions, as the selects say them — and where the row starts: a worktree on the
    // change's own branch.
    const location = row.locator("select").nth(0);
    const branchKind = row.locator("select").nth(1);
    expect(await location.inputValue()).toBe("new");
    expect((await location.locator("option").allInnerTexts()).map((s) => s.trim())).toEqual([
      "New worktree",
      "In place",
    ]);
    expect(await branchKind.inputValue()).toBe("change");
    expect((await branchKind.locator("option").allInnerTexts()).map((s) => s.trim())).toEqual([
      "New branch",
      "Current branch",
      "Existing branch",
    ]);

    // A new worktree cannot adopt the branch a source checkout has checked out: the option says
    // why instead of being offered.
    const current = branchKind.locator("option", { hasText: "Current branch" });
    expect(await current.isDisabled()).toBe(true);
    expect(await current.getAttribute("title")).toBe(
      "a new worktree cannot use the branch a source checkout has checked out",
    );

    // A created branch starts somewhere and merges somewhere; an existing branch is named
    // instead of started.
    expect(await row.locator("select.base").count()).toBe(1);
    expect(await row.locator("select.name").count()).toBe(0);
    expect(await row.locator("select.target").count()).toBe(1);
    await branchKind.selectOption("existing");
    expect(await row.locator("select.name").count()).toBe(1);
    expect(await row.locator("select.base").count()).toBe(0);
    expect(await row.locator("select.target").count()).toBe(1);

    // In place, the current branch becomes the offer — and taking it drops both branch pickers:
    // what a pull request merges into is the one branch question left.
    await location.selectOption("original");
    expect(await current.isDisabled()).toBe(false);
    await branchKind.selectOption("current");
    expect(await row.locator("select.name").count()).toBe(0);
    expect(await row.locator("select.base").count()).toBe(0);
    expect(await row.locator("select.target").count()).toBe(1);

    // Going back to a worktree cannot keep it: the row falls back to the change's own branch.
    await location.selectOption("new");
    expect(await branchKind.inputValue()).toBe("change");
    await page.close();
  },
  30_000,
);

test.skipIf(!usable)("the state selector speaks the record's vocabulary", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${url}/changes/${id}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".change-tabs select");
  const options = (await page.locator(".change-tabs select option").allInnerTexts()).map((s) =>
    s.trim(),
  );
  // The words are the record's: the rename of record format v2 reaches the page.
  expect(options).toContain("Implementation");
  expect(options).toContain("Verification");
  expect(options).not.toContain("In Progress");
  expect(options).not.toContain("Awaiting Review");
  await page.close();
}, 30_000);

test.skipIf(!usable)("the overview stays current while one of its own tabs is showing", async () => {
  // Two levels, two rows: the window's row says which surface — the change's own views or one of its
  // terminals — and the row under it says which of those views. So the Overview tab is current for
  // every one of them, not only for the dashboard, and it is still the way back to it.
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${url}/changes/${id}`, { waitUntil: "domcontentloaded" });
  expect(await page.locator(".change-bar .window-tab.overview.current").count()).toBe(1);

  const review = page.locator(".change-tabs .tab", { hasText: "Review changes" });
  await review.click();
  await page.waitForURL(`**/changes/${id}/review`);
  expect((await page.locator(".change-tabs .tab.current").innerText()).trim()).toBe(
    "Review changes",
  );
  expect(await page.locator(".change-bar .window-tab.overview.current").count()).toBe(1);

  await page.locator(".change-bar .window-tab.overview").click();
  await page.waitForURL(`**/changes/${id}`);
  await page.locator(".column.documents").waitFor();
  expect((await page.locator(".change-tabs .tab.current").innerText()).trim()).toBe("Dashboard");
  expect(await page.locator(".change-bar .window-tab.overview.current").count()).toBe(1);
  await page.close();
}, 30_000);

test.skipIf(!usable)("the right-click menu follows the setting", async () => {
  // Two worlds, one setting (docs/manual/interface.md). The host draws the menu in the
  // app — Electron has none of Chromium's own — and here the page is what can be checked: with the
  // setting off, a right-click the page does not handle is cancelled, which is what "no menu" means
  // in a browser and what keeps the click from reaching the host at all.
  const current = (await fetch(`${url}/api/settings`).then((r) => r.json())) as {
    file: Record<string, unknown>;
  };
  const write = (contextMenu: boolean): Promise<unknown> =>
    fetch(`${url}/api/settings`, {
      method: "PUT",
      body: JSON.stringify({ ...current.file, contextMenu }),
    });

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const rightClick = (): Promise<boolean> =>
    page.evaluate(() => {
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      document.body.dispatchEvent(event);
      return event.defaultPrevented;
    });

  // Shown is the default: the page leaves the menu to the browser.
  await write(true);
  await page.goto(`${url}/changes/${id}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".change-bar");
  expect(await rightClick()).toBe(false);

  // Turned off, the page cancels it — after the setting has arrived, which is a fetch behind the
  // first paint.
  await write(false);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".change-bar");
  let cancelled = false;
  for (let i = 0; i < 40 && !cancelled; i++) {
    cancelled = await rightClick();
    if (!cancelled) await page.waitForTimeout(50);
  }
  expect(cancelled).toBe(true);
  await page.close();
}, 30_000);
