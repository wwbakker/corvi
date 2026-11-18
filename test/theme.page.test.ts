import { test, expect, beforeAll, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { type Browser, type Page } from "playwright";
import { CORVI_COLOURS, coloursOf, THEMES, type ThemeId } from "../apps/web/src/domain/theme.ts";
import { closePages, openEngine, startTestServer, stopTestServer, testTempDir, withPage } from "./helpers.ts";

/**
 * The themes through the product: chosen in Settings, applied to the page at once without a
 * reload, remembered per device, every one dark with an opaque terminal well, and Spaces lighting
 * the page from the open change's own pair. The tokens' own values are pinned where a reader
 * resolves them (the plan editor here, `plan.page.test.ts` for its roles); what a theme is made of
 * stays in `styles.css`.
 */
let browser: Browser;
const usable = await openEngine((opened) => {
  browser = opened;
});

let tmp: string;
let url: string;
let server: ReturnType<typeof Bun.spawn>;

/** The cookie the page keeps the choice in (`apps/web/src/app-root/prefs.ts`). */
const THEME_COOKIE = "corvi:theme";

const chooseByCookie = (page: Page, theme: ThemeId): Promise<void> =>
  page
    .context()
    .addCookies([{ name: THEME_COOKIE, value: theme, url }])
    .then(() => undefined);

const onScreen = (page: Page, theme: ThemeId): Promise<void> =>
  page
    .waitForFunction((wanted) => document.documentElement.dataset.theme === wanted, theme)
    .then(() => undefined);

/** The tokens a theme puts on the root, as the page resolved them. */
const rootTokens = (page: Page): Promise<Record<string, string>> =>
  page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const token = (name: string): string => style.getPropertyValue(name).trim();
    return {
      theme: document.documentElement.dataset.theme ?? "",
      scheme: style.colorScheme,
      well: token("--well"),
      text: token("--text"),
      meta: document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? "",
    };
  });

