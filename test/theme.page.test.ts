import { test, expect, beforeAll, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { type Browser, type Page } from "playwright";
import { CORVI_COLOURS, coloursOf, THEMES, type ThemeId } from "../apps/web/src/domain/theme.ts";
import { closePages, openEngine, startTestServer, stopTestServer, testTempDir, withPage } from "./helpers.ts";

/**
 * The themes through the product: chosen in Settings, applied to the page at once without a
 * reload, remembered per device, every one dark with an opaque terminal well, and Spaces lighting
 * the page from the open change's own pair.
 *
 * What a theme is made of stays in `styles.css`, so assertions that are about *following* a token
 * compare against the token's resolved value rather than a copy of it; only the vocabulary and the
 * id → pair mapping are pinned (`theme.test.ts`).
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

/** Switch the page the way a theme switch does: the cookie this device keeps, and the attribute
 * every rule and reader follows. `chooseTheme` does the same two things in the app. */
const switchOnScreen = (page: Page, theme: ThemeId): Promise<void> =>
  page
    .evaluate((wanted) => {
      document.cookie = `corvi:theme=${wanted}; path=/; SameSite=Lax`;
      document.documentElement.dataset.theme = wanted;
    }, theme)
    .then(() => onScreen(page, theme));

const onScreen = (page: Page, theme: ThemeId): Promise<void> =>
  page
    .waitForFunction((wanted) => document.documentElement.dataset.theme === wanted, theme)
    .then(() => undefined);

/** A token's value as the sheet declared it (a hex, a colour-mix, a var reference). */
const rawToken = (page: Page, name: string): Promise<string> =>
  page.evaluate((token) => {
    return getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  }, name);

/** A token's value in the form `getComputedStyle` reports colours (`rgb(...)`), resolved by the
 * browser rather than converted from a copy in the test. */
const resolvedToken = (page: Page, name: string): Promise<string> =>
  page.evaluate((token) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${token})`;
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  }, name);

interface RootTokens {
  readonly theme: string;
  readonly scheme: string;
  readonly well: string;
  readonly text: string;
  readonly bg: string;
  readonly meta: string;
}

/** The tokens a theme puts on the root, as the page resolved them. */
const rootTokens = (page: Page): Promise<RootTokens> =>
  page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const token = (name: string): string => style.getPropertyValue(name).trim();
    return {
      theme: document.documentElement.dataset.theme ?? "",
      scheme: style.colorScheme,
      well: token("--well"),
      text: token("--text"),
      bg: token("--bg"),
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
      await page.waitForSelector(".settings-tree");
      await page.locator(".settings-tree").getByRole("button", { name: "Appearance", exact: true }).click();
      await page.waitForSelector(".theme-choices");

      // All four, with Dusk marked as the default and on screen.
      expect(await page.locator(".theme-choice").count()).toBe(THEMES.length);
      expect(await page.locator(".theme-choice.current .name").textContent()).toContain("Dusk");
      expect(await page.locator(".theme-choice .badge").textContent()).toBe("default");
      await onScreen(page, "dusk");
      const before = await rootTokens(page);

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

      // The tokens the page resolved are another theme's, and the browser chrome takes that
      // theme's base colour. The values themselves live in the sheet: what matters here is that
      // they moved, and that the meta tag and `--bg` agree.
      const after = await rootTokens(page);
      expect(after.theme).toBe("raven");
      expect(after.scheme).toBe("dark");
      expect(after.well).not.toBe(before.well);
      expect(after.text).not.toBe(before.text);
      expect(after.meta).toBe(after.bg);
      expect(await page.locator(".theme-choice.current .name").textContent()).toContain("Raven Black");
      expect(await page.getByRole("radio", { name: /Raven Black/ }).isChecked()).toBe(true);

      // The choice is this device's: it is still Raven Black on a fresh visit.
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(".settings-tree");
      await onScreen(page, "raven");
    });
  },
  60_000,
);

test.skipIf(!usable)(
  "the stored theme is on the page before the bundle runs",
  async () => {
    // The attribute is set by index.html's own script, ahead of the module bundle: a device on
    // Raven never paints a frame of Dusk, even before React exists.
    await withPage(browser, async (page) => {
      await chooseByCookie(page, "raven");
      await page.route("**/app.js", (route) => route.abort());
      await page.goto(url, { waitUntil: "domcontentloaded" });
      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("raven");
      // Nothing of the app rendered: this is the frame the browser would have painted.
      expect(await page.locator(".sidebar").count()).toBe(0);
      expect(await rawToken(page, "--bg")).not.toBe("");
      expect(await page.locator('meta[name="theme-color"]').getAttribute("content")).toBe(
        await rawToken(page, "--bg"),
      );
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
        expect(tokens.theme).toBe(theme.id);
        // No light theme: every one says so to the platform's controls.
        expect(tokens.scheme).toBe("dark");
        // The well is a solid colour — no alpha — in every theme, because a terminal's background
        // never has a translucent or blurred surface behind it.
        expect(tokens.well).toMatch(/^#[0-9a-f]{6}$/);
        expect(tokens.text).toMatch(/^#[0-9a-f]{6}$/);
        expect(tokens.meta).toBe(tokens.bg);
      }
    });
  },
  60_000,
);

test.skipIf(!usable)(
  "the plan editor follows a live theme switch",
  async () => {
    await withPage(browser, async (page) => {
      await chooseByCookie(page, "dusk");
      await page.goto(`${url}/changes/PROJ-1/plan`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".md-editor .cm-line");

      const heading = page.locator(".md-editor .cm-line span", { hasText: "The plan" }).first();
      const before = await heading.evaluate((element) => getComputedStyle(element).color);
      expect(before).toBe(await resolvedToken(page, "--md-heading"));

      // The editor is mounted; the switch happens under it. Its colours are the sheet's tokens, so
      // it follows without a reload or a re-render.
      const duskHeading = await rawToken(page, "--md-heading");
      await switchOnScreen(page, "raven");
      await page.waitForFunction(
        (previous) =>
          getComputedStyle(document.documentElement).getPropertyValue("--md-heading").trim() !== previous,
        duskHeading,
      );
      const after = await heading.evaluate((element) => getComputedStyle(element).color);
      expect(after).toBe(await resolvedToken(page, "--md-heading"));
      expect(after).not.toBe(before);
      expect(
        await page.locator(".md-editor .cm-content").evaluate((element) => getComputedStyle(element).color),
      ).toBe(await resolvedToken(page, "--text"));
    });
  },
  60_000,
);

test.skipIf(!usable)(
  "an open terminal follows a live theme switch",
  async () => {
    await withPage(browser, async (page) => {
      await chooseByCookie(page, "dusk");
      await page.goto(`${url}/changes/PROJ-2/terminals`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 20_000 });
      await page.waitForFunction(
        () =>
          (document.querySelector(".terminal-screen") as unknown as { corviTerminal?: unknown })
            .corviTerminal !== undefined,
      );

      const background = (): Promise<string | undefined> =>
        page.evaluate(() => {
          const terminal = (
            document.querySelector(".terminal-screen") as unknown as {
              corviTerminal?: { options: { theme?: { background?: string } } };
            }
          ).corviTerminal;
          return terminal?.options.theme?.background;
        });

      // Created under Dusk, xterm resolved the well when it was built.
      const before = await background();
      expect(before).toBe(await rawToken(page, "--well"));

      // The theme changes under the open terminal: the attribute is the switch, and xterm is the
      // reader that holds a resolved colour rather than following CSS.
      await switchOnScreen(page, "raven");
      await page.waitForFunction((previous) => {
        const terminal = (
          document.querySelector(".terminal-screen") as unknown as {
            corviTerminal?: { options: { theme?: { background?: string } } };
          }
        ).corviTerminal;
        return terminal?.options.theme?.background !== previous;
      }, before);
      const after = await background();
      expect(after).toBe(await rawToken(page, "--well"));
      expect(after).not.toBe(before);
    });
  },
  60_000,
);

test.skipIf(!usable)(
  "reduced motion stills the sky as soon as it is asked for",
  async () => {
    await withPage(browser, async (page) => {
      await chooseByCookie(page, "dusk");
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".sidebar");
      await onScreen(page, "dusk");

      // Following, while the reader allows motion.
      await page.mouse.move(1200, 800);
      await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--sky-x") !== "");

      // The preference changes mid-session: the sky stops without waiting for a theme switch.
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.waitForFunction(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
      await page.mouse.move(40, 40);
      expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--sky-x"))).toBe("");

      // And it comes back when the reader allows motion again. The media change and the pointer's
      // next move race for the same tick, so the move is retried until the handler is attached.
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.waitForFunction(() => !matchMedia("(prefers-reduced-motion: reduce)").matches);
      for (let attempt = 0; attempt < 20; attempt++) {
        await page.mouse.move(600 + attempt, 300);
        const moved = await page.evaluate(() => document.documentElement.style.getPropertyValue("--sky-x"));
        if (moved !== "") break;
        await Bun.sleep(50);
      }
      await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--sky-x") !== "");
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
      // The pair resolves: the tokens the mapping names are the ones the sheet writes, so the page's
      // light and the swatch beside the change's name are real colours, not a missing var().
      const painted = await page.evaluate(() => {
        const swatch = document.querySelector(".sidebar .entry.change .swatch");
        return {
          swatch: swatch === null ? "none" : getComputedStyle(swatch).backgroundImage,
          hue: getComputedStyle(document.documentElement).getPropertyValue("--hue-a").trim(),
        };
      });
      expect(painted.swatch).toContain("linear-gradient");
      expect(painted.hue).not.toBe("");
      // The same pair is drawn beside the change's name here, and only here.
      expect(change.swatch).not.toBe("none");

      // An idea is not a job yet, so it keeps Corvi's own pair.
      await page.goto(`${url}/changes/PROJ-1`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".sidebar .entry.change");
      const idea = await hues();
      expect({ a: idea.a, b: idea.b }).toEqual({ a: CORVI_COLOURS.from, b: CORVI_COLOURS.to });

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
