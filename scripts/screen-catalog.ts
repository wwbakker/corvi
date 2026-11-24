/**
 * The surfaces Corvi shows, written down once.
 *
 * The list is explicit rather than derived from the routes: a page's states — the leader layer,
 * a dialog over the list, the narrow window's drawer, the same dashboard in another theme — are
 * surfaces a route walk cannot see. What keeps the list complete is the run itself
 * (`scripts/screens.ts` asks the server it started for its pages and change tabs and fatals on
 * anything without an entry) plus `test/screenCatalog.test.ts` for the cheap half: unique names,
 * every route a distinct view, every core change view covered.
 *
 * Plain data: no browser, no server, no fixture. `setup` runs against an already arrived page and
 * puts it in the state the entry is about; it is written for both the fixture walk
 * (`scripts/screens.ts`) and the live walk (`scripts/shot.ts`), so it may only use what the page
 * offers — no fixture ids beyond the change the runner hands it, and no direct HTTP. The theme is
 * not a setup step: it is a property, so the runner writes it before every navigation and no
 * entry can leave the browser changed for the next one.
 */
import type { Page } from "playwright";
import { isFinished, type Change } from "@corvi/changes/record";
import { budget } from "./timing.ts";
import type { ThemeId } from "../apps/web/src/domain/theme.ts";

/** Where the capture is running, and which change it is showing: the fixture's own in
 * `scripts/screens.ts`, the first change the instance lists for `scripts/shot.ts`. */
export type SurfaceContext = {
  /** The change whose pages are captured: `change-plan`, `change-dashboard` and its themes,
   * `change-leader` and `change-review` are about this one. */
  readonly change: string;
  /** Resolves with the body of the first response whose request path is exactly `path` (the query
   * is ignored), and rejects at the walk's deadline if none arrives. For the pages that draw
   * nothing while their read is in flight: a row that never comes because the instance has none is
   * an answer too, and this is how a setup waits for the answer rather than for the row. */
  readonly answered: (path: string) => Promise<string>;
};

/** One surface: a page at an address, the state it is meant to be seen in, and what says it is
 * there. */
export type Surface = {
  /** Kebab-case and stable: the image's name and the gallery's key. */
  readonly name: string;
  /** The path, relative to the server the run started. */
  readonly route: string;
  /** The selector that says the page has arrived, before `setup` puts it in its state. */
  readonly ready: string;
  /** Puts the page in the state this entry is about (the leader layer, a dialog, the drawer). */
  readonly setup?: (page: Page, context: SurfaceContext) => Promise<void>;
  /** The look the page wears, written into the theme cookie before the navigation. Defaults to
   * Dusk, the app's own default. */
  readonly theme?: ThemeId;
  /** A surface only a real instance has: a shell, a live target. The live walk (`scripts/shot.ts`)
   * captures it; the fixture walk (`scripts/screens.ts`) skips it and names it in its output, so
   * the skip is never silent. A `live` entry is never captured against a fixture, and therefore
   * never compared. */
  readonly live?: boolean;
  /** Containers this page legitimately scrolls. Content clipped inside one is not a finding. */
  readonly scroll?: readonly string[];
  /** Defaults to 1280x900. */
  readonly viewport?: { readonly width: number; readonly height: number };
};

/** The change the fixture creates and captures. Fixed, so the routes below are plain strings. */
export const CHANGE = "PROJ-SCREENS";

/** The second change, an idea: the overview's list then shows both an idea and work in progress. */
export const IDEA = "PROJ-SCREENS-IDEA";

/** The viewport every surface is captured at unless it names its own. */
export const VIEWPORT: { readonly width: number; readonly height: number } = { width: 1280, height: 900 };

/** The change's URL for one of its pages: the plan has no segment, the rest name themselves. */
export const changeRoute = (page: string): string =>
  `/changes/${encodeURIComponent(CHANGE)}${page === "plan" ? "" : `/${page}`}`;

/** The change route's own prefix, which is what marks an entry as being about a change. */
const CHANGE_PATH = `/changes/${encodeURIComponent(CHANGE)}`;

/** A surface's address on the instance being captured. The catalog's change entries are written
 * against the fixture's change; a live walk replaces that one segment with the change its own
 * instance lists, so both walks reach the same page by the same rule. */
