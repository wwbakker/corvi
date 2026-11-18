import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, type Locator, type Page } from "playwright";
import {
  closePages,
  gitRepo,
  openEngine,
  startTestServer,
  stopTestServer,
  testTempDir,
  VIEWPORT,
  withPage,
} from "./helpers.ts";

/**
 * The repository browser as a keyboard drives it: it opens in the filter with a row selected, the
 * arrows walk the list and wrap, Enter goes in, Alt+↑ comes back out, and Alt+Enter presses the
 * row's Add. What the server answers for a listing is pinned in repos.browse.test.ts; this is the
 * way through the dialog, which is where the keys live.
 */
let browser: Browser;
const usable = await openEngine((opened) => {
  browser = opened;
});

let tmp: string;
/** Where the browser opens: three directories, two of them repositories. */
let repos: string;
let url: string;
let server: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  if (!usable) return;
  tmp = await testTempDir("repo-browser");
  repos = join(tmp, "repos");
  await mkdir(repos, { recursive: true });
  // As repositories, without a clone and its seed beside them: this listing is the test's fixture.
  await gitRepo(repos, "alpha");
  await gitRepo(repos, "beta");
  // A directory that is not a repository: browsable, not addable.
  await mkdir(join(repos, "plain"), { recursive: true });

  ({ server, url } = await startTestServer(tmp, {
    // The browser opens here, not in the home directory of whoever runs the suite.
    env: { CORVI_REPOSITORIES_DIRECTORY: repos },
  }));

  // A change to edit the repositories of: none yet, so every row has something to offer.
  const created = await fetch(`${url}/api/changes`, {
    method: "POST",
    body: JSON.stringify({ id: "BROWSER-KEYS", state: "Ideation", checkouts: [] }),
  });
  expect(created.status).toBe(201);
});

afterAll(async () => {
  if (!usable) return;
  await closePages(browser, "repo-browser");
  await browser?.close();
  await stopTestServer(server, tmp);
  await rm(tmp, { recursive: true, force: true });
});

/** The dialog's own pane: the listing on the left, the chosen repositories on the right. */
const listing = (page: Page): Locator => page.locator("dialog[open] .browser .listing");
const filter = (page: Page): Locator => listing(page).locator("input.filter");
const rows = (page: Page): Locator => listing(page).locator(".entries button.dir");

/** The row the keyboard is on, by its name. */
const selected = async (page: Page): Promise<string> => {
  const row = listing(page).locator(".entries button.dir.selected");
  expect(await row.count()).toBe(1);
  // The row a keypress would act on is the row with the cursor, and it says so to a screen reader.
  expect(await row.getAttribute("aria-current")).toBe("true");
  // A row reads "alpha/" with the repo tag after it; the name is what the list is about.
  return (await row.innerText()).split("\n")[0]!.trim();
};

/** How many repositories the dialog holds so far. */
const chosen = async (page: Page): Promise<number> => {
  const heading = await page.locator("dialog[open] .selected-pane .breadcrumb").innerText();
  return Number(heading.replace(/\D/g, ""));
};

/** Where the keyboard is: the filter's own name is what says the browser opened in it. */
const focusedName = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null);

test.skipIf(!usable)(
  "the browser opens in the filter, on the first row, and walks from there",
  async () => {
    await withPage(
      browser,
      async (page) => {
        await page.goto(`${url}/changes/BROWSER-KEYS/dashboard`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector('button[title="Edit Local changes"]');
        await page.locator('button[title="Edit Local changes"]').click();
        await rows(page).first().waitFor();

        // Open, the keyboard is in the filter rather than on the dialog or the breadcrumb.
        expect(await focusedName(page)).toBe("Filter directories");
        expect(await selected(page)).toBe("alpha/");

        // Down and Up walk the list and wrap at both ends.
        await page.keyboard.press("ArrowDown");
        expect(await selected(page)).toBe("beta/");
        await page.keyboard.press("ArrowDown");
        expect(await selected(page)).toBe("plain/");
        await page.keyboard.press("ArrowDown");
        expect(await selected(page)).toBe("alpha/");
        await page.keyboard.press("ArrowUp");
        expect(await selected(page)).toBe("plain/");

        // Enter walks into the selected directory, and the pane says it is empty rather than stuck.
        await page.keyboard.press("Enter");
        await listing(page).locator(".entries .hint", { hasText: "empty" }).waitFor();
        expect(await listing(page).locator(".breadcrumb").innerText()).toContain("repos/plain");

        // Alt+↑ walks back out, and the selection starts over at the top of the new listing.
        await page.keyboard.press("Alt+ArrowUp");
        await rows(page).first().waitFor();
        expect(await listing(page).locator(".breadcrumb").innerText()).toContain("repos");
        expect(await selected(page)).toBe("alpha/");

        // The filter narrows the list and the selection goes back to what is left.
        await filter(page).fill("bet");
        expect(await rows(page).count()).toBe(1);
        expect(await selected(page)).toBe("beta/");
        await filter(page).fill("");
        expect(await selected(page)).toBe("alpha/");
      },
      VIEWPORT,
    );
  },
  120_000,
);

test.skipIf(!usable)(
  "Alt+Enter presses the row's Add, and only where the button could be pressed",
  async () => {
    await withPage(
      browser,
      async (page) => {
        await page.goto(`${url}/changes/BROWSER-KEYS/dashboard`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector('button[title="Edit Local changes"]');
        await page.locator('button[title="Edit Local changes"]').click();
        await rows(page).first().waitFor();

        // A directory that is not a repository: the Add button is disabled, and so is the key.
        await filter(page).fill("plain");
        await page.keyboard.press("Alt+Enter");
        expect(await chosen(page)).toBe(0);
        expect(
          await page.locator("dialog[open] .selected-pane").getByText("no repositories selected").count(),
        ).toBe(1);

        // A repository: the key adds it, and the row says so — one Add, not a toggle.
        await filter(page).fill("alpha");
        await page.keyboard.press("Alt+Enter");
        await page.locator("dialog[open] .selected-pane .selection").first().waitFor();
        expect(await chosen(page)).toBe(1);
        const add = listing(page).locator(".entries li", { hasText: "alpha" }).getByRole("button", {
          name: "Added",
        });
        expect(await add.count()).toBe(1);
        expect(await add.isDisabled()).toBe(true);

        // The same key on the same row is a disabled button: nothing happens, nothing is removed.
        await page.keyboard.press("Alt+Enter");
        expect(await chosen(page)).toBe(1);

        // The keymap names what this pane can do, including the chord it just used.
        await page.locator("dialog[open] button.keys").click();
        const keymap = page.locator("dialog[open] .keymap");
        await keymap.waitFor();
        const lines = await keymap.innerText();
        expect(lines).toContain("choose");
        expect(lines).toContain("open");
        expect(lines).toContain("up");
        expect(lines).toContain("add");
        // Nothing in the pane is left looking truncated or unnamed.
        expect(await keymap.locator("li").count()).toBe(4);

        // Closing and opening again starts the browser over: the start directory, an empty
        // filter, the first row selected — the same place the first opening was.
        await page.locator("dialog[open]").getByRole("button", { name: "Cancel" }).click();
        await page.waitForSelector("dialog[open]", { state: "hidden" });
        await page.locator('button[title="Edit Local changes"]').click();
        await rows(page).first().waitFor();
        expect(await focusedName(page)).toBe("Filter directories");
        expect(await selected(page)).toBe("alpha/");
      },
      VIEWPORT,
    );
  },
  120_000,
);
