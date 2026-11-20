import { test, expect, beforeAll, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { type Browser, type Page } from "playwright";
import { closePages, openEngine, startTestServer, stopTestServer, testTempDir, withPage } from "./helpers.ts";

/**
 * The monospace font through the product: the bundled Nerd Fonts symbols reach every monospace
 * surface, a face chosen in Settings → Appearance goes in front of them and is remembered per
 * device, and a build without the symbols font still opens terminals and says why its icons are
 * boxes.
 */
let browser: Browser;
const usable = await openEngine((opened) => {
  browser = opened;
});

let tmp: string;
let url: string;
let server: ReturnType<typeof Bun.spawn>;

const SYMBOLS = "Symbols Nerd Font Mono";

/** pi's footer icon (U+EC19), the powerline branch, and two Font Awesome icons. */
const ICONS = "\uEC19 \uE0A0 \uF113 \uF07B";

/** The cookie the page keeps the choice in (`apps/web/src/app-root/monoFont.ts`). */
const FONT_COOKIE = "corvi:mono-font";

type TerminalHost = { corviTerminal?: { options: { fontFamily?: string } } };

const terminalFontFamily = (page: Page): Promise<string | undefined> =>
  page.evaluate(
    () =>
      (document.querySelector(".terminal-screen") as unknown as TerminalHost | null)?.corviTerminal?.options
        .fontFamily,
  );

const openTerminal = async (page: Page): Promise<void> => {
  await page.goto(`${url}/changes/PROJ-1/terminals`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 20_000 });
  await page.waitForFunction(
    () =>
      (document.querySelector(".terminal-screen") as unknown as TerminalHost | null)?.corviTerminal !==
      undefined,
  );
};

const openAppearance = async (page: Page): Promise<void> => {
  await page.goto(`${url}/settings`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("nav.tabs");
  await page.getByRole("button", { name: "Appearance" }).click();
  await page.waitForSelector(".theme-choices");
};

beforeAll(async () => {
  if (!usable) return;
  tmp = await testTempDir("mono-font-page");
  ({ server, url } = await startTestServer(tmp));
  const created = await fetch(`${url}/api/changes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Icons on a plain line of the plan, as when one is pasted from a terminal.
    body: JSON.stringify({
      id: "PROJ-1",
      title: "An idea",
      state: "Ideation",
      plan: `# The plan\n\nIcons: ${ICONS}\n`,
    }),
  });
  expect(created.status).toBe(201);
});

afterAll(async () => {
  if (!usable) return;
  await closePages(browser, "mono-font");
  await browser?.close();
  await stopTestServer(server, tmp);
  await rm(tmp, { recursive: true, force: true });
});

test.skipIf(!usable)("the server serves the symbols font and its licences from the build", async () => {
  const font = await fetch(`${url}/fonts/SymbolsNerdFontMono-Regular.ttf`);
  expect(font.status).toBe(200);
  expect(font.headers.get("content-type")).toBe("font/ttf");
  expect(font.headers.get("cache-control")).toBe("public, max-age=86400");
  expect((await font.arrayBuffer()).byteLength).toBeGreaterThan(1_000_000);
  for (const licence of ["LICENSE", "README.md"]) {
    expect((await fetch(`${url}/fonts/${licence}`)).status).toBe(200);
  }
  // The parameter is a file name: it cannot climb out of the fonts directory.
  expect((await fetch(`${url}/fonts/..%2Findex.html`)).status).toBe(404);
});

