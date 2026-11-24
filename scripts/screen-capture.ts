/**
 * One surface, captured: a browser and the environment that decides its pixels, the page's
 * arrival, its state, its data, and the findings that need no earlier revision to be wrong.
 *
 * Both walks share this module and nothing else about capturing. `scripts/screens.ts` calls it
 * twice per surface — once against the base revision's page bundle, once against this one — and
 * `scripts/shot.ts` once against a running instance. What differs between them is a parameter:
 * where the page is served from, which change the surface is about, where the image goes, and
 * whether the fixture's stubbed answers (Azure DevOps's services, the dashboard's two cards) are
 * answered on the page at all. Those stubs are not part of the walk: a live capture must show the
 * instance's own answers, so they arrive as `stub`, which only the fixture walk gives.
 *
 * The engine is Chromium — the app's own, since the window is Electron — and one comparison run is
 * one engine, so its two passes cancel.
 *
 * Everything that decides a pixel is stated here rather than inherited: one viewport per surface
 * (the catalog's, or 1280x900), one theme per surface (written into the cookie before the
 * navigation), a frozen `Date`, one locale, UTC, the dark colour scheme and reduced motion.
 * `page.clock.setFixedTime` freezes the clock only — the pages poll, and an installed clock would
 * stop the data arriving (docs/guides/testing.md).
 *
 * ## What this does not see
 *
 * Whether the base revision has a surface at all, what the two captures look like side by side,
 * and what the server offers with no catalog entry are the fixture walk's questions
 * (`scripts/screens.ts`): a capture knows only its surface. Nor does a capture decide what a
 * failure means beyond its own pass — the caller reads `fatal` and decides.
 */
import { join } from "node:path";
import { env } from "@corvi/configuration/node";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { budget, settleLayout } from "./timing.ts";
import { clippingOf, describeClipping, type ClippingBox } from "./screen-clipping.ts";
import {
  LOADING_PLACEHOLDERS,
  LOADING_TEXTS,
  SHELL_SCROLL,
  THEME_COOKIE,
  VIEWPORT,
  fileNameOf,
  routeOf,
  type PlaceholderPattern,
  type Surface,
  type SurfaceContext,
} from "./screen-catalog.ts";

/** What one surface's capture found. A fatal finding fails the run; a clipping finding is
 * reported for a person to read. `pass` says which revision it came from: the base's findings
 * explain a missing comparison and are never the current revision's to answer for, so they are
 * kept and printed but do not fail the run. `coverage` is not a capture's finding — the fixture
 * walk's page-and-tab check reports under the same shape so that one report lists everything. */
export type Finding = {
  readonly surface: string;
  readonly kind: "did-not-arrive" | "still-loading" | "console-error" | "page-error" | "clipped" | "coverage";
  readonly detail: string;
  readonly fatal: boolean;
  readonly pass: "before" | "after";
};

/** A walk's answers to the reads that need a login or a target this machine may not have. Given
 * by the fixture walk only: a live capture must never photograph stub data. */
export type BrowserStub = (context: BrowserContext) => Promise<void>;

/** How one surface is captured. Everything the capture cannot infer — the origin, the change, the
 * instant, the destination — is stated by the walk that owns it. */
export type CaptureOptions = {
  /** Which side of a comparison this is. The live walk always captures the `after` side: the
   * running instance is the current revision. */
  readonly pass: "before" | "after";
  /** The directory the image is written to, as `NN-<surface>.png`. */
  readonly out: string;
  /** The origin the page is loaded from: the current server, the base revision's, or a live
   * instance. */
  readonly origin: string;
  /** The Corvi server's origin: what the surface's setup is told, and the second origin the theme
   * cookie is written for when the page is served from a base bundle. */
  readonly serverUrl: string;
  /** The change the catalog's change entries are about. */
  readonly change: string;
  /** The instant relative times are measured from. */
  readonly now: Date;
  readonly headed: boolean;
  /** The fixture's third-party answers, or nothing for a live walk. */
  readonly stub?: BrowserStub;
  /** What a `setup` that cannot run means. The fixture walk leaves this out: its fixture promises
   * the rows, files and documents the setups click, so a setup that cannot run is a surface that
   * did not arrive and fails the run. The live walk passes `"skip"`: a running instance may simply
   * have no action file, no uncommitted edit or no plan, and that is a surface to name and skip
   * rather than a broken command. A surface that never arrives is fatal in either walk. */
  readonly setupFailure?: "fatal" | "skip";
};

/** What one surface's capture produced. `skipped` is a live walk's setup that had no content to
 * act on — the reason names what the instance lacks — not a failed surface. */
export type SurfaceCapture = {
  readonly path?: string;
  readonly findings: readonly Finding[];
  readonly skipped?: { readonly reason: string };
};