beforeAll(async () => {
  tmp = await testTempDir("theme-page");
  ({ server, url } = await startTestServer(tmp));
  // An idea (which keeps Corvi's own pair in Spaces) and a change (which derives its own). Both
  // are created as ideas — a change needs repositories — and PROJ-2 is moved on from there.
  for (const [id, title] of [
    ["PROJ-1", "An idea"],
    ["PROJ-2", "A change"],
  ] as const) {
    const created = await fetch(`${url}/api/changes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, title, state: "Ideation", plan: "# The plan\n" }),
    });
    expect(created.status).toBe(201);
  }
  const started = await fetch(`${url}/api/changes/PROJ-2`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state: "Implementation" }),
  });
  expect(started.status).toBe(200);
});

afterAll(async () => {
  await closePages(browser, "theme");
  await browser?.close();
  await stopTestServer(server, tmp);
  await rm(tmp, { recursive: true, force: true });
});

test.skipIf(!usable)(
  "a theme is picked in Settings and applies without a reload",
  async () => {
    await withPage(browser, async (page) => {
      await page.goto(`${url}/settings`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("nav.tabs");
      await page.getByRole("button", { name: "Appearance" }).click();
      await page.waitForSelector(".theme-choices");

      // All four, with Dusk marked as the default and on screen.
      expect(await page.locator(".theme-choice").count()).toBe(THEMES.length);
      expect(await page.locator(".theme-choice.current .name").textContent()).toContain("Dusk");
      expect(await page.locator(".theme-choice .badge").textContent()).toBe("default");
      await onScreen(page, "dusk");

      // A marker a reload would clear: picking a theme must not reload the page.
      await page.evaluate(() => {
        (window as Window & { corviSameDocument?: boolean }).corviSameDocument = true;
      });
      await page.locator(".theme-choice", { hasText: "Raven Black" }).click();
      await onScreen(page, "raven");
      const sameDocument = await page.evaluate(
        () => (window as Window & { corviSameDocument?: boolean }).corviSameDocument === true,
      );
      expect(sameDocument).toBe(true);

      // The tokens the page resolved are the theme's, not the old ones: black, near-white text,
      // and the browser chrome takes the theme's base colour too.
      expect(await rootTokens(page)).toEqual({
        theme: "raven",
        scheme: "dark",
        well: "#050506",
        text: "#ececf1",
        meta: "#000000",
      });
      expect(await page.locator(".theme-choice.current .name").textContent()).toContain("Raven Black");
      expect(await page.getByRole("radio", { name: /Raven Black/ }).isChecked()).toBe(true);

      // The choice is this device's: it is still Raven Black on a fresh visit.
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("nav.tabs");
      await onScreen(page, "raven");
    });
  },
  60_000,
);

test.skipIf(!usable)(
  "every theme is dark and keeps the terminal's well opaque",
  async () => {
    await withPage(browser, async (page) => {
      for (const theme of THEMES) {
        await chooseByCookie(page, theme.id);
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await onScreen(page, theme.id);
        const tokens = await rootTokens(page);
        // No light theme: every one says so to the platform's controls.
        expect(tokens.scheme).toBe("dark");
        // The well is a solid colour — no alpha — in every theme, because a terminal's background
        // never has a translucent or blurred surface behind it.
        expect(tokens.well).toMatch(/^#[0-9a-f]{6}$/);
        expect(tokens.text).toMatch(/^#[0-9a-f]{6}$/);
        expect(tokens.meta).toMatch(/^#[0-9a-f]{6}$/);
      }
    });
  },
  60_000,
);

test.skipIf(!usable)(
  "a token reader follows the theme: the plan editor wears Raven Black",
  async () => {
    await withPage(browser, async (page) => {
      await chooseByCookie(page, "raven");
      await page.goto(`${url}/changes/PROJ-1/plan`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".md-editor .cm-line");

      // The editor's colours are the sheet's tokens: same rules, a different theme's values.
      expect(
        await page.locator(".md-editor .cm-content").evaluate((element) => getComputedStyle(element).color),
      ).toBe("rgb(236, 236, 241)"); // --text: #ececf1
      expect(
        await page
          .locator(".md-editor .cm-line span", { hasText: "The plan" })
          .first()
          .evaluate((element) => getComputedStyle(element).color),
      ).toBe("rgb(111, 131, 255)"); // --md-heading: #6f83ff
    });
  },
  60_000,
);

test.skipIf(!usable)(
  "Spaces lights the page from the change, and keeps Corvi's pair for ideas and the overview",
  async () => {
    await withPage(browser, async (page) => {
      await chooseByCookie(page, "spaces");

      const hues = (): Promise<{ a: string; b: string; swatch: string }> =>
        page.evaluate(() => {
          const swatch = document.querySelector(".sidebar .entry.change .swatch");
          return {
            a: document.documentElement.style.getPropertyValue("--hue-a"),
            b: document.documentElement.style.getPropertyValue("--hue-b"),
            swatch: swatch === null ? "missing" : getComputedStyle(swatch).display,
          };
        });

      // A change's pair comes from its id, from the fixed palette.
      const changePair = coloursOf("PROJ-2", false);
      await page.goto(`${url}/changes/PROJ-2`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".sidebar .entry.change");
      await onScreen(page, "spaces");
      const change = await hues();
      expect({ a: change.a, b: change.b }).toEqual({ a: changePair.from, b: changePair.to });
      // The same pair is drawn beside the change's name here, and only here.
      expect(change.swatch).not.toBe("none");

      // An idea is not a job yet, so it keeps Corvi's own pair.
      await page.goto(`${url}/changes/PROJ-1`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".sidebar .entry.change");
      const idea = await hues();
      expect({ a: idea.a, b: idea.b }).toEqual({
        a: CORVI_COLOURS.from,
        b: CORVI_COLOURS.to,
      });

      // The overview is painted by Corvi's pair too.
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".sidebar");
      const overview = await hues();
      expect({ a: overview.a, b: overview.b }).toEqual({
        a: CORVI_COLOURS.from,
        b: CORVI_COLOURS.to,
      });

      // Outside Spaces the pair is still set (the theme's tokens read it), but no swatch is drawn.
      await chooseByCookie(page, "raven");
      await page.goto(`${url}/changes/PROJ-2`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".sidebar .entry.change");
      await onScreen(page, "raven");
      expect((await hues()).swatch).toBe("none");
    });
  },
  60_000,
);