test.skipIf(!usable)(
  "the terminal and the editor draw Nerd Fonts icons from the bundled font",
  async () => {
    await withPage(browser, async (page) => {
      await openTerminal(page);
      const family = await terminalFontFamily(page);
      expect(family).toContain(`"${SYMBOLS}"`);
      // The text faces come first: the symbols font only fills in what they lack.
      expect(family!.indexOf(SYMBOLS)).toBeGreaterThan(family!.indexOf("Menlo"));
      // The icon pi's footer prints (U+EC19) has a face that draws it.
      expect(
        await page.evaluate(async (symbols) => {
          const faces = await document.fonts.load(`16px "${symbols}"`, "\uEC19");
          return faces.some((face) => face.status === "loaded");
        }, SYMBOLS),
      ).toBe(true);

      await page.goto(`${url}/changes/PROJ-1`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".md-editor .cm-scroller");
      expect(
        await page
          .locator(".md-editor .cm-scroller")
          .evaluate((element) => getComputedStyle(element).fontFamily),
      ).toContain(SYMBOLS);
    });

    // A cold page that opens on the plan: Chromium keeps the boxes it drew for text laid out
    // before the icon font arrived, so this checks the face that actually drew the line. The
    // question is Chromium's own (DevTools protocol), and the app's window is Chromium.
    if (browser.browserType().name() !== "chromium") return;
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${url}/changes/PROJ-1`, { waitUntil: "domcontentloaded" });
      const line = page.locator(".md-editor .cm-line", { hasText: "Icons:" });
      await line.waitFor();
      await page.evaluate(() => document.fonts.ready);
      const index = await page.evaluate(() =>
        [...document.querySelectorAll(".md-editor .cm-line")].findIndex((l) =>
          l.textContent?.startsWith("Icons:"),
        ),
      );
      const cdp = await context.newCDPSession(page);
      const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
      await cdp.send("CSS.enable");
      const lines = await cdp.send("DOM.querySelectorAll", {
        nodeId: root.nodeId,
        selector: ".md-editor .cm-line",
      });
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: lines.nodeIds[index]! });
      // All four icons, none left to the text face's boxes.
      expect(fonts.find((font) => font.familyName === SYMBOLS)?.glyphCount).toBe(4);
    } finally {
      await context.close();
    }
  },
  60_000,
);

test.skipIf(!usable)(
  "a font chosen in Settings goes in front of the stack, reaches the terminal, and is remembered",
  async () => {
    await withPage(browser, async (page) => {
      await openAppearance(page);
      const field = page.getByRole("textbox", { name: "Monospace font" });
      await field.fill("Courier New");
      // It applies as typed: no Save, no reload.
      await page.waitForFunction(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--font-mono").includes("Courier New"),
      );

      // The tip says where a system lists its fonts, on hover and on keyboard focus.
      const info = page.getByRole("button", { name: "Finding a font's name" });
      await info.hover();
      expect(await page.getByRole("tooltip").isVisible()).toBe(true);
      expect(await page.getByRole("tooltip").textContent()).toContain("Font Book");
      await page.mouse.move(0, 0);
      expect(await page.getByRole("tooltip").isVisible()).toBe(false);
      await field.focus();
      await page.keyboard.press("Shift+Tab");
      expect(await page.getByRole("tooltip").isVisible()).toBe(true);

      // The chosen face leads; the text fallbacks and the icons stay behind it.
      await openTerminal(page);
      const family = await terminalFontFamily(page);
      expect(family).toStartWith('"Courier New"');
      expect(family).toContain(SYMBOLS);

      // This device's choice: still there on a fresh visit.
      await openAppearance(page);
      expect(await page.getByRole("textbox", { name: "Monospace font" }).inputValue()).toBe("Courier New");

      // Emptying the field returns to the page's own stack.
      await page.getByRole("textbox", { name: "Monospace font" }).fill("");
      await page.waitForFunction(
        () =>
          !getComputedStyle(document.documentElement).getPropertyValue("--font-mono").includes("Courier New"),
      );
      const cookie = (await page.context().cookies()).find((c) => c.name === FONT_COOKIE);
      expect(cookie?.value ?? "").toBe("");
      await openTerminal(page);
      expect(await terminalFontFamily(page)).not.toContain("Courier New");
    });
  },
  60_000,
);

test.skipIf(!usable)(
  "without the symbols font, terminals still open and Settings says why icons are boxes",
  async () => {
    await withPage(browser, async (page) => {
      await page.route("**/fonts/**", (route) => route.fulfill({ status: 404, body: "no such font" }));
      await openTerminal(page);
      expect(await terminalFontFamily(page)).toContain("Menlo");

      await openAppearance(page);
      await page.waitForSelector(".mono-font small.warn");
      expect(await page.locator(".mono-font small.warn").textContent()).toContain("bun run fonts");
    });
  },
  60_000,
);

test.skipIf(!usable)(
  "with the symbols font, Settings shows no warning",
  async () => {
    await withPage(browser, async (page) => {
      await openAppearance(page);
      await page.evaluate(async (symbols) => {
        await document.fonts.load(`16px "${symbols}"`, "\uEC19");
      }, SYMBOLS);
      expect(await page.locator(".mono-font small.warn").count()).toBe(0);
    });
  },
  60_000,
);