/** What the page still says it is loading, as `"text" (path)` per element: read after the wait
 * ran out, because the wait itself only knows that something is still there. Only what is drawn
 * counts — a placeholder in a view that is not on screen describes nothing a capture shows. */
const pendingPlaceholdersInPage = (arg: {
  readonly selector: string;
  readonly patterns: readonly PlaceholderPattern[];
}): string[] => {
  const pathOf = (element: Element): string => {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current !== null && current !== document.documentElement && parts.length < 3) {
      const classes = [...current.classList]
        .slice(0, 2)
        .map((name) => `.${name}`)
        .join("");
      parts.unshift(`${current.tagName.toLowerCase()}${classes}`);
      current = current.parentElement;
    }
    return parts.join(" > ");
  };
  const isLoading = (element: Element): boolean => {
    const text = (element.textContent ?? "").trim();
    return arg.patterns.some((pattern) => new RegExp(pattern.source, pattern.flags).test(text));
  };
  return [...document.querySelectorAll<HTMLElement>(arg.selector)]
    .filter((element) => element.getClientRects().length > 0 && isLoading(element))
    .map((element) => `"${(element.textContent ?? "").trim()}" (${pathOf(element)})`);
};

/** One element's box as the page reports it, with the path that names it in a finding. */
type ClippingProbe = ClippingBox & { readonly selector: string };

/** Every selector an entry may legitimately clip inside: the shell's own scroll containers plus
 * the ones the entry names. */
const exemptionsOf = (surface: Surface): string[] => [...SHELL_SCROLL, ...(surface.scroll ?? [])];

/** One descriptor per element whose content is larger than its box, with the selectors that are
 * allowed to. The geometry is decided in Node (`scripts/screen-clipping.ts`), which a browser is
 * not needed to test. */
const clippingProbesInPage = (exempt: readonly string[]): ClippingProbe[] => {
  const selectorOf = (element: Element): string => {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current !== null && current !== document.documentElement && parts.length < 4) {
      const tag = current.tagName.toLowerCase();
      const classes = [...current.classList]
        .slice(0, 2)
        .map((name) => `.${name}`)
        .join("");
      parts.unshift(`${tag}${classes}`);
      current = current.parentElement;
    }
    return parts.join(" > ");
  };
  const exemptOf = (element: Element): boolean => exempt.some((selector) => element.matches(selector));

  const probes: ClippingProbe[] = [];
  for (const element of document.querySelectorAll<HTMLElement>("body *")) {
    if (element.getClientRects().length === 0 || exemptOf(element)) continue;
    const style = getComputedStyle(element);
    const probe: ClippingProbe = {
      selector: selectorOf(element),
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      textOverflow: style.textOverflow,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      text: element.textContent ?? "",
    };
    if (probe.scrollWidth - probe.clientWidth <= 1 && probe.scrollHeight - probe.clientHeight <= 1) continue;
    probes.push(probe);
  }
  return probes;
};

/** Wait until the page has its data: no drawn placeholder still says it is loading. The elements
 * are the same three on every surface, and the text is the app's own placeholder (`loading…`, a
 * repository card's `N/M repositories loaded…`) rather than any text saying "loading" — a page
 * whose real content happens to contain the word is a loaded page, not a late one. A surface
 * whose widget still draws a placeholder is a surface captured too early, and the fixture's job
 * is to make the widget answer. The wait and the explanation after it test the same patterns, so
 * a timed-out wait names the element it was waiting on. */
const DATA_QUERY = { selector: LOADING_PLACEHOLDERS, patterns: LOADING_TEXTS } as const;

/** Whether a drawn placeholder still says its data is on the way. The wait's own predicate, in a
 * form that can be evaluated again after the layout settled: a subtree that re-renders can reopen
 * a placeholder the first wait already passed. */
const dataPendingInPage = (query: {
  readonly selector: string;
  readonly patterns: readonly PlaceholderPattern[];
}): boolean =>
  [...document.querySelectorAll<HTMLElement>(query.selector)].some(
    (element) =>
      element.getClientRects().length > 0 &&
      query.patterns.some((pattern) =>
        new RegExp(pattern.source, pattern.flags).test((element.textContent ?? "").trim()),
      ),
  );