export const routeOf = (surface: Surface, change: string): string =>
  surface.route === CHANGE_PATH || surface.route.startsWith(`${CHANGE_PATH}/`)
    ? `/changes/${encodeURIComponent(change)}${surface.route.slice(CHANGE_PATH.length)}`
    : surface.route;

/** Whether an entry is about a change, and so needs one on the instance being captured. */
export const isChangeSurface = (surface: Surface): boolean =>
  surface.route === CHANGE_PATH || surface.route.startsWith(`${CHANGE_PATH}/`);

/** The dashboard's arrival: its documents column has drawn the notes editor's text. */
const DASHBOARD_READY = ".column.documents .md-editor .cm-content";

/** The shell's own scroll containers, on every surface: the navigation column and the content
 * between the window's rows. An entry's `scroll` adds what its own page scrolls. */
export const SHELL_SCROLL: readonly string[] = [".sidebar", ".content", ".app-body"];

/** Where the page keeps the look it wears (`app-root/prefs.ts`): the runner writes each entry's
 * `theme` there before its navigation, in one place. */
export const THEME_COOKIE = "corvi:theme";

/** The elements the app draws a placeholder into while its data is on the way
 * (`app-root/app.tsx`, `change-page/client/ChangeView.tsx` and `CheckoutsCard.tsx`,
 * `dashboard/client/WidgetCard.tsx` and `PerRepoCard.tsx`). A placeholder is a settled box that
 * never moves, so `settleLayout` cannot tell one from real content — the text is the only thing
 * that says whether the page has its data. */
export const LOADING_PLACEHOLDERS = ".hint, .summary, .detail, .change-card .facts .fact";

/** The placeholder text the app actually draws in those elements: `loading…` and a repository
 * card's `N/M repositories loaded…`. Matched whole, not as a substring of `/loading/i`: that
 * would also fire on real content a page can carry — a pull request titled "Fix loading
 * spinner", a hint beginning "unloading…" — and hold a fully loaded page until it times out.
 * Anything else in these elements is content the surface is about, not a missing answer. */
const PLACEHOLDER_TEXTS: readonly RegExp[] = [
  /^loading…$/,
  /^\d+\/\d+ repositories loaded…$/,
  // The overview card's facts row before its own read answers (`app-root/ChangeCard.tsx`): one
  // ellipsis where the facts will read, so an ellipsis-only fact is an unloaded card.
  /^…$/,
];

/** A pattern in the form Playwright can hand to the page: a `RegExp` is not a serializable
 * argument, its source and flags are. */
export type PlaceholderPattern = { readonly source: string; readonly flags: string };

export const LOADING_TEXTS: readonly PlaceholderPattern[] = PLACEHOLDER_TEXTS.map(({ source, flags }) => ({
  source,
  flags,
}));

/** Whether a placeholder's text says its data has not arrived. Trims, because the placeholder is
 * an element's whole text and the markup may indent it. */
export const isLoadingPlaceholder = (text: string): boolean => {
  const trimmed = text.trim();
  return LOADING_TEXTS.some((pattern) => new RegExp(pattern.source, pattern.flags).test(trimmed));
};

/** The leader layer: Ctrl+Space lays a keycap on every control the page offers. */
const leaderLayer = async (page: Page): Promise<void> => {
  await page.keyboard.press("Control+Space");
  await page.waitForSelector(".leader-layer");
};

/** The overview's cards fetch their own summary after they are on screen; until it lands the
 * facts row holds a single ellipsis. A capture before that is a picture of the placeholder — and
 * a different picture from the same page a second later — so every surface that shows the
 * overview waits for each card's facts, loaded or legitimately empty.
 *
 * The changes list's answer is what makes the frame final: `changes` is undefined until it
 * lands, and the page says "loading…" for that, while an empty answer draws the same "no ideas
 * yet / nothing in progress" state as an instance that really has no changes. Waiting for that
 * answer (the capture's `answered`) before reading the cards is therefore what tells a
 * zero-change instance from an unread one: after it, a frame with no cards is the empty state
 * and is a picture. When the answer has cards, their facts are waited for too, so the capture is
 * never the placeholder ellipsis. */
