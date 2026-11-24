import { test, expect, beforeAll, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { type Browser } from "playwright";
import {
  closePages,
  openBrowser,
  openFirstWindow,
  startTestServer,
  stopTestServer,
  testTempDir,
  withPage,
} from "./helpers.ts";

/** The Harnesses page and the new-terminal dialog through the page: the resolved view beside the
 * editor, the settings defaults section, and the dialog the "+" tab opens. */
let browser: Browser;
const usable = await openBrowser((opened) => {
  browser = opened;
});

let tmp: string;
let url: string;
let server: ReturnType<typeof Bun.spawn>;

const source = [
  "---",
  "label: Review environment",
  "basedOnHarnessProfile: pi-bare",
  "---",
  "notes",
  "",
].join("\n");
const CHANGE = "PAGE-harnesses";
const BROKEN = "PAGE-broken-harness";

beforeAll(async () => {
  tmp = await testTempDir("harnesses-page");
  ({ server, url } = await startTestServer(tmp));
  const written = await fetch(`${url}/api/harness-profile-files`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "global", id: "review-env", text: source }),
  });
  expect(written.status).toBe(200);
  const created = await fetch(`${url}/api/changes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: CHANGE, title: "Harness profile page", state: "Ideation" }),
  });
  expect(created.status).toBe(201);
  const broken = await fetch(`${url}/api/changes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: BROKEN, title: "Broken harness", state: "Ideation" }),
  });
  expect(broken.status).toBe(201);
  const patched = await fetch(`${url}/api/changes/${BROKEN}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userHarnessProfile: "global:gone" }),
  });
  expect(patched.status).toBe(200);
  const brokenHarness = await fetch(`${url}/api/harness-profile-files`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scope: "global",
      id: "bad-env",
      text: "---\nlabel: Bad environment\nbasedOnHarnessProfile: missing\n---\n",
    }),
  });
  expect(brokenHarness.status).toBe(200);
}, 60_000);

afterAll(async () => {
  await closePages(browser, "harnesses");
  await browser?.close();
  await stopTestServer(server, tmp);
  await rm(tmp, { recursive: true, force: true });
});

test.skipIf(!usable)(
  "the Harness profiles page edits a file beside its resolved view",
  async () => {
    await withPage(browser, async (page) => {
      await page.goto(`${url}/harnesses`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".harnesses-page");
      // The cards share the Actions/Subagents rhythm.
      const gaps = await page
        .locator(".harnesses-page > .widget")
        .evaluateAll((cards) =>
          cards
            .slice(1)
            .map(
              (card, index) =>
                card.getBoundingClientRect().top - cards[index]!.getBoundingClientRect().bottom,
            ),
        );
      expect(gaps.length).toBeGreaterThan(0);
      expect(gaps.every((gap) => gap >= 16)).toBe(true);
      const row = page.locator(".widget p", { hasText: "review-env.md" }).first();
      await row.getByRole("button", { name: "Edit" }).click();
      await page.waitForSelector(".harnesses-page.editing");
      await page.waitForSelector(".harness-docs");
      // The docs dock has its own scrollbar, independent of the Markdown editor.
      const dock = await page.locator(".harness-docs").evaluate((element) => ({
        overflow: getComputedStyle(element).overflowY,
        scrolls: element.scrollHeight > element.clientHeight,
      }));
      expect(dock.overflow).toBe("auto");
      expect(dock.scrolls).toBe(true);
      // The dock ends where the editor does: its own frame, never clipped by the window.
      const bottoms = await page.evaluate(() => ({
        editor: document.querySelector(".action-editor .md-editor")?.getBoundingClientRect().bottom,
        dock: document.querySelector(".harness-docs")?.getBoundingClientRect().bottom,
      }));
      expect(bottoms.dock).toBe(bottoms.editor);
      // The view endpoint honours views=0: selectors do not pay for a generated plan.
      const summary = (await (
        await fetch(`${url}/api/changes/${CHANGE}/harness-profiles?views=0`)
      ).json()) as {
        harnessProfiles: { view?: unknown }[];
      };
      expect(summary.harnessProfiles.every((harness) => harness.view === undefined)).toBe(true);
      const full = (await (await fetch(`${url}/api/changes/${CHANGE}/harness-profiles`)).json()) as {
        harnessProfiles: { view?: unknown }[];
      };
      expect(full.harnessProfiles.some((harness) => harness.view !== undefined)).toBe(true);
      // A relative repository path is refused at the wire, not turned into an empty key segment.
      expect((await fetch(`${url}/api/harness-profiles?repository=relative`)).status).toBe(400);
      // A workspace outside the config is refused rather than joined into a path.
      expect((await fetch(`${url}/api/harness-profiles?workspace=../../anything`)).status).toBe(400);
      // The resolved view is the generator's, for the active change: the chain reaches pi-bare
      // and the extensions section marks Corvi's own extension.
      await page.waitForFunction(
        () => (document.querySelector(".harness-view")?.textContent ?? "").includes("pi-bare"),
        undefined,
        { timeout: 10_000 },
      );
      const view = (await page.locator(".harness-view").textContent()) ?? "";
      expect(view).toContain("added by Corvi");
      expect(view).toContain("review-env");
      // The origin is said once per item, not "included · included".
      expect(view).not.toContain("included · included");
      expect(view).not.toContain("excluded · excluded");
      // The field documentation is docked beside it and names the harness fields.
      const fields = await page.locator(".harness-docs .action-docs .field h4 code").allTextContents();
      expect(fields).toContain("harness");
      expect(fields).toContain("basedOnHarnessProfile");
      expect(fields).toContain("extensions");
      // Every control is named: docs toggle, save, cancel, delete.
      for (const name of ["Hide docs", "Cancel", "Save", "Delete"]) {
        expect(await page.getByRole("button", { name }).count()).toBeGreaterThan(0);
      }
    });
  },
  60_000,
);

test.skipIf(!usable)(
  "Settings has Harness profile defaults, and the new-terminal dialog opens from the + tab",
  async () => {
    await withPage(browser, async (page) => {
      await page.goto(`${url}/settings#harness-defaults`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("text=Harness profile defaults");
      expect(await page.getByLabel("Shell panes").count()).toBe(1);
      expect(await page.getByLabel("New subagents").count()).toBe(1);

      await page.goto(`${url}/changes/${CHANGE}/terminals`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".window-tabs");
      // The first shell is opened, so the dialog defaults to its directory — a real location, not
      // the ambiguous "change root" the old dialog used for both kinds.
      await openFirstWindow(page);
      // Both change selectors live in the Actions → Harnesses… dialog, not the title row.
      expect(await page.getByLabel("change user harness").isVisible()).toBe(false);
      await page.locator(".change-bar button.actions").click();
      await page.locator(".change-bar .menu-items button", { hasText: "Harness profiles…" }).click();
      await page.waitForSelector(".harness-choice-dialog[open]");
      expect(await page.getByLabel("change user harness").isVisible()).toBe(true);
      expect(await page.getByLabel("subagent harness").isVisible()).toBe(true);
      expect(await page.locator(".harness-choice-dialog").textContent()).toContain("Default");
      // One top-right control, and no stray text after it.
      expect((await page.locator(".harness-choice-dialog > header").textContent())?.trim()).toBe(
        "Harness profiles×",
      );
      await page.keyboard.press("Escape");
      await page.waitForSelector(".harness-choice-dialog[open]", { state: "detached" });
      await page.locator(".window-tab.new").click();
      await page.waitForSelector(".new-terminal-dialog[open]");
      expect((await page.locator(".new-terminal-dialog > header").textContent())?.trim()).toBe(
        "New terminalCancel",
      );
      const directory = page.getByLabel("terminal directory");
      expect(await directory.inputValue()).toBe("current");
      const directoryOptions = await directory.locator("option").allTextContents();
      expect(directoryOptions.some((text) => text.startsWith("Current pane ("))).toBe(true);
      expect(directoryOptions).toContain("Change root");
      // The harness choice is meaningless for a shell, and the dialog says so by disabling it.
      expect(await page.getByLabel("terminal harness profile").isDisabled()).toBe(true);
      await page.getByRole("radio", { name: /Harness profile/ }).click();
      expect(await page.getByLabel("terminal harness profile").isDisabled()).toBe(false);
      await page.getByRole("radio", { name: /Shell/ }).click();
      expect(await page.getByLabel("terminal harness profile").isDisabled()).toBe(true);
      await directory.selectOption("change");
      await page.getByRole("radio", { name: /Harness profile/ }).click();
      const harnessSelect = page.getByLabel("terminal harness profile");
      await harnessSelect.selectOption("global:review-env");
      // Starting a shell still persists the harness choice; choices are remembered across opens.
      await page.keyboard.press("1");
      await page.waitForSelector(".new-terminal-dialog[open]", { state: "detached" });
      await page.waitForSelector('.window-tab[data-window-index="1"]', { timeout: 20_000 });
      await page.locator(".window-tab.new").click();
      await page.waitForSelector(".new-terminal-dialog[open]");
      expect(await page.getByLabel("terminal directory").inputValue()).toBe("change");
      await page.getByRole("radio", { name: /Harness profile/ }).click();
      expect(await page.getByLabel("terminal harness profile").inputValue()).toBe("global:review-env");
      await page.getByLabel("terminal harness profile").selectOption("");
      await page.keyboard.press("1");
      await page.waitForSelector(".new-terminal-dialog[open]", { state: "detached" });
      await page.locator(".window-tab.new").click();
      await page.waitForSelector(".new-terminal-dialog[open]");
      await page.getByRole("radio", { name: /Harness profile/ }).click();
      expect(await page.getByLabel("terminal harness profile").inputValue()).toBe("");
      await page.keyboard.press("Escape");
      await page.waitForSelector(".new-terminal-dialog[open]", { state: "detached" });
      // The tooltip no longer names the retired chord.
      const plus = page.locator(".window-tab.new");
      expect(await plus.getAttribute("title")).toBe("new terminal");
    });
  },
  60_000,
);

test.skipIf(!usable)(
  "a broken user harness never blocks a plain shell",
  async () => {
    await withPage(browser, async (page) => {
      await page.goto(`${url}/changes/${BROKEN}/terminals`, { waitUntil: "domcontentloaded" });
      // The first shell opens without the harness environment; the failure is reported in the
      // pane/log, not as a 400 that takes the terminal page down.
      await openFirstWindow(page);
      expect(await page.locator(".terminal-screen").count()).toBeGreaterThan(0);
    });
  },
  60_000,
);

test.skipIf(!usable)(
  "the wizard disables a harness whose chain does not resolve",
  async () => {
    await withPage(browser, async (page) => {
      await page.goto(`${url}/new`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".wizard");
      const harness = page.getByLabel("new change harness");
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('select[aria-label="new change harness"] option')].some((option) =>
            option.textContent?.includes("Bad environment"),
          ),
        undefined,
        { timeout: 10_000 },
      );
      const bad = harness.locator("option", { hasText: "Bad environment" });
      expect(await bad.count()).toBe(1);
      expect(await bad.isDisabled()).toBe(true);
    });
  },
  60_000,
);