const waitForData = async (page: Page): Promise<void> => {
  const timeout = budget(30_000);
  const arg = DATA_QUERY;
  try {
    await page.waitForFunction(
      (query: { readonly selector: string; readonly patterns: readonly PlaceholderPattern[] }): boolean =>
        [...document.querySelectorAll<HTMLElement>(query.selector)].every(
          (element) =>
            element.getClientRects().length === 0 ||
            !query.patterns.some((pattern) =>
              new RegExp(pattern.source, pattern.flags).test((element.textContent ?? "").trim()),
            ),
        ),
      arg,
      { timeout },
    );
  } catch (error) {
    // Only the wait running out is a page that is still loading; a page that went away is its own
    // failure and must not be reported as a placeholder.
    if (!(error instanceof Error && error.name === "TimeoutError")) throw error;
    const pending = await page.evaluate(pendingPlaceholdersInPage, arg).catch((): string[] => []);
    throw new Error(
      pending.length === 0
        ? `the page was still loading ${LOADING_PLACEHOLDERS} after ${timeout}ms`
        : `the page was still loading ${pending.join(", ")} after ${timeout}ms`,
    );
  }
};

/** Put the window and the content column back at the top: a page remembered mid-scroll would
 * otherwise be shot from wherever you left it. */
const scrollToTop = (page: Page): Promise<void> =>
  page.evaluate(() => {
    window.scrollTo(0, 0);
    const content = document.querySelector<HTMLElement>(".content");
    if (content !== null) content.scrollTo(0, 0);
  });

/** Park the pointer at one place on the surface, so the Dusk sky sits where it always does. */
const parkPointer = async (
  page: Page,
  viewport: { readonly width: number; readonly height: number },
): Promise<void> => {
  await page.mouse.move(Math.round(viewport.width / 2), Math.round(viewport.height / 2));
};

/** Paint the final layout rather than reuse the raster from the first one: a page that arrived
 * while its data was still coming can have text cached from an earlier layer, which rounds a
 * glyph's baseline differently from the same page built in one go. A display toggle lays the
 * whole document out again, so the capture is the state, not the path to it. */
const repaint = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const body = document.body;
    const display = body.style.display;
    body.style.display = "none";
    void body.offsetHeight;
    body.style.display = display;
  });

/** The browser of the capture in flight, so a signal's cleanup can close it instead of leaving a
 * renderer behind. */
let activeBrowser: Browser | undefined;

/** The browser of the capture in flight, if there is one, taken so two callers cannot close the
 * same one. The fixture walk's signal handler closes what it gets. */
export const takeActiveBrowser = (): Browser | undefined => {
  const browser = activeBrowser;
  activeBrowser = undefined;
  return browser;
};

/** A browser and its context for one capture: the environment that decides the pixels, one
 * renderer per capture so the same page never inherits the last one's raster or its cache, and
 * the walk's stubs when it has any. */
const openBrowser = async (
  surface: Surface,
  options: CaptureOptions,
): Promise<{ readonly browser: Browser; readonly context: BrowserContext }> => {
  const browser = await chromium.launch({
    headless: !options.headed,
    // Raster the whole frame: partial raster lets a capture take a tile that is still being
    // painted at another scale, which moves an antialiased edge by one level between runs.
    args: [
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-partial-raster",
    ],
  });
  const context = await browser.newContext({
    viewport: surface.viewport ?? VIEWPORT,
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  // The resting layout is what a capture shows: nothing animates and nothing transitions, from
  // the first document on.
  await context.addInitScript(() => {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        const style = document.createElement("style");
        style.textContent =
          "*, *::before, *::after { animation: none !important; transition: none !important; }";
        document.head.append(style);
      },
      { once: true },
    );
  });
  await options.stub?.(context);
  return { browser, context };
};

/** One capture of one surface from one origin. A failure is returned as its findings and an
 * absent path; the caller decides what that means for the surface's verdict. Base findings are
 * recorded but never fatal: the base is the thing compared against, and its own failure explains
 * a missing comparison rather than a defect in this branch. */