const overviewLoaded = async (page: Page, context: SurfaceContext): Promise<void> => {
  const body = await context.answered("/api/changes");
  // How many cards the answer says the overview will draw. A finished change is listed but drawn
  // nowhere on this page, so it is not one of them. A body that cannot be read leaves the count at
  // zero: this wait is about the cards the list names, not about validating the server's shape.
  let expected = 0;
  try {
    const listed = JSON.parse(body) as unknown;
    if (Array.isArray(listed)) {
      expected = listed.filter((change) => {
        const record = change as { readonly state?: Change["state"]; readonly completedAt?: string | null };
        return !isFinished({ state: record.state, completedAt: record.completedAt ?? undefined });
      }).length;
    }
  } catch {
    expected = 0;
  }
  await page.waitForFunction(
    (cards: number) => {
      const loading = [...document.querySelectorAll(".hint")].some(
        (element) => (element.textContent ?? "").trim() === "loading…",
      );
      if (loading) return false;
      const drawn = [...document.querySelectorAll(".change-card")];
      // An empty list draws no card and is a picture; a non-empty one must have drawn its cards.
      // Without this, `every` over no cards is vacuously true — exactly the gap between the
      // list's answer and React's first paint, which the capture would photograph as a loading
      // frame.
      if (drawn.length < cards) return false;
      return drawn.every((card) =>
        [...card.querySelectorAll(".facts .fact")].every((fact) => (fact.textContent ?? "").trim() !== "…"),
      );
    },
    expected,
    { timeout: budget(30_000) },
  );
};

/** A frame, so a render queued by the answer that just landed has been committed before the
 * caller reads the DOM. Harmless when the answer had already drawn what is being waited for. */
const afterRender = (page: Page): Promise<void> =>
  page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

/**
 * The listing's answer, rows or none. The page's own root is what says the route is there, and
 * it is the same element in the revisions this catalog is walked against; what the listing adds
 * is rows. Those are waited for by the control every row carries rather than by the row's class:
 * `file-row` is markup a later revision introduced, and a readiness selector naming it would turn
 * a page that rendered fine into "failed on the base".
 *
 * A row is not the only answer, though: an instance with no file of that kind draws its empty
 * hints and never a row, which is the live walk's normal state on a fresh instance. So the page's
 * own read answering counts too — the capture watches the responses and hands the setup
 * `answered` — and whichever comes first is the listing having answered. The row wait stays first
 * because it is the revision-neutral one: a base whose endpoint this checkout no longer knows
 * still compares by the rows it draws.
 */
const listLoaded = async (
  page: Page,
  context: SurfaceContext,
  pageClass: string,
  filesPath: string,
): Promise<void> => {
  const rows = page
    .locator(`${pageClass} .widget`)
    .first()
    .getByRole("button", { name: "Edit" })
    .first()
    .waitFor();
  const answered = context.answered(filesPath);
  try {
    await Promise.race([rows, answered]);
  } finally {
    // The loser is not needed, and must not reject unhandled when its own deadline passes.
    rows.catch(() => undefined);
    answered.catch(() => undefined);
  }
  await afterRender(page);
};