export const captureSurface = async (
  surface: Surface,
  index: number,
  options: CaptureOptions,
): Promise<SurfaceCapture> => {
  const pass = options.pass;
  const path = join(options.out, fileNameOf(index, surface));
  // The catalog writes its change pages against the fixture's change; a live walk addresses the
  // same page on the change its own instance lists.
  const route = routeOf(surface, options.change);
  const findings: Finding[] = [];
  const record = (kind: Finding["kind"], detail: string, fatal: boolean): void => {
    findings.push({ surface: surface.name, kind, detail, fatal: fatal && pass === "after", pass });
  };
  const opened = await openBrowser(surface, options);
  activeBrowser = opened.browser;
  const page = await opened.context.newPage();
  // Frozen, not installed: the pages poll, and a stopped clock stops the answers arriving.
  await page.clock.setFixedTime(options.now);
  page.on("console", (message) => {
    if (message.type() === "error") record("console-error", message.text(), true);
  });
  page.on("pageerror", (error) => record("page-error", error.message, true));
  // What the page's own reads have answered, for a setup that needs the answer rather than a row
  // (a listing with no files draws no row at all). Recorded from before the navigation, so an
  // answer that lands before the setup asks is not missed; a response counts once its body has
  // been read. `answered` compares the request's own pathname exactly (the query is ignored), so
  // a card's `/api/changes/<id>/summary` cannot satisfy the list's `/api/changes`, and resolves
  // with that read's body. It rejects at the walk's deadline if no such read comes.
  type FinishedRead = { readonly path: string; readonly body: Promise<string> };
  const finishedReads: FinishedRead[] = [];
  const reading = new Set<{ readonly path: string; readonly done: (body: string) => void }>();
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    const body = response
      .finished()
      .then(() => response.text())
      .catch(() => "");
    void body.then((text) => {
      finishedReads.push({ path, body: Promise.resolve(text) });
      for (const waiter of [...reading]) {
        if (waiter.path !== path) continue;
        reading.delete(waiter);
        waiter.done(text);
      }
    });
  });
  const answered = (path: string): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      const already = finishedReads.find((read) => read.path === path);
      if (already !== undefined) {
        void already.body.then(resolve);
        return;
      }
      const deadline = budget(30_000);
      const timer = setTimeout(() => {
        reading.delete(waiter);
        reject(new Error(`the page read no response for ${path} within ${deadline}ms`));
      }, deadline);
      const waiter = {
        path,
        done: (text: string): void => {
          clearTimeout(timer);
          resolve(text);
        },
      };
      reading.add(waiter);
    });
  // Which step of the capture is running, so a failure names what it was doing.
  let step: "arrival" | "setup" | "loading" | "settling" | "capture" = "arrival";
  try {
    // The theme is the surface's own, written for both origins before the navigation: the base
    // page is a second origin, and it must start in the same look as the current one.
    await opened.context.addCookies([
      { name: THEME_COOKIE, value: surface.theme ?? "dusk", url: options.origin },
      { name: THEME_COOKIE, value: surface.theme ?? "dusk", url: options.serverUrl },
    ]);
    await page.goto(`${options.origin}${route}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(surface.ready, { timeout: budget(30_000) });
    step = "setup";
    const context: SurfaceContext = {
      change: options.change,
      answered,
    };
    if (surface.setup !== undefined) await surface.setup(page, context);
    const settleForCapture = async (): Promise<void> => {
      step = "settling";
      await settleLayout(page);
      await repaint(page);
      await settleLayout(page);
      await scrollToTop(page);
      await parkPointer(page, surface.viewport ?? VIEWPORT);
    };
    step = "loading";
    await waitForData(page);
    await settleForCapture();
    // Data can land after the page arrived and re-render a subtree, reopening a placeholder the
    // first wait already passed — the overview's card remounts when the first availability answer
    // names a new generation. Re-check the same gate after settling, and wait again rather than
    // photograph the placeholder. The loop is bounded: a page that keeps reopening it is not a
    // stable picture, and saying so is better than photographing it.
    for (let attempt = 0; ; attempt++) {
      step = "loading";
      if (!(await page.evaluate(dataPendingInPage, DATA_QUERY))) break;
      if (attempt === 2)
        throw new Error(`the page reopened a loading placeholder after ${attempt + 1} data waits`);
      await waitForData(page);
      await settleForCapture();
    }
    step = "capture";
    await page.screenshot({ path, animations: "disabled", caret: "hide" });
    // Clipping is the current revision's finding: the base is a picture to compare against, and
    // its layout is not what a person is being asked to fix.
    if (pass === "after") {
      for (const probe of await page.evaluate(clippingProbesInPage, exemptionsOf(surface))) {
        for (const clipping of clippingOf(probe)) {
          record("clipped", describeClipping(probe.selector, clipping), false);
        }
      }
    }
    return { path, findings };
  } catch (error) {
    const reason = error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);
    // The live walk's setup is about content a running instance may not have. Skipping is not a
    // failure, and it leaves no `-failed.png`: the surface was never on screen to photograph.
    if (step === "setup" && options.setupFailure === "skip") {
      return { findings, skipped: { reason } };
    }
    // A page that is still loading is the same class of failure as one that never arrived: it is
    // not the picture the surface is about, and no baseline is needed to know it is wrong.
    if (step === "loading") record("still-loading", `${surface.name} on ${route}: ${reason}`, true);
    else
      record(
        "did-not-arrive",
        step === "arrival"
          ? `${surface.ready} on ${route} did not arrive: ${reason}`
          : `${step} failed on ${surface.name}: ${reason}`,
        true,
      );
    // What the page did show is evidence, under a name that cannot be read as the surface.
    if (step !== "capture") {
      await page
        .screenshot({ path: path.replace(/\.png$/, "-failed.png"), animations: "disabled", caret: "hide" })
        .catch(() => undefined);
    }
    return { findings };
  } finally {
    if (activeBrowser === opened.browser) activeBrowser = undefined;
    await opened.browser.close().catch(() => undefined);
  }
};