export const SURFACES: readonly Surface[] = [
  {
    name: "overview",
    route: "/",
    // The page itself, not a card: an instance with no changes has no card, and its empty state
    // is still the overview. `overviewLoaded` waits for the list's answer before deciding which
    // of the two the frame is.
    ready: ".page",
    setup: overviewLoaded,
  },
  {
    name: "overview-leader",
    route: "/",
    ready: ".page",
    setup: async (page: Page, context: SurfaceContext): Promise<void> => {
      await overviewLoaded(page, context);
      await leaderLayer(page);
    },
  },
  {
    // The wizard one screen: the plan on the left, the sections on the right, each collapsed to
    // its pick. Body, not frame: the steps arrive with the wizard's own fetch.
    name: "new-change",
    route: "/new",
    ready: ".wizard-body",
  },
  {
    name: "actions",
    route: "/actions",
    ready: ".actions-page",
    setup: async (page: Page, context: SurfaceContext): Promise<void> => {
      await listLoaded(page, context, ".actions-page", "/api/actions/files");
    },
  },
  {
    // The create flow's template picker: Blank beside the built-ins, with a preview of the text a
    // copy carries.
    name: "actions-picker",
    route: "/actions",
    ready: ".actions-page",
    setup: async (page: Page, context: SurfaceContext): Promise<void> => {
      await listLoaded(page, context, ".actions-page", "/api/actions/files");
      await page.locator(".widget", { hasText: "Global" }).getByRole("button", { name: "New" }).click();
      await page.waitForSelector("dialog.template-picker");
      const builtin = page.locator(".template-choice").nth(1);
      if ((await builtin.count()) > 0) await builtin.click();
    },
  },
  {
    // The file in the editor's frame: the Markdown source with the fields' documentation beside
    // it.
    name: "action-editor",
    route: "/actions",
    ready: ".actions-page",
    setup: async (page: Page, context: SurfaceContext): Promise<void> => {
      await listLoaded(page, context, ".actions-page", "/api/actions/files");
      // The listing's answer can be "no files", which draws an empty section rather than a row.
      // That is content this instance does not have, not a page that failed to arrive; the live
      // walk turns this setup's failure into a named skip.
      const edits = page.locator(".actions-page .widget").getByRole("button", { name: "Edit" });
      if ((await edits.count()) === 0) throw new Error("the Actions page lists no file to edit");
      await edits.first().click();
      await page.waitForSelector(".actions-page.editing");
      await page.waitForSelector(".md-editor .cm-placeholder", { state: "detached" });
    },
  },
  {
    name: "harnesses",
    route: "/harnesses",
    ready: ".harnesses-page",
    setup: async (page: Page, context: SurfaceContext): Promise<void> => {
      await listLoaded(page, context, ".harnesses-page", "/api/harness-files");
    },
  },
  {
    name: "subagents",
    route: "/subagents",
    ready: ".subagents-page",
    setup: async (page: Page, context: SurfaceContext): Promise<void> => {
      await listLoaded(page, context, ".subagents-page", "/api/subagents/files");
    },
  },
  {
    name: "settings",
    route: "/settings",
    ready: ".settings-tree",
  },
  {
    // The directories no change owns. Arrival is the page itself, not a row: a changes root with
    // nothing left behind is the page's normal state, and the data wait (`waitForData`) is what
    // says its "loading…" has gone — replaced by the listing or by "nothing left behind".
    name: "leftovers",
    route: "/leftovers",
    ready: ".page",
  },
  {
    // The deployments table. Arrival is the page's own refresh control, not its rows: a live
    // instance without `az` configured shows the page's error, and that is the honest picture of
    // that instance. The data wait is what says the read has answered, and the fixture answers
    // it below (see `stubFixtureServices` in scripts/screens.ts), so the fixture's picture is the
    // table.
    name: "azure-devops",
    route: "/azure-devops",
    ready: ".page .refresh",
    scroll: [".table.deployments"],
  },
  {
    // The plan is the change's own document: its editor, filled from PLAN.md, in the tab a change
    // opens on.
    name: "change-plan",
    route: changeRoute("plan"),
    ready: ".plan-page .md-editor .cm-content",
    scroll: [".cm-scroller"],
    setup: async (page: Page, context: SurfaceContext): Promise<void> => {
      // The fixture writes a plan, so its placeholder detaches when the text arrives. An instance
      // with an empty plan keeps the placeholder, and that empty editor is the page. Wait for the
      // read's answer, then give a non-empty document a moment to render; whichever state the
      // editor is in after that is what this surface is.
      const placeholder = ".plan-page .md-editor .cm-placeholder";
      const answered = context.answered(`/api/changes/${encodeURIComponent(context.change)}/plan`);
      const detached = page.waitForSelector(placeholder, { state: "detached" });
      try {
        await Promise.race([answered, detached]);
      } finally {
        answered.catch(() => undefined);
        detached.catch(() => undefined);
      }
      await page
        .waitForSelector(placeholder, { state: "detached", timeout: budget(2_000) })
        .catch(() => undefined);
    },
  },
  {
    name: "change-dashboard",
    route: changeRoute("dashboard"),
    ready: DASHBOARD_READY,
    scroll: [".cm-scroller", ".column.status"],
  },
  {
    name: "change-dashboard-ultramarine",
    route: changeRoute("dashboard"),
    ready: DASHBOARD_READY,
    theme: "ultramarine",
    scroll: [".cm-scroller", ".column.status"],
  },
  {
    name: "change-dashboard-raven",
    route: changeRoute("dashboard"),
    ready: DASHBOARD_READY,
    theme: "raven",
    scroll: [".cm-scroller", ".column.status"],
  },
  {
    name: "change-dashboard-spaces",
    route: changeRoute("dashboard"),
    ready: DASHBOARD_READY,
    theme: "spaces",
    scroll: [".cm-scroller", ".column.status"],
  },
  {
    // The change's own row: the views, the terminal and its "+", then the title row's menus.
    name: "change-leader",
    route: changeRoute("dashboard"),
    ready: DASHBOARD_READY,
    setup: leaderLayer,
    scroll: [".cm-scroller", ".column.status"],
  },
  {
    // The local-changes pane: the files on the left, the diff of the selected one on the right.
    name: "change-review",
    route: changeRoute("review"),
    ready: ".local .files .group",
    scroll: [".local .files", ".local .diff-pane"],
    setup: async (page: Page, context: SurfaceContext): Promise<void> => {
      // A repository with a clean tree still gets its group and a "clean" state, so the pane has
      // arrived with no file to open. Wait for each repository's local-status read to answer, then
      // the absence of a row is the instance having no uncommitted work; the live walk skips it.
      await context.answered(`/api/ext/review/changes/${encodeURIComponent(context.change)}/local`);
      await page.waitForFunction(() => {
        const states = [...document.querySelectorAll(".local .files .group .state")];
        return states.length > 0 && states.every((state) => (state.textContent ?? "").trim() !== "…");
      });
      const files = page.locator(".local .files .file");
      if ((await files.count()) === 0) throw new Error("the change has no uncommitted file to review");
      await files.first().click();
      await page.waitForSelector(".local .diff-pane .diff .line");
    },
  },
  {
    // The navigation column as the drawer it becomes below 720px: 700 wide, because that is the
    // window width the CSS turns the column into an overlay at.
    name: "drawer",
    route: "/",
    ready: ".drawer-toggle",
    viewport: { width: 700, height: 700 },
    setup: async (page: Page, context: SurfaceContext): Promise<void> => {
      await overviewLoaded(page, context);
      await page.locator(".drawer-toggle").click();
      await page.waitForSelector(".sidebar.open");
    },
  },
  {
    // The change's terminal: a real shell on the host, which only a running instance has. A
    // fixture walk skips it: xterm's timing is the least deterministic thing in the app, and a
    // comparison is only worth the name when both pictures cancel.
    name: "change-terminal",
    // Attached, not merely drawn: the pane sets `data-attached` once the socket is open, and a
    // keystroke before that has nowhere to go — the echo would be lost and the capture would show
    // only the second command.
    route: changeRoute("terminals"),
    ready: ".terminal-screen[data-attached]",
    live: true,
    // Two harmless commands in the change's own checkout, so the capture shows a shell that has
    // answered rather than an empty screen. Nothing outside the checkout is touched.
    setup: async (page: Page): Promise<void> => {
      await page.locator(".terminal-screen").click();
      await page.keyboard.type("echo 'corvi terminal on a host session'");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(300);
      await page.keyboard.type("ls");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(400);
    },
    scroll: [".terminal-screen .xterm-viewport"],
  },
  {
    // Where the theme is chosen: the Appearance section of Settings. `live` because the section
    // is the settings tree's own state — a walk of a fixture would have to recreate it, and the
    // running instance has it.
    name: "settings-appearance",
    route: "/settings",
    ready: ".settings-tree",
    live: true,
    setup: async (page: Page): Promise<void> => {
      // The tree's leaf, matched exactly: the group above it is "Appearance & Behavior", and a
      // substring match would hit both.
      await page
        .locator(".settings-tree .node")
        .filter({ hasText: /^Appearance$/ })
        .click();
      await page.waitForSelector(".theme-choices");
    },
  },
];

/** The file name a surface is written under: `NN-<name>.png`, numbered in catalog order. */
export const fileNameOf = (index: number, surface: Surface): string =>
  `${String(index + 1).padStart(2, "0")}-${surface.name}.png`;
