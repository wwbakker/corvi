import { test, expect, beforeAll, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, type Locator, type Page } from "playwright";
import {
  budget,
  checkoutsOf,
  closePages,
  openEngine,
  runSh,
  serverEnv,
  settleLayout,
  stopRunHost,
  testTempDir,
  startTestServer,
  VIEWPORT,
  waitFor,
  withPage,
} from "./helpers.ts";
import { editorText, fillEditor } from "./editor.ts";
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
const usable = await openEngine((opened) => {
  browser = opened;
});

let tmp: string;
let url: string;
let server: ReturnType<typeof Bun.spawn>;
/** The fixture repository, so a change made inside a test can have a checkout to work in. */
let repoDir: string;
const id = "PROJ-PAGES";
/** A second change, for the page states that only differ once you leave one: the switch from one
 * change to another is where a widget's state has to follow the change. */
const other = "PROJ-PAGES-2";

beforeAll(async () => {
  if (!usable) return;
  tmp = await testTempDir("pages");
  const repo = join(tmp, "example-api");
  repoDir = repo;
  await runSh(["git", "init", "-b", "main", repo]);
  await Bun.write(join(repo, "README.md"), "example-api\n");
  await runSh(["git", "add", "."], repo);
  await runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], repo);

  // serverEnv gives the file its own changes, config, page build and cache, and
  // port 0: the OS picks a free one, so parallel workers never collide. Readiness is the
  // server's own `corvi on <url>` line.
  ({ server, url } = await startTestServer(tmp, { env: { CORVI_REPOSITORIES_DIRECTORY: tmp } }));
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
  // Whatever pages a failed test left open are screenshotted for CI's failure artifacts first.
  await closePages(browser, "pages");
  await browser?.close();
  server?.kill();
  await server?.exited;
  // The terminal host outlives its server by design: a test that opened windows ends it here.
  await stopRunHost(tmp);
  await rm(tmp, { recursive: true, force: true });
});

/** Open a page and hand back whatever the engine objected to. */
async function open(path: string, ready: string): Promise<string[]> {
  return withPage(
    browser,
    async (page) => {
      const complaints: string[] = [];
      page.on("pageerror", (e) => complaints.push(`${path}: ${e.message}`));
      page.on("console", (m) => m.type() === "error" && complaints.push(`${path}: ${m.text()}`));
      // Not networkidle: the pages poll, so there is no idle moment to wait for.
      await page.goto(`${url}${path}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(ready, { timeout: 15_000 });
      await page.waitForTimeout(500); // long enough for the first round of requests to come back
      return complaints;
    },
    VIEWPORT,
  );
}

/** Write one change's notes through the extension's own route, the way the card does. */
const writeNotes = (change: string, text: string): Promise<Response> =>
  fetch(`${url}/api/ext/notes/changes/${change}/notes`, {
    method: "PUT",
    body: JSON.stringify({ text }),
  });

/** The settings tree's row for one section, by its label. */
const settingsNode = (page: Page, label: string): Locator =>
  page.locator(".settings-tree").getByRole("button", { name: label, exact: true });

/** Make one unsaved edit on the open settings page: the Jira transition, filled and not saved. */
const editField = async (page: Page, value: string): Promise<void> => {
  await settingsNode(page, "Jira").click();
  await page.getByLabel("Transition on completing one").fill(value);
};

/** Open the settings page and make one unsaved edit on it. */
async function editSettings(page: Page, value: string): Promise<void> {
  await page.goto(`${url}/settings`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".settings-tree");
  await editField(page, value);
}

test.skipIf(!usable)(
  "every page renders without the engine complaining",
  async () => {
    const pages: [string, string][] = [
      ["/", ".change-card"],
      ["/new", ".wizard"],
      ["/azure-devops", ".page"],
      ["/settings", ".settings-tree"],
      ["/actions", ".actions-page"],
      [`/changes/${id}`, ".plan-page"],
      [`/changes/${id}/dashboard`, ".widget"],
      [`/changes/${id}/plan`, ".plan-page"],
      [`/changes/${id}/review`, ".local"],
    ];

    const complaints: string[] = [];
    for (const [path, ready] of pages) complaints.push(...(await open(path, ready)));
    expect(complaints).toEqual([]);
  },
  120_000,
);

test.skipIf(!usable)(
  "the azure-devops page reads live on arrival, and a deploying cell shows its progress",
  async () => {
    await withPage(
      browser,
      async (page) => {
        const started = new Date(Date.now() - 3 * 60_000).toISOString();
        // One service deploying on accept with a known typical duration, one settled: the two cells the
        // page has to tell apart. Answered here rather than by the server, so the test needs no Azure
        // DevOps login.
        const fixture = {
          services: [
            {
              name: "example-api",
              pipeline: { id: 1, name: "deploy-example-api" },
              build: { id: 2, name: "build-example-api" },
              environments: [
                {
                  environment: "accept",
                  version: "20261109.4",
                  at: started,
                  state: "pending",
                  detail: "deploying 20261109.4",
                  url: "https://dev.azure.com/example/proj/_build/results?buildId=9",
                  expectedMs: 10 * 60_000,
                },
              ],
            },
            {
              name: "example-service",
              pipeline: { id: 3, name: "deploy-example-service" },
              build: { id: 4, name: "build-example-service" },
              environments: [
                {
                  environment: "accept",
                  version: "20261109.1",
                  at: "2026-11-09T08:10:00Z",
                  state: "ok",
                  detail: "3h ago",
                  url: "https://dev.azure.com/example/proj/_build/results?buildId=7",
                },
              ],
            },
          ],
        };

        // Every read the page asks for, and whether the first answer had already landed when it was
        // asked: everything asked before that is the arrival, and has to be the live read.
        const asked: { search: string; beforeFirstAnswer: boolean }[] = [];
        let answered = false;
        // Set when a read has to still be in flight a moment later, so its state can be read.
        let hold = false;
        await page.route("**/api/ext/azure-devops/services*", async (route) => {
          asked.push({ search: new URL(route.request().url()).search, beforeFirstAnswer: !answered });
          if (hold) await new Promise((resolve) => setTimeout(resolve, 1500));
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(fixture),
          });
          answered = true;
        });

        await page.goto(`${url}/azure-devops`, { waitUntil: "domcontentloaded" });
        const refresh = page.locator('button[aria-label="Refresh"]');
        await refresh.waitFor();

        // The control is named, so it is reachable without seeing it — the icon is the only label. It
        // says a read is in flight with `aria-disabled`, which keeps the focus and the tooltip.
        // Waiting on the tooltip, not on `aria-disabled`: that reads "false" from first paint, because
        // the first load never marks, so it would race the answer.
        await page.waitForFunction(
          () =>
            document
              .querySelector('button[aria-label="Refresh"]')
              ?.getAttribute("title")
              ?.startsWith("updated ") ?? false,
          undefined,
          { timeout: 20_000 },
        );
        expect(await refresh.getAttribute("title")).toMatch(
          /^updated (\d+s|\d+m\d+s) ago · refreshing every /,
        );
        expect(await refresh.getAttribute("aria-disabled")).toBe("false");

        // Arriving is the moment you want the truth: every read asked for before the first answer
        // landed is the live one. (StrictMode puts two mounts through the effect; the one that survives
        // has to be it.)
        expect(asked.length).toBeGreaterThan(0);
        expect(asked.filter((a) => a.beforeFirstAnswer).every((a) => a.search.includes("refresh=1"))).toBe(
          true,
        );

        // The answer had a deploying environment, so the cadence flipped and the effect restarted: the
        // read that follows is a tick, and must not be live — otherwise every tick is a live read.
        for (let i = 0; i < 50 && asked.length < 2; i++) await page.waitForTimeout(100);
        expect(asked.length).toBeGreaterThanOrEqual(2);
        expect(asked[1]!.search).not.toContain("refresh=1");

        // The deploying environment draws the shared bar; the settled one has nothing to draw.
        const pending = page.locator("tbody tr", { hasText: "example-api" });
        const settled = page.locator("tbody tr", { hasText: "example-service" });
        expect(await pending.locator(".progress").count()).toBe(1);
        expect(await settled.locator(".progress").count()).toBe(0);

        // Its numbers are the bar's accessible name — a narrow cell hides the elapsed text, and a screen
        // reader must not lose the numbers with it.
        const bar = pending.getByRole("img", { name: /elapsed/ });
        expect(await bar.count()).toBe(1);
        expect(await bar.getAttribute("aria-label")).toMatch(/^\d+m\d+s elapsed, typically 10m00s$/);

        // And the bar costs no height: the two rows are the same size.
        const heights = await page
          .locator("tbody tr")
          .evaluateAll((rows) => rows.map((r) => Math.round(r.getBoundingClientRect().height)));
        expect(heights).toHaveLength(2);
        expect(heights[0]).toBe(heights[1]);

        // Reduced motion is honoured, not merely declared: a held read makes the spin visible, and with
        // the preference set there is nothing turning while it is in flight.
        hold = true;
        await page.emulateMedia({ reducedMotion: "reduce" });
        await refresh.click();
        await page.waitForFunction(
          () =>
            document.querySelector('button[aria-label="Refresh"]')?.getAttribute("aria-disabled") === "true",
        );
        expect(await refresh.locator("svg").evaluate((svg) => getComputedStyle(svg).animationName)).toBe(
          "none",
        );
        // And the converse, against the same flight: with the preference off the arrow does turn, so the
        // rule itself is pinned and not only its absence. Deleting the spin fails here.
        await page.emulateMedia({ reducedMotion: "no-preference" });
        expect(await refresh.locator("svg").evaluate((svg) => getComputedStyle(svg).animationName)).toBe(
          "refresh-spin",
        );
        // Let the held read finish, so the page is quiet before it closes.
        hold = false;
        await page.waitForFunction(
          () =>
            document.querySelector('button[aria-label="Refresh"]')?.getAttribute("aria-disabled") === "false",
          undefined,
          { timeout: 20_000 },
        );
        await page.emulateMedia({ reducedMotion: "no-preference" });
      },
      VIEWPORT,
    );
  },
  60_000,
);

/** The deployments page's answer, as the server would give it: one service, settled on accept. */
const settledService = {
  services: [
    {
      name: "example-api",
      pipeline: { id: 1, name: "deploy-example-api" },
      build: { id: 2, name: "build-example-api" },
      environments: [
        {
          environment: "accept",
          version: "20261109.4",
          at: "2026-11-09T08:10:00Z",
          state: "ok",
          detail: "3h ago",
        },
      ],
    },
  ],
};

/** What the dialog is offered: a build still running, and one that finished. */
const offeredBuilds = (options: { building: boolean }): unknown[] => [
  {
    runId: 2,
    buildNumber: "b2",
    branch: "main",
    deployedTo: [],
    ...(options.building
      ? {
          running: true,
          startedAt: "2026-11-09T09:00:00Z",
          expectedMs: 10 * 60_000,
        }
      : { version: "20261109.5", finishedAt: "2026-11-09T09:04:00Z" }),
  },
  {
    runId: 1,
    buildNumber: "b1",
    version: "20261109.4",
    branch: "main",
    finishedAt: "2026-11-09T08:10:00Z",
    deployedTo: ["accept"],
  },
];

/** Open the deploy dialog against the stubbed routes, and record every versions read it makes.
 * The clock is Playwright's, so the ten-second watch can be walked forward instead of waited for. */
async function openDeployDialog(options: { building: boolean }): Promise<{
  page: Page;
  asked: () => string[];
  setBuilding: (building: boolean) => void;
  /** Fail the versions reads that come next, so a tick's failure can be seen and recovered from. */
  setFailing: (failing: boolean) => void;
  /** Hold the next versions answer until the returned function is called, so a read can be caught
   * in flight. */
  holdNext: () => () => void;
}> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  await page.clock.install();
  let building = options.building;
  let failing = false;
  let held: { promise: Promise<void>; release: () => void } | null = null;
  const reads: string[] = [];
  await page.route("**/api/ext/azure-devops/**", async (route) => {
    const requested = new URL(route.request().url());
    const versions = requested.pathname.endsWith("/versions");
    if (versions) reads.push(requested.search);
    if (held) await held.promise;
    // Fulfilling a request the dialog has already cancelled is not an error worth failing on.
    await route
      .fulfill(
        versions && failing
          ? {
              status: 500,
              contentType: "application/json",
              body: JSON.stringify({ error: "azure is down" }),
            }
          : {
              status: 200,
              contentType: "application/json",
              body: JSON.stringify(versions ? offeredBuilds({ building }) : settledService),
            },
      )
      .catch(() => undefined);
  });
  await page.goto(`${url}/azure-devops`, { waitUntil: "domcontentloaded" });
  // The page's first read is deferred by a task, which a fake clock only runs when walked forward.
  await page.clock.runFor(100);
  await page.waitForSelector(".table.deployments");
  await page.getByRole("button", { name: "Deploy…" }).click();
  await page.waitForSelector("dialog[open] .versions");
  const holdNext = (): (() => void) => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => (release = resolve));
    held = {
      promise,
      release: () => {
        held = null;
        release();
      },
    };
    return () => held?.release();
  };
  return {
    page,
    asked: () => reads,
    setBuilding: (next) => (building = next),
    setFailing: (next) => (failing = next),
    holdNext,
  };
}

/** Wait (in test time, which the page's fake clock does not touch) until a read has left the page. */
async function untilReads(get: () => string[], count: number): Promise<void> {
  for (let i = 0; i < 100 && get().length < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(get()).toHaveLength(count);
}

/** Give a read that should not happen room to arrive, and then say that it did not: a request the
 * page fires is on the wire a moment after the clock has moved, not in the same tick. */
async function noMoreReads(get: () => string[], count: number): Promise<void> {
  for (let i = 0; i < 20 && get().length === count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(get()).toHaveLength(count);
}

test.skipIf(!usable)(
  "the deploy dialog reads live when it opens, and watches a running build",
  async () => {
    const { page, asked, setBuilding } = await openDeployDialog({ building: true });
    try {
      // The open is live: the row you clicked is old, and this is the decision. One read, and it is
      // the live one.
      expect(asked()).toEqual(["?refresh=1"]);
      // The running build is shown with its progress bar, and cannot be picked yet — there is no
      // version to pick. The one that finished can be.
      const building = page.locator("dialog[open] .versions .pick.building");
      expect(await building.count()).toBe(1);
      expect(await building.locator(".progress").count()).toBe(1);
      expect(await building.locator('input[name="version"]').isDisabled()).toBe(true);
      const finished = page.locator("dialog[open] .versions .pick").filter({ hasText: "20261109.4" });
      expect(await finished.locator('input[name="version"]').isDisabled()).toBe(false);
      expect(await page.locator('dialog[open] input[name="version"]:checked').count()).toBe(1);

      // The watch is ten seconds, not sooner: nine seconds on, nothing has been asked.
      setBuilding(false);
      await page.clock.fastForward(9_000);
      await noMoreReads(asked, 1);

      // The tenth second asks again, live, and the build that finished gains its version.
      await page.clock.fastForward(1_000);
      await page.getByText("20261109.5").waitFor();
      expect(asked()).toEqual(["?refresh=1", "?refresh=1"]);
      // A tick replaces the rows and nothing else: what was picked is still picked.
      const picked = page.locator('dialog[open] input[name="version"]:checked');
      expect(await picked.count()).toBe(1);
      expect(await picked.evaluate((input) => input.parentElement?.textContent ?? "")).toContain(
        "20261109.4",
      );

      // Nothing is running any more, so the watch has stopped: closing and waiting changes nothing.
      await page.getByRole("button", { name: "Cancel" }).click();
      await page.waitForSelector("dialog[open]", { state: "hidden" });
      await page.clock.fastForward(30_000);
      await noMoreReads(asked, 2);
    } finally {
      await page.close();
    }
  },
  60_000,
);

test.skipIf(!usable)(
  "closing the dialog while a build is running stops the watching",
  async () => {
    const { page, asked } = await openDeployDialog({ building: true });
    try {
      expect(asked()).toEqual(["?refresh=1"]);

      // Cancel before any tick: the watch must go with the dialog, not keep reading behind it.
      await page.getByRole("button", { name: "Cancel" }).click();
      await page.waitForSelector("dialog[open]", { state: "hidden" });
      await page.clock.fastForward(30_000);
      await noMoreReads(asked, 1);
    } finally {
      await page.close();
    }
  },
  60_000,
);

test.skipIf(!usable)(
  "a read in flight when the dialog closes is dropped, and reopening reads again",
  async () => {
    const { page, asked, holdNext } = await openDeployDialog({ building: true });
    try {
      expect(asked()).toEqual(["?refresh=1"]);

      // A tick, caught in the route before it answers, and the dialog closed while it is out.
      const release = holdNext();
      await page.clock.fastForward(10_000);
      await untilReads(asked, 2);
      await page.getByRole("button", { name: "Cancel" }).click();
      await page.waitForSelector("dialog[open]", { state: "hidden" });
      release();
      await page.clock.fastForward(30_000);
      // The abandoned answer lands on nothing, and the stopped watch asks nothing more.
      await noMoreReads(asked, 2);

      // Reopening is a fresh decision, so it reads again — live.
      await page.getByRole("button", { name: "Deploy…" }).click();
      await page.waitForSelector("dialog[open] .versions");
      await untilReads(asked, 3);
      expect(asked()[2]).toBe("?refresh=1");
    } finally {
      await page.close();
    }
  },
  60_000,
);

test.skipIf(!usable)(
  "a failed tick says so, and the next good one takes it back",
  async () => {
    const { page, asked, setFailing } = await openDeployDialog({ building: true });
    try {
      setFailing(true);
      await page.clock.fastForward(10_000);
      await untilReads(asked, 2);
      await page.getByText("azure is down").waitFor();

      // The list recovers, and the banner belongs to the read that failed: it goes with it, or the
      // dialog keeps accusing a list that is fine.
      setFailing(false);
      await page.clock.fastForward(10_000);
      await untilReads(asked, 3);
      await page.locator("dialog[open] .error-banner").waitFor({ state: "hidden" });
    } finally {
      await page.close();
    }
  },
  60_000,
);

test.skipIf(!usable)(
  "a deploy dialog with nothing running reads once",
  async () => {
    const { page, asked } = await openDeployDialog({ building: false });
    try {
      expect(asked()).toEqual(["?refresh=1"]);

      // The open is the only read: a list of finished builds cannot change while you look at it.
      await page.clock.fastForward(10_000);
      await page.clock.fastForward(10_000);
      await noMoreReads(asked, 1);
    } finally {
      await page.close();
    }
  },
  60_000,
);

test.skipIf(!usable)(
  "the cards offer their editors, and a finished change offers none",
  async () => {
    const page = await browser.newPage({ viewport: VIEWPORT });
    try {
      await page.goto(`${url}/changes/${id}/dashboard`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".widget");

      // The three cards that own something editable: the repository list and the two ticket links.
      await page.waitForSelector('button[title="Edit Local changes"]');
      expect(await page.locator('button[title="Edit Jira"]').count()).toBe(1);
      expect(await page.locator('button[title="Edit GitHub issues"]').count()).toBe(1);

      // The editor opens over its picker, and Escape closes it again.
      await page.locator('button[title="Edit Jira"]').click();
      await page.waitForSelector("dialog[open] .issues");
      await page.keyboard.press("Escape");
      await page.waitForSelector("dialog[open]", { state: "hidden" });
    } finally {
      await page.close();
    }

    // A finished change is a record: nothing on its page offers an edit.
    const done = "PROJ-PAGES-DONE";
    const created = await fetch(`${url}/api/changes`, {
      method: "POST",
      body: JSON.stringify({ id: done, checkouts: [], state: "Ideation" }),
    });
    expect(created.ok).toBe(true);
    const cancelled = await fetch(`${url}/api/changes/${done}/cancel`, {
      method: "POST",
      body: JSON.stringify({ force: true }),
    });
    expect(cancelled.ok).toBe(true);
    const closed = await browser.newPage({ viewport: VIEWPORT });
    await closed.goto(`${url}/changes/${done}/dashboard`, { waitUntil: "domcontentloaded" });
    await closed.waitForSelector(".widget");
    expect(await closed.locator('button[title^="Edit "]').count()).toBe(0);
    await closed.close();
  },
  120_000,
);

test.skipIf(!usable)(
  "the settings page reads and writes",
  async () => {
    // The page whose failure mode is a sentence about nothing: /api/settings answering with the
    // app's own HTML, parsed as JSON.
    const page = await browser.newPage({ viewport: VIEWPORT });
    try {
      await page.goto(`${url}/settings`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".settings-tree");
      expect(await page.locator(".error-banner").count()).toBe(0);

      // One section at a time: the page opens on Locations, and the Jira field is not there
      // until its row in the tree is chosen. The scope bar (Global and the workspaces) sits
      // inside the detail view, above the fields.
      expect((await page.locator(".settings-detail .breadcrumb").innerText()).trim()).toBe(
        "Workspace \u203a Locations",
      );
      expect(await page.getByLabel("Transition on completing one").count()).toBe(0);

      // The extension's settings are on its own tree row now, so the page has to be asked for it.
      await settingsNode(page, "Jira").click();
      await page.getByLabel("Transition on completing one").fill("Ready for release");
      await page.getByRole("button", { name: "Save" }).click();
      await page.waitForSelector(".hint.saved", { timeout: 10_000 });

      // The window's own section, whose one setting so far is the right-click menu: taking it away is
      // the decision that gets written down, since a menu is the default.
      const box = page.getByLabel("Right-click menu");
      await settingsNode(page, "Window").click();
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
    } finally {
      await page.close();
    }

    const written = (await fetch(`${url}/api/settings`).then((r) => r.json())) as {
      file: { extensionSettings?: { jira?: { doneTransition?: string } }; contextMenu?: boolean };
      effective: { contextMenu: boolean };
    };
    // The Jira fields are the extension's own now, stored under its name rather than as
    // top-level config keys.
    expect(written.file.extensionSettings?.jira?.doneTransition).toBe("Ready for release");
    expect(written.file.contextMenu).toBe(true);
    expect(written.effective.contextMenu).toBe(true);
  },
  60_000,
);

test.skipIf(!usable)(
  "leaving settings with unsaved edits asks first",
  async () => {
    // The draft is the page's until Save, so leaving would take it with it — unless the question
    // is answered first (docs/manual/configuration.md). Stay keeps the edit where it is, Discard
    // leaves without writing it, Save and leave writes it on the way out.
    const file = async (): Promise<Record<string, unknown>> =>
      (
        (await fetch(`${url}/api/settings`).then((r) => r.json())) as {
          file: Record<string, unknown>;
        }
      ).file;
    const before = await file();

    return withPage(
      browser,
      async (page) => {
        // The prompt by its own words: the directory fields keep their pickers in the DOM, closed.
        const prompt = page.locator("dialog", { hasText: "Unsaved settings" });
        await editSettings(page, "typed and left behind");

        // Stay: asked, and nothing else happens.
        await page.getByRole("button", { name: "Changes", exact: true }).click();
        await prompt.waitFor();
        expect(new URL(page.url()).pathname).toBe("/settings");
        await page.getByRole("button", { name: "Stay", exact: true }).click();
        await prompt.waitFor({ state: "detached" });
        expect(new URL(page.url()).pathname).toBe("/settings");
        expect(await page.getByLabel("Transition on completing one").inputValue()).toBe(
          "typed and left behind",
        );

        // Discard and leave: the overview shows, and the file never saw the edit.
        await page.getByRole("button", { name: "Changes", exact: true }).click();
        await prompt.waitFor();
        await page.getByRole("button", { name: "Discard and leave", exact: true }).click();
        await page.waitForFunction(() => location.pathname === "/");
        await page.locator(".change-card").first().waitFor();
        expect(await file()).toEqual(before);

        // Save and leave: the same question, and the edit is written on the way out.
        await editSettings(page, "saved past the guard");
        await page.getByRole("button", { name: "Changes", exact: true }).click();
        await prompt.waitFor();
        await page.getByRole("button", { name: "Save and leave", exact: true }).click();
        await page.waitForFunction(() => location.pathname === "/");
        await page.locator(".change-card").first().waitFor();
        const written = (await fetch(`${url}/api/settings`).then((r) => r.json())) as {
          file: { extensionSettings?: { jira?: { doneTransition?: string } } };
        };
        expect(written.file.extensionSettings?.jira?.doneTransition).toBe("saved past the guard");
      },
      VIEWPORT,
    );
  },
  30_000,
);

test.skipIf(!usable)(
  "the guard holds Back too, and leaves the history usable",
  async () => {
    // Back is the likeliest accidental exit, so it gets the same question — with the settings URL
    // put back while the answer is pending, so the address bar and the page never disagree. After
    // answering, Back and Forward still walk the history in both directions: the guard's restore
    // strands no entry.
    await withPage(
      browser,
      async (page) => {
        await page.goto(`${url}/settings`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(".settings-tree");
        // A clean visit away and back first, so Back has somewhere to go.
        await page.getByRole("button", { name: "Changes", exact: true }).click();
        await page.waitForFunction(() => location.pathname === "/");
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await page.waitForFunction(() => location.pathname === "/settings");
        await page.waitForSelector(".settings-tree");
        await editField(page, "typed and left behind");

        await page.goBack();
        // The prompt by its own words: the directory fields keep their pickers in the DOM, closed.
        const prompt = page.locator("dialog", { hasText: "Unsaved settings" });
        await prompt.waitFor();
        expect(new URL(page.url()).pathname).toBe("/settings");
        await page.getByRole("button", { name: "Discard and leave", exact: true }).click();
        await page.waitForFunction(() => location.pathname === "/");

        // Back to the settings the guard put back — a fresh page, clean, no question — and Forward to
        // where the answer left off.
        await page.goBack();
        await page.waitForFunction(() => location.pathname === "/settings");
        await page.waitForSelector(".settings-tree");
        expect(await prompt.count()).toBe(0);
        await page.goForward();
        await page.waitForFunction(() => location.pathname === "/");
        expect(await prompt.count()).toBe(0);
      },
      VIEWPORT,
    );
  },
  30_000,
);

test.skipIf(!usable)(
  "a save that fails keeps you there with the draft",
  async () => {
    // Save and leave runs the page's own save, so its failure is the page's own: the dialog
    // closes, the error banner explains, and the draft is still there to retry or to leave.
    await withPage(
      browser,
      async (page) => {
        await page.route(
          (u) => u.pathname === "/api/settings",
          async (route) => {
            if (route.request().method() === "PUT") {
              await route.fulfill({
                status: 500,
                contentType: "application/json",
                body: JSON.stringify({ error: "the disk is full" }),
              });
              return;
            }
            await route.continue();
          },
        );
        await editSettings(page, "kept when the save fails");
        await page.getByRole("button", { name: "Changes", exact: true }).click();
        // The prompt by its own words: the directory fields keep their pickers in the DOM, closed.
        const prompt = page.locator("dialog", { hasText: "Unsaved settings" });
        await prompt.waitFor();
        await page.getByRole("button", { name: "Save and leave", exact: true }).click();
        await prompt.waitFor({ state: "detached" });
        expect(new URL(page.url()).pathname).toBe("/settings");
        expect(await page.getByLabel("Transition on completing one").inputValue()).toBe(
          "kept when the save fails",
        );
        expect((await page.locator(".error-banner").innerText()).trim()).toContain("the disk is full");
      },
      VIEWPORT,
    );
  },
  30_000,
);

test.skipIf(!usable)(
  "the unsaved marker does not resize the notes card",
  async () => {
    // The marker sits in the heading's flex line and comes and goes as you type, so any size or
    // margin it contributes changes the height of the heading — and of what the card contains —
    // on every keystroke. It must be smaller than the title and take no space of its own. The
    // card's outer height is the dashboard column's leftover (it is the last card, and grows to
    // fill), so the boxes measured are the ones the marker can move: the heading and the editor.
    await withPage(
      browser,
      async (page) => {
        await page.goto(`${url}/changes/${id}/dashboard`, { waitUntil: "domcontentloaded" });
        const card = page.locator(".widget:has(.md-editor)");
        await card.waitFor();
        const heading = card.locator("h3");
        const editor = card.locator(".md-editor");
        await editor.locator(".cm-content").waitFor();
        // A sibling card's first read, or the bundled font, can settle after the card appears;
        // measuring the marker against that would be measuring the page, not the marker.
        await settleLayout(page);
        const headingHeight = (): Promise<number> =>
          heading.evaluate((h) => h.getBoundingClientRect().height);
        const editorHeight = (): Promise<number> =>
          editor.evaluate((section) => section.getBoundingClientRect().height);

        const before = { heading: await headingHeight(), editor: await editorHeight() };
        await fillEditor(editor, "a note");
        await card.locator("h3 .summary", { hasText: "unsaved" }).waitFor();
        await settleLayout(page);

        expect(await headingHeight()).toBe(before.heading);
        expect(await editorHeight()).toBe(before.editor);
        const sizes = await heading.evaluate((h) => ({
          title: parseFloat(getComputedStyle(h).fontSize),
          marker: parseFloat(getComputedStyle(h.querySelector(".summary")!).fontSize),
        }));
        expect(sizes.marker).toBeLessThan(sizes.title);
      },
      VIEWPORT,
    );
  },
  30_000,
);

test.skipIf(!usable)(
  "the notes editor is still yours to resize",
  async () => {
    // The textarea it replaced had a resize grip, and a long note deserves more than one fixed
    // window: the corner drags the box taller and the text scrolls inside it.
    await withPage(
      browser,
      async (page) => {
        await page.goto(`${url}/changes/${id}/dashboard`, { waitUntil: "domcontentloaded" });
        const editor = page.locator(".widget:has(.md-editor) .md-editor");
        await editor.waitFor();
        const before = await editor.boundingBox();
        if (!before) throw new Error("the notes editor did not lay out");
        await page.mouse.move(before.x + before.width - 1, before.y + before.height - 1);
        await page.mouse.down();
        await page.mouse.move(before.x + before.width - 1, before.y + before.height + 80, { steps: 5 });
        await page.mouse.up();
        const after = await editor.boundingBox();
        if (!after) throw new Error("the notes editor went away");
        expect(after.height).toBeGreaterThan(before.height + 40);
      },
      VIEWPORT,
    );
  },
  30_000,
);
test.skipIf(!usable)(
  "the documents sit left of the status cards",
  async () => {
    // The dashboard's two regions: the change's documents (notes and any document widget) on the
    // left, the status cards on the right — the plan is a tab of its own now. At this width both
    // are present, so the grid has two columns and
    // the status region starts where the documents end.
    await withPage(
      browser,
      async (page) => {
        await page.goto(`${url}/changes/${id}/dashboard`, { waitUntil: "domcontentloaded" });
        const documents = page.locator(".column.documents");
        await documents.locator(".md-editor").waitFor();
        const status = page.locator(".column.status");
        await status.locator(".widget").first().waitFor();
        expect(await status.locator(".widget").count()).toBeGreaterThan(0);

        const docBox = await documents.boundingBox();
        const statusBox = await status.boundingBox();
        if (!docBox || !statusBox) throw new Error("the dashboard's columns did not lay out");
        expect(statusBox.x).toBeGreaterThanOrEqual(docBox.x + docBox.width);
      },
      { width: 1440, height: 900 },
    );
  },
  30_000,
);

test.skipIf(!usable)(
  "a long ticket title wraps inside its card, and an identity label stays whole",
  async () => {
    // A ticket row's label is prose — Jira's `PROJ-123 <summary>`, GitHub's `#123 <title>` — in a row
    // whose label was styled for an identifier. It must wrap rather than widen the card. Beside it,
    // a shipped identity row (a repository name beside its long status and path) must keep its label
    // on one line: the detail may never take the label's line away. The card comes from the
    // dashboard's own routes, so no integration and no network are involved. Every width the
    // dashboard lays out at is measured: two columns from 1280px, one below it.
    const cardTitle = "Long ticket";
    const longLabel =
      "PROJ-123 When the deployment fails because the configuration file references a secret that is " +
      "missing from the environment the error message repeats the whole path and the token " +
      "unbreakabletokenwithoutanyspacesatallthatcannotfitonasinglelineanywhere";
    const identityLabel = "corvi-shot-src";
    // A shipped identity row: the repository name beside its state and path. The path is long
    // enough to wrap, which is what the detail is for.
    const identityDetail =
      "clean, no upstream · /Users/wessel/.corvi/changes/PROJ-123/checkouts/corvi-shot-src";
    type LabelLayout = {
      readonly scrollWidth: number;
      readonly clientWidth: number;
      readonly height: number;
      readonly lineHeight: number;
      readonly lines: number;
      readonly text: string;
      readonly textOverflow: string;
    };
    type Layout = {
      readonly prose: LabelLayout;
      readonly identity: LabelLayout;
      readonly cardStaysInPage: boolean;
      readonly pageScrollWidth: number;
      /** The layout viewport: narrower than `window.innerWidth` when a classic scrollbar is drawn,
       * so it is the width a page must not overflow. */
      readonly layoutWidth: number;
    };

    return withPage(
      browser,
      async (page) => {
        // The listed cards gain one the page draws like any other; its widget is the stub below. Every
        // other card answers empty, so the page's width is decided by the rows under test and not by an
        // unrelated card's prose (the fixture's checkout path, for one).
        await page.route("**/api/changes/*/cards", async (route) => {
          const response = await route.fetch();
          const cards = (await response.json()) as Record<string, unknown>[];
          await route.fulfill({
            response,
            json: [...cards, { name: "long-ticket", title: cardTitle, perRepo: false, column: "right" }],
          });
        });
        await page.route("**/api/changes/*/cards/*", (route) =>
          route.fulfill({
            json: { integration: "stub", title: "Stubbed", state: "none", summary: "", items: [] },
          }),
        );
        // The per-repository cards load their rows separately; without this the fixture's own checkout
        // path — much longer than a real change directory — would decide the page's width.
        await page.route("**/api/changes/*/cards/*/items*", (route) =>
          route.fulfill({ json: { items: [] } }),
        );
        await page.route("**/api/changes/*/cards/long-ticket", (route) =>
          route.fulfill({
            json: {
              integration: "jira",
              title: cardTitle,
              state: "ok",
              summary: "",
              items: [
                { label: longLabel, detail: "Open" },
                { label: identityLabel, detail: identityDetail },
              ],
            },
          }),
        );

        const measure = (): Promise<Layout | null> =>
          page.evaluate(
            ({ title, identity }: { title: string; identity: string }) => {
              const card = [...document.querySelectorAll<HTMLElement>(".widget")].find((widget) =>
                (widget.querySelector("h3")?.textContent ?? "").includes(title),
              );
              const rowOf = (prefix: string): HTMLElement | null =>
                [...(card?.querySelectorAll<HTMLElement>(".item .label") ?? [])].find((label) =>
                  (label.textContent ?? "").startsWith(prefix),
                ) ?? null;
              const prose = rowOf("PROJ-123");
              const identityLabel = rowOf(identity);
              if (!card || !prose || !identityLabel) return null;
              const layout = (label: HTMLElement): LabelLayout => {
                const box = label.getBoundingClientRect();
                const style = getComputedStyle(label);
                // A range over the label's own contents reports one rect per line box, which a block's
                // own rect cannot.
                const range = document.createRange();
                range.selectNodeContents(label);
                const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
                return {
                  scrollWidth: label.scrollWidth,
                  clientWidth: label.clientWidth,
                  height: box.height,
                  lineHeight: Number.parseFloat(style.lineHeight),
                  lines: lines.size,
                  text: label.textContent ?? "",
                  textOverflow: style.textOverflow,
                };
              };
              // The page itself is clipped to the window, so the content column is what says
              // whether anything inside it is wider than the room it has.
              const content = document.querySelector<HTMLElement>(".content");
              return {
                prose: layout(prose),
                identity: layout(identityLabel),
                cardStaysInPage: card.getBoundingClientRect().right <= document.documentElement.clientWidth,
                pageScrollWidth: content?.scrollWidth ?? document.documentElement.scrollWidth,
                layoutWidth: content?.clientWidth ?? document.documentElement.clientWidth,
              };
            },
            { title: cardTitle, identity: identityLabel },
          );

        /** The two-column grid starts when both sides have content and the window is at least 1280px
         * wide. Waited for rather than slept through: the reflow is what the measurement depends on. */
        const waitForColumns = (columns: "two" | "one"): Promise<unknown> =>
          page.waitForFunction((want: boolean) => {
            const documents = document.querySelector(".column.documents");
            const status = document.querySelector(".column.status");
            if (!documents || !status) return false;
            const sideBySide =
              status.getBoundingClientRect().left >= documents.getBoundingClientRect().right - 1;
            return sideBySide === want;
          }, columns === "two");

        const check = async (width: number, columns: "two" | "one"): Promise<void> => {
          await page.setViewportSize({ width, height: 900 });
          await waitForColumns(columns);
          const layout = await measure();
          if (!layout) throw new Error(`the stubbed ticket card did not render at ${width}px`);
          // The prose label wraps: it fits its own box, is all there, and is more than one line.
          expect(layout.prose.scrollWidth).toBeLessThanOrEqual(layout.prose.clientWidth);
          expect(layout.prose.text).toBe(longLabel);
          expect(layout.prose.textOverflow).not.toBe("ellipsis");
          expect(layout.prose.lines).toBeGreaterThan(1);
          expect(layout.prose.height).toBeGreaterThan(layout.prose.lineHeight);

          // The identity label is whole: one line, its own height, not squeezed into the detail.
          expect(layout.identity.text).toBe(identityLabel);
          expect(layout.identity.lines).toBe(1);
          expect(layout.identity.height).toBeLessThanOrEqual(layout.identity.lineHeight + 0.5);
          expect(layout.identity.scrollWidth).toBeLessThanOrEqual(layout.identity.clientWidth);

          // Neither the card nor the page reaches past the layout viewport.
          expect(layout.cardStaysInPage).toBe(true);
          expect(layout.pageScrollWidth).toBeLessThanOrEqual(layout.layoutWidth);
        };

        await page.goto(`${url}/changes/${id}/dashboard`, { waitUntil: "domcontentloaded" });
        await page.locator(".widget", { hasText: cardTitle }).first().waitFor({ timeout: 15_000 });
        await page.locator(".column.documents .md-editor").waitFor({ timeout: 15_000 });
        await check(1440, "two");
        // 1280 is the narrowest two-column width: the squeeze on each column is at its worst there.
        await check(1280, "two");
        await check(1100, "one");
      },
      { width: 1440, height: 900 },
    );
  },
  60_000,
);

test.skipIf(!usable)(
  "the checkouts card reads the change's repositories through the typed client",
  async () => {
    // The first browser consumer of the new slice: the card fetches the typed operation, decodes
    // the DTO, and shows the projected state and the branch the worktree actually holds.
    await withPage(
      browser,
      async (page) => {
        await page.goto(`${url}/changes/${id}/dashboard`, { waitUntil: "domcontentloaded" });
        const card = page.locator('[data-testid="checkouts"]');
        await card.locator(".checkout-row").first().waitFor();
        expect(await card.locator(".checkout-name").first().innerText()).toBe("example-api");
        expect(await card.locator(".checkout-state").first().innerText()).toBe("Active");
        expect(await card.locator(".checkout-detail").first().innerText()).toContain(`${id}-x`);
      },
      { width: 1440, height: 900 },
    );
  },
  30_000,
);

test.skipIf(!usable)(
  "switching changes shows the new change's notes, not the one just left",
  async () => {
    // A change's notes are its own: the change you open must show them, not the ones you were
    // typing into the change you left. The read is asynchronous, so this waits for what ends up
    // on screen rather than for a single tick.
    const left = "notes of the change you leave";
    const opened = "notes of the change you open";
    await writeNotes(id, left);
    await writeNotes(other, opened);

    return withPage(
      browser,
      async (page) => {
        await page.goto(`${url}/changes/${id}/dashboard`, { waitUntil: "domcontentloaded" });
        const notes = page.locator(".md-editor");
        await notes.waitFor();
        /** The notes card's text, once it is what it should be; the load is asynchronous like every
         * other, so this is the page's own answer after a bounded wait rather than immediately. */
        const notesAre = async (want: string): Promise<string> => {
          let shown = "";
          for (let i = 0; i < 25; i++) {
            shown = await editorText(notes);
            if (shown === want) break;
            await Bun.sleep(200);
          }
          return shown;
        };
        expect(await notesAre(left)).toBe(left);

        // Type into it, then switch before the debounced save has landed: the in-flight text must not
        // be inherited by the change you open.
        await fillEditor(notes, "typed into the change you leave");
        await page.locator(".sidebar .entry.change", { hasText: `${other}-x` }).click();
        await page.waitForFunction((want) => location.pathname === `/changes/${want}`, other);
        // A change opens on its plan now; its notes are on the dashboard beside it.
        await page.locator(".change-tabs .tab", { hasText: "Dashboard" }).click();
        await page.waitForURL(`**/changes/${other}/dashboard`);
        expect(await notesAre(opened)).toBe(opened);

        // Leaving flushed: the card going away wrote what was typed into the change you left, without
        // waiting for the debounce. The read is polled like the ones above — the flush is
        // fire-and-forget — so this waits for what lands rather than for a tick.
        const leftOnDisk = async (): Promise<string> => {
          let text = "";
          for (let i = 0; i < 25; i++) {
            const read = (await fetch(`${url}/api/ext/notes/changes/${id}/notes`).then((r) => r.json())) as {
              text: string | null;
            };
            text = read.text ?? "";
            if (text === "typed into the change you leave") break;
            await Bun.sleep(200);
          }
          return text;
        };
        expect(await leftOnDisk()).toBe("typed into the change you leave");
      },
      VIEWPORT,
    );
  },
  30_000,
);

test.skipIf(!usable)(
  "a read from the change you left does not land on the one you opened",
  async () => {
    // The load is asynchronous, so a change's notes can still be on their way when you switch.
    // The card that asked for them is the one that must take the answer: a response from the
    // change you left, arriving after the new change's, would otherwise write its text into the
    // notes you are now looking at — and nothing would read them again until the page remounts.
    await writeNotes(id, "notes of the change you leave");
    await writeNotes(other, "notes of the change you open");

    return withPage(
      browser,
      async (page) => {
        // Held back long enough that the switch happens while this read is in flight, which is the
        // race: a slow read, not a wrong one.
        await page.route(
          (url) => url.pathname === `/api/ext/notes/changes/${id}/notes`,
          async (route) => {
            await Bun.sleep(1500);
            await route.continue();
          },
        );
        await page.goto(`${url}/changes/${id}/dashboard`, { waitUntil: "domcontentloaded" });
        await page.locator(".md-editor").waitFor();
        await page.locator(".sidebar .entry.change", { hasText: `${other}-x` }).click();
        await page.waitForFunction((want) => location.pathname === `/changes/${want}`, other);
        // A change opens on its plan now; its notes are on the dashboard beside it.
        await page.locator(".change-tabs .tab", { hasText: "Dashboard" }).click();
        await page.waitForURL(`**/changes/${other}/dashboard`);

        // The change you opened answered first, and stays: the late answer is for a page that is gone.
        const notes = page.locator(".md-editor");
        let shown = "";
        for (let i = 0; i < 25; i++) {
          shown = await editorText(notes);
          if (shown === "notes of the change you open") break;
          await Bun.sleep(200);
        }
        expect(shown).toBe("notes of the change you open");
        await Bun.sleep(2000); // past the held response
        expect(await editorText(notes)).toBe("notes of the change you open");
      },
      VIEWPORT,
    );
  },
  30_000,
);

test.skipIf(!usable)(
  "the title row is the page's first, and the one tab row sits under it",
  async () => {
    // The title row is the window's title bar in the app: full-bleed, one title bar tall, and it
    // holds what the change is — name, id, branch — with its state and actions. Neither row holds
    // any of the other's controls, and both stay put while the page scrolls under them.
    await fetch(`${url}/api/changes/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Anonymise customer names" }),
    });
    return withPage(
      browser,
      async (page) => {
        await page.goto(`${url}/changes/${id}/dashboard`, { waitUntil: "domcontentloaded" });
        const titleRow = page.locator(".change-bar");
        await titleRow.locator(".change-name").waitFor();

        // What the change is: its name and its branch, and the name is also the OS window's title.
        // The id is not repeated here — the branch starts with it.
        expect((await titleRow.locator(".change-name").innerText()).trim()).toBe("Anonymise customer names");
        expect(await titleRow.locator(".change-id").count()).toBe(0);
        expect((await titleRow.locator(".change-branch").innerText()).trim()).toContain(id);
        await page.waitForFunction(() => document.title === "Anonymise customer names");
        expect(await page.title()).toBe("Anonymise customer names");

        // No tabs in the title row: they are the row under it.
        expect(await titleRow.locator(".tab").count()).toBe(0);
        expect(await titleRow.locator(".window-tab").count()).toBe(0);

        // Edge to edge and exactly the title bar's height: it lines up with the column's brand row.
        const stripBox = await titleRow.boundingBox();
        const columnBox = await page.locator(".content").boundingBox();
        if (!stripBox || !columnBox) throw new Error("the change's title row did not lay out");
        expect(Math.abs(stripBox.width - columnBox.width)).toBeLessThanOrEqual(1);
        expect(Math.round(stripBox.height)).toBe(TITLE_BAR_HEIGHT);

        // The one tab row: the change's views, a separator, then its terminal windows.
        const tabsRow = page.locator(".change-tabs");
        await tabsRow.locator(".tabs .tab").first().waitFor();
        expect((await tabsRow.locator(".tabs .tab").allInnerTexts()).map((s) => s.trim())).toEqual([
          "Plan",
          "Dashboard",
          "Changes",
        ]);
        expect(await tabsRow.locator(".tab-separator").count()).toBe(1);
        expect(await tabsRow.locator(".window-tabs").count()).toBe(1);
        const parts = await tabsRow.evaluate((el) => [...el.children].map((child) => child.className));
        const separator = parts.findIndex((name) => name.includes("tab-separator"));
        const windows = parts.findIndex((name) => name.includes("window-tabs"));
        expect(separator).toBeGreaterThan(0);
        expect(windows).toBeGreaterThan(separator);

        // The state and the actions are the title row's, not the tabs': two menus, the state's
        // first.
        await titleRow.locator(".menu > button").first().waitFor();
        expect(await titleRow.locator(".menu > button").count()).toBe(2);
        expect(await tabsRow.locator(".menu").count()).toBe(0);

        // The two rows are one sticky block: the wrapper carries the stickiness, so neither row has
        // an offset of its own that would have to track the other's height.
        const chrome = page.locator(".change-chrome");
        expect(await chrome.evaluate((el) => getComputedStyle(el).position)).toBe("sticky");
        // The row is relatively positioned only to keep the title row's menus above it; the wrapper
        // is what sticks, so the row needs no offset of its own.
        expect(await tabsRow.evaluate((el) => getComputedStyle(el).position)).toBe("relative");
        expect(await tabsRow.evaluate((el) => getComputedStyle(el).top)).toBe("0px");

        // Both stay put while the cards scroll under them: they are the window's chrome, not part
        // of what you read. The dashboard's page does not scroll — its columns do.
        const resting = await Promise.all([titleRow.boundingBox(), tabsRow.boundingBox()]);
        const scrolled = await page.evaluate(() => {
          const scroller = [...document.querySelectorAll<HTMLElement>(".column, .content")].find(
            (element) => element.scrollHeight > element.clientHeight + 1,
          );
          if (scroller === undefined) return false;
          scroller.scrollBy(0, 400);
          return scroller.scrollTop > 0;
        });
        expect(scrolled).toBe(true);
        const [stoppedTitle, stoppedTabs] = await Promise.all([
          titleRow.boundingBox(),
          tabsRow.boundingBox(),
        ]);
        expect(stoppedTitle!.y).toBe(resting[0]!.y);
        expect(Math.abs(stoppedTabs!.y - (stoppedTitle!.y + stoppedTitle!.height))).toBeLessThanOrEqual(1);

        // The navigation column: one line per change, its name, and no id of its own. The branch — the id
        // with a slug after it — is the entry's tooltip. Scoped to this change's own entry, since the
        // column holds every change in the workspace (test/pages.test.ts's second one included).
        const entry = page.locator(".sidebar .entry.change", { hasText: "Anonymise customer names" });
        await entry.locator(".subject").waitFor();
        expect(await entry.locator(".id").count()).toBe(0);
        expect((await entry.locator(".subject").innerText()).trim()).toBe("Anonymise customer names");
        expect(await entry.getAttribute("title")).toContain(id);
      },
      { width: 1000, height: 600 },
    );
  },
  30_000,
);

/** A change with `count` terminal windows, created idempotently, so a test body can run again
 * without making a duplicate window. `name` gives every window a long title, which is what makes
 * the strip wrap at the shared viewport. */
const terminalWindows = async (change: string, count: number, name?: string): Promise<void> => {
  const created = await fetch(`${url}/api/changes`, {
    method: "POST",
    // A working change, not an idea: the overview's draft list is counted elsewhere in this file.
    body: JSON.stringify({ id: change, checkouts: checkoutsOf([repoDir]) }),
  });
  if (!created.ok) {
    const existing = await fetch(`${url}/api/changes/${change}`);
    expect(existing.ok).toBe(true);
  }
  const listed = await fetch(`${url}/api/changes/${change}/terminal/windows`);
  expect(listed.ok).toBe(true);
  let windows = (await listed.json()) as { id: string }[];
  for (let index = windows.length; index < count; index++) {
    const opened = await fetch(`${url}/api/changes/${change}/terminal/windows`, {
      method: "POST",
      body: JSON.stringify({ action: "new" }),
    });
    expect(opened.ok).toBe(true);
    windows = (await opened.json()) as { id: string }[];
  }
  if (name === undefined) return;
  for (const [index, window] of windows.entries()) {
    const renamed = await fetch(`${url}/api/changes/${change}/terminal/windows`, {
      method: "POST",
      body: JSON.stringify({ action: "rename", window: window.id, title: `${name} ${index + 1}` }),
    });
    expect(renamed.ok).toBe(true);
  }
};

test.skipIf(!usable)(
  "the tab row wraps to two rows and the chrome stays one sticky block",
  async () => {
    // A change whose tab row cannot fit one line at this width: the change's three views, the
    // separator, four windows' tabs and "+". The windows are made through the registry's own
    // route, the way the tab's "+" does, so no page has to be attached for them to exist.
    const wrap = "PROJ-PAGES-WRAP";
    await terminalWindows(wrap, 4);

    return withPage(
      browser,
      async (page) => {
        await page.goto(`${url}/changes/${wrap}/dashboard`, { waitUntil: "domcontentloaded" });
        const titleRow = page.locator(".change-bar");
        const tabsRow = page.locator(".change-tabs");
        const tabs = page.locator(".window-tabs .window-tab");
        // Four windows and "+": five window tabs, once the app's window list has loaded.
        await page.waitForFunction(() => document.querySelectorAll(".window-tab").length >= 5);

        // The title row is one title bar; the row under it is the one the tabs wrap in.
        const title = await titleRow.boundingBox();
        if (!title) throw new Error("the title row did not lay out");
        expect(Math.round(title.height)).toBe(TITLE_BAR_HEIGHT);
        const tops = await tabs.evaluateAll((els) =>
          els.map((el) => Math.round(el.getBoundingClientRect().top)),
        );
        // More windows than fit: the tabs wrap, and the row is taller than the title bar.
        // How many rows the tabs *want* depends on their names; the contract is that they wrap
        // and that the row grows with them.
        expect(new Set(tops).size).toBeGreaterThanOrEqual(2);
        const row = await tabsRow.boundingBox();
        if (!row) throw new Error("the tab row did not lay out");
        expect(row.height).toBeGreaterThan(TITLE_BAR_HEIGHT);

        // One bar: the views and the windows are items of the same row, so the second line begins
        // at the row's own left edge rather than staying indented under the views. Nothing inside
        // the row scrolls — the row itself is what grows.
        const lines = await tabsRow.evaluate((el) => {
          const rowLeft = el.getBoundingClientRect().left;
          const padding = Number.parseFloat(getComputedStyle(el).paddingLeft);
          const items = [...el.querySelectorAll<HTMLElement>(".window-tab")].map((tab) =>
            tab.getBoundingClientRect(),
          );
          const secondLine = items.filter((box) => Math.round(box.top) > Math.round(items[0]!.top));
          return {
            left: Math.round(Math.min(...secondLine.map((box) => box.left)) - rowLeft),
            padding: Math.round(padding),
            scrollers: [...el.querySelectorAll<HTMLElement>(".window-tabs")].filter(
              (box) => getComputedStyle(box).overflowY === "auto" || box.scrollHeight > box.clientHeight,
            ).length,
          };
        });
        expect(lines.left).toBeLessThanOrEqual(lines.padding + 1);
        expect(lines.scrollers).toBe(0);

        // At a narrow width the tabs keep wrapping inside the row instead of hiding past its edge.
        await page.setViewportSize({ width: 360, height: 420 });
        const wide = await tabsRow.evaluate((el) => ({
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        }));
        expect(wide.scrollWidth).toBeLessThanOrEqual(wide.clientWidth + 1);
        await page.setViewportSize({ width: 900, height: 420 });

        // The regression the shared sticky wrapper exists to prevent: with two rows, a hard-coded
        // second offset would leave the tab row at one title bar instead of under the taller row.
        const scrolled = await page.evaluate(() => {
          const scroller = [...document.querySelectorAll<HTMLElement>(".column, .content")].find(
            (element) => element.scrollHeight > element.clientHeight + 1,
          );
          if (scroller === undefined) return false;
          scroller.scrollBy(0, 400);
          return scroller.scrollTop > 0;
        });
        expect(scrolled).toBe(true);
        const stoppedTitle = await titleRow.boundingBox();
        const stoppedTabs = await tabsRow.boundingBox();
        if (!stoppedTitle || !stoppedTabs) throw new Error("the chrome did not lay out");
        expect(stoppedTitle.y).toBe(title.y);
        expect(Math.abs(stoppedTabs.y - (stoppedTitle.y + stoppedTitle.height))).toBeLessThanOrEqual(1);

        // The change's Actions menu is the title row's: it opens below its button, over the tab row,
        // and the choice is clickable there.
        const actions = page.locator(".change-bar .menu > button.actions");
        await actions.click();
        const items = page.locator(".change-bar .menu-items");
        await items.waitFor();
        const [button, dropdown] = await Promise.all([actions.boundingBox(), items.boundingBox()]);
        if (!button || !dropdown) throw new Error("the actions menu did not lay out");
        expect(Math.abs(dropdown.y - (button.y + button.height)) - 4).toBeLessThanOrEqual(1);
        await page.keyboard.press("Escape");
        await items.waitFor({ state: "hidden" });
      },
      { width: 900, height: 420 },
    );
  },
  60_000,
);

test.skipIf(!usable)(
  "the dashboard fills the window even when the tab row wraps",
  async () => {
    // The case viewport arithmetic got wrong: the windows' tabs wrap to a second row, so the cards'
    // room is less than a one-row constant assumes. The fill is the flex chain's, so the chrome
    // costs the cards exactly its own height and the page stays inside the window.
    const fill = "PROJ-PAGES-FILL";
    await terminalWindows(fill, 4, "A long window title number");
    await withPage(
      browser,
      async (page) => {
        await page.goto(`${url}/changes/${fill}/dashboard`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(".widget");
        await page.waitForFunction(() => document.querySelectorAll(".window-tab").length >= 5);

        // Wrapped: this is the case a one-row constant would have got wrong.
        const tops = await page
          .locator(".window-tab")
          .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
        expect(new Set(tops).size).toBeGreaterThanOrEqual(2);

        // The window is the height authority at any chrome height, not only the height this
        // machine's font metrics happen to produce: grow the rows beyond the wrapped case before
        // measuring, so the assertion holds where the CI's fonts wrap further than a Mac's.
        await page.addStyleTag({
          content: ".change-tabs .tab, .change-tabs .window-tab { padding-block: 40px; }",
        });
        await settleLayout(page);

        // Nothing is pushed past the window: no phantom scrollbar from the chrome.
        const [scrollHeight, innerHeight] = await page.evaluate(() => [
          document.documentElement.scrollHeight,
          window.innerHeight,
        ]);
        expect(scrollHeight).toBeLessThanOrEqual(innerHeight);

        // And the columns reach the content's bottom edge: the last card took what was left.
        const [widgets, content] = await Promise.all([
          page.locator(".widgets").boundingBox(),
          page.locator(".content").boundingBox(),
        ]);
        if (!widgets || !content) throw new Error("the dashboard did not lay out");
        expect(Math.abs(widgets.y + widgets.height - (content.y + content.height - 48))).toBeLessThanOrEqual(
          2,
        );
      },
      { width: 1280, height: 1000 },
    );
  },
  60_000,
);

test.skipIf(!usable)(
  "a narrow window hides the navigation behind a drawer",
  async () => {
    await withPage(
      browser,
      async (page) => {
        await page.goto(`${url}/changes/${id}/dashboard`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(".widget");

        // The column is out of the flow: the content owns the window, rather than sitting under it.
        const [content, sidebar, viewport] = await Promise.all([
          page.locator(".content").boundingBox(),
          // Its own rect, not Playwright's boundingBox: a hidden element has no visible box, and the
          // closed drawer is deliberately hidden.
          page.locator(".sidebar").evaluate((el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          }),
          page.evaluate(() => document.documentElement.clientWidth),
        ]);
        if (!content || !sidebar) throw new Error("the narrow layout did not lay out");
        expect(Math.abs(content.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(content.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(content.width - viewport)).toBeLessThanOrEqual(1);
        // Off-screen, and out of the tab order and the accessibility tree with it.
        expect(sidebar.x + sidebar.width).toBeLessThanOrEqual(1);
        expect(await page.locator(".sidebar").evaluate((el) => getComputedStyle(el).visibility)).toBe(
          "hidden",
        );

        // The toggle opens the drawer, and the backdrop comes with it. The toggle stays clickable above
        // both, and says which state it is in.
        const toggle = page.locator(".drawer-toggle");
        expect(await toggle.isVisible()).toBe(true);
        expect(await toggle.getAttribute("aria-expanded")).toBe("false");
        await toggle.click();
        await page.locator(".drawer-backdrop").waitFor();
        expect(await toggle.getAttribute("aria-expanded")).toBe("true");
        const drawer = await page.locator(".sidebar").boundingBox();
        if (!drawer) throw new Error("the drawer did not lay out");
        expect(Math.abs(drawer.x)).toBeLessThanOrEqual(1);
        expect(await page.locator(".sidebar").evaluate((el) => getComputedStyle(el).visibility)).toBe(
          "visible",
        );
        // An open drawer owns the scroll.
        expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe("hidden");

        // The toggle closes it too: a second click puts it away.
        await toggle.click();
        await page.locator(".drawer-backdrop").waitFor({ state: "detached" });
        expect(await toggle.getAttribute("aria-expanded")).toBe("false");

        // Open it again for the Escape check.
        await toggle.click();
        await page.locator(".drawer-backdrop").waitFor();

        // Escape closes it: the backdrop goes, the toggle says so, and the scroll comes back.
        await page.keyboard.press("Escape");
        await page.locator(".drawer-backdrop").waitFor({ state: "detached" });
        expect(await toggle.getAttribute("aria-expanded")).toBe("false");
        expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe("hidden");

        // A backdrop click closes it too.
        await toggle.click();
        await page.locator(".drawer-backdrop").waitFor();
        await page.locator(".drawer-backdrop").click({ position: { x: 550, y: 700 } });
        await page.locator(".drawer-backdrop").waitFor({ state: "detached" });

        // Clicking a change in the drawer goes there and closes the drawer behind it.
        await toggle.click();
        await page.locator(".drawer-backdrop").waitFor();
        await page.locator(".sidebar .entry.change", { hasText: other }).click();
        await page.locator(".drawer-backdrop").waitFor({ state: "detached" });
        expect(new URL(page.url()).pathname).toContain(other);

        // A resize above the breakpoint closes an open drawer, puts the column back in the flow, and
        // takes the toggle away.
        await toggle.click();
        await page.locator(".drawer-backdrop").waitFor();
        await page.setViewportSize({ width: 1000, height: 800 });
        await page.locator(".drawer-backdrop").waitFor({ state: "detached" });
        await page.locator(".drawer-toggle").waitFor({ state: "hidden" });
        expect(await toggle.isVisible()).toBe(false);
        const [wideSidebar, wideContent] = await Promise.all([
          page.locator(".sidebar").boundingBox(),
          page.locator(".content").boundingBox(),
        ]);
        if (!wideSidebar || !wideContent) throw new Error("the wide layout did not lay out");
        expect(wideContent.x).toBeGreaterThanOrEqual(wideSidebar.x + wideSidebar.width - 1);

        // On the terminal page the toggle sits clear of the window's first tab.
        await page.setViewportSize({ width: 600, height: 800 });
        await page.goto(`${url}/changes/${id}/terminals`, { waitUntil: "domcontentloaded" });
        const firstTab = page.locator(".change-tabs .tab").first();
        await firstTab.waitFor();
        const [toggleBox, tabBox] = await Promise.all([
          page.locator(".drawer-toggle").boundingBox(),
          firstTab.boundingBox(),
        ]);
        if (!toggleBox || !tabBox) throw new Error("the terminal chrome did not lay out");
        expect(toggleBox.x + toggleBox.width).toBeLessThanOrEqual(tabBox.x + 1);
      },
      { width: 600, height: 800 },
    );
  },
  60_000,
);

test.skipIf(!usable)(
  "in the app window the row is also the window's chrome",
  async () => {
    // The host bridge is what says the page is inside the app window (apps/web/src/domain/host.ts), and only
    // then is the first row chrome as well: what you drag the window by, and clear of the traffic
    // lights the main process placed in it (docs/manual/interface.md). Injected rather than
    // driven through Electron, because the page's half of the contract is what is being checked — the
    // lights' pixels are the main process's, and only a real window has those.
    await withPage(
      browser,
      async (page) => {
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
            restart: () => {},
          };
        });
        await page.goto(`${url}/changes/${id}`, { waitUntil: "domcontentloaded" });
        const title = page.locator(".change-bar");
        await title.locator(".change-name").waitFor();
        const region = (sel: string): Promise<string> =>
          page
            .locator(sel)
            .first()
            .evaluate((el) => getComputedStyle(el).getPropertyValue("-webkit-app-region"))
            .then((value) => value.trim());

        // The title row is what you drag the window by; everything you can click in it stays a
        // control. The tab row under it is not part of the drag region at all.
        expect(await region(".change-bar")).toBe("drag");
        expect(await region(".change-bar .menu > button")).toBe("no-drag");
        expect(await region(".change-tabs")).not.toBe("drag");
        // The name is the row's, not a button: renaming is the Actions menu's entry.
        expect(await title.locator(".change-name").count()).toBe(1);
        expect(await title.locator(".change-id").count()).toBe(0);
        expect(await title.locator(".change-branch").count()).toBe(1);

        // The brand row: the raven and the name, and no control of its own — the row the window
        // drags by. All of it clears the lights.
        const brand = page.locator(".sidebar > .band");
        const logo = await brand.locator(".brand-logo").boundingBox();
        const [sidebar, band] = await Promise.all([
          page.locator(".sidebar").boundingBox(),
          brand.boundingBox(),
        ]);
        if (!logo || !sidebar || !band) throw new Error("the sidebar did not lay out");
        expect((await brand.locator(".brand-name").innerText()).trim()).toBe("Corvi");
        expect(logo.x).toBeGreaterThanOrEqual(TRAFFIC_LIGHTS.inset);
        expect(await brand.locator("button").count()).toBe(0);
        expect(sidebar.width).toBeGreaterThanOrEqual(TRAFFIC_LIGHTS.inset + 160);
        expect(await region(".sidebar > .band")).toBe("drag");

        // The switcher is a compact pill at the right of the Workspace heading's row, below the
        // changes: one line, so the column reads top to bottom.
        const switcher = page.locator(".sidebar .workspace-row button.workspace");
        const switcherBox = await switcher.boundingBox();
        const workspaceRow = await page.locator(".sidebar .workspace-row").boundingBox();
        if (!switcherBox || !workspaceRow) throw new Error("the workspace row did not lay out");
        expect(switcherBox.width).toBeLessThan(sidebar.width / 2);
        expect(switcherBox.x).toBeGreaterThan(workspaceRow.x + workspaceRow.width / 2);
        expect(switcherBox.x + switcherBox.width).toBeLessThanOrEqual(
          workspaceRow.x + workspaceRow.width + 1,
        );

        // The column's line runs the whole edge, the brand row included: the column and the page
        // beside it are two surfaces, and the line is what says where one ends. It is drawn (a
        // pseudo-element) rather than a border, because the resize handle shares that edge.
        const column = page.locator(".sidebar");
        expect(await column.evaluate((el) => getComputedStyle(el).borderRightWidth)).toBe("0px");
        expect(await column.evaluate((el) => getComputedStyle(el, "::after").top)).toBe("0px");
        expect(await column.evaluate((el) => getComputedStyle(el, "::after").backgroundColor)).not.toBe(
          "rgba(0, 0, 0, 0)",
        );

        // The switcher's list opens below its row and inside the window rather than past its edge.
        await switcher.click();
        const menu = await page.locator(".workspace-row .menu-items").boundingBox();
        if (!menu) throw new Error("the workspace menu did not open");
        const viewport = await page.evaluate(() => window.innerWidth);
        expect(menu.x).toBeGreaterThanOrEqual(0);
        expect(menu.x + menu.width).toBeLessThanOrEqual(viewport);
        expect(menu.y).toBeGreaterThan(switcherBox.y);
        expect(complaints).toEqual([]);
      },
      VIEWPORT,
    );
  },
  30_000,
);
test.skipIf(!usable)(
  "the name is renamed from the actions menu",
  async () => {
    // Renaming is an action in the change's own row (docs/manual/interface.md): the menu's
    // Rename change opens a field beside the state and the actions, and what it is given is what the
    // column's entry and the window's title say afterwards.
    await withPage(
      browser,
      async (page) => {
        await page.goto(`${url}/changes/${id}`, { waitUntil: "domcontentloaded" });
        await page.locator(".change-bar .change-name").waitFor();

        await page.locator(".change-bar button", { hasText: "Actions" }).click();
        await page.getByRole("button", { name: "Rename change" }).click();
        const input = page.locator(".change-bar input.subject");
        await input.waitFor();
        await input.fill("A name of my own");
        await input.press("Enter");

        await page.locator(".sidebar .entry.change .subject", { hasText: "A name of my own" }).waitFor();
        expect(await page.title()).toBe("A name of my own");
      },
      VIEWPORT,
    );
  },
  30_000,
);

test.skipIf(!usable)(
  "New starts an idea from the column or the overview",
  async () => {
    // One control in two places: the overview's header has it, and so does the column beside the
    // Ideas heading — the entries it adds to. Both say the same word and open the same wizard.
    await withPage(
      browser,
      async (page) => {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(".change-card");

        expect((await page.locator(".page > header .create").innerText()).trim()).toBe("New");
        // The column's is the glyph, with the word as its label (docs/manual/interface.md).
        expect(await page.locator(".sidebar .ideas-row .create").getAttribute("aria-label")).toBe("new idea");

        await page.locator(".sidebar .ideas-row .create").click();
        await page.waitForSelector(".wizard");
        expect(new URL(page.url()).pathname).toBe("/new");
      },
      VIEWPORT,
    );
  },
  30_000,
);

test.skipIf(!usable)(
  "a half-filled idea is still there after leaving the wizard",
  async () => {
    // The promise this change is about: leaving /new loses nothing. The form lives in the App
    // (apps/web/src/wizard/draft.ts), and the column's row under Ideas is the way back to it.
    await withPage(
      browser,
      async (page) => {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(".change-card");

        await page.locator(".sidebar .ideas-row .create").click();
        await page.waitForSelector(".wizard");
        // The draft row is where "here" is while the wizard is open, not the overview entry.
        expect(await page.locator(".sidebar .entry.change.state-ideation.current").count()).toBe(1);
        expect(await page.locator(".sidebar > button.entry.current").count()).toBe(0);

        await fillEditor(
          page.locator(".wizard-plan .md-editor"),
          "# A half-written idea\n\nThe first paragraph of the plan.",
        );

        // The row says what the draft is called while it is being typed: its plan's heading.
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

        // Back through the row: the plan and the fields are where they were left. (The fields are
        // found in the details form: the steps' dialogs carry fields of their own with familiar
        // names.)
        await row.click();
        await page.waitForSelector(".wizard-body");
        expect(new URL(page.url()).pathname).toBe("/new");
        expect(await page.locator(".wizard-sections .form").getByLabel("Title").inputValue()).toBe(
          "A half-written idea",
        );
        expect(await editorText(page.locator(".wizard-plan .md-editor"))).toBe(
          "# A half-written idea\n\nThe first paragraph of the plan.",
        );

        // The other way in — the New button — opens the same draft, not a second, empty one.
        await page.locator(".sidebar > button.entry", { hasText: "Changes" }).click();
        await page.waitForSelector(".change-card");
        await page.locator(".sidebar .ideas-row .create").click();
        await page.waitForSelector(".wizard-body");
        expect(await page.locator(".wizard-sections .form").getByLabel("Title").inputValue()).toBe(
          "A half-written idea",
        );
        expect(await row.count()).toBe(1);

        // Discarding is the one thing that throws it away.
        await page.getByRole("button", { name: "Discard" }).click();
        await page.waitForSelector(".change-card");
        expect(await row.count()).toBe(0);
      },
      VIEWPORT,
    );
  },
  30_000,
);

test.skipIf(!usable)(
  "the repository browser asks where the checkout lives and which branch it uses",
  async () => {
    await withPage(
      browser,
      async (page) => {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(".change-card");

        await page.locator(".sidebar .ideas-row .create").click();
        await page.waitForSelector(".wizard");
        // Straight to the repositories: the wizard is one screen, and the section's Edit… opens
        // the browser dialog — this is about the browser, not the idea's fields.
        await page.locator(".wizard-sections .repos-field").getByRole("button", { name: "Edit…" }).click();
        await page.waitForSelector("dialog .browser");

        // The fixture repository is in the configured start directory, one Add away.
        await page
          .locator(".listing .entries li", { hasText: "example-api" })
          .getByRole("button", { name: "Add", exact: true })
          .click();
        const row = page.locator(".selected-pane li.selection");
        await row.waitFor();

        // Every field is named, with its explanation an icon away: the two questions and the two
        // branch questions say which is which instead of reading as anonymous boxes.
        expect(
          (await row.locator(".field .caption").allInnerTexts()).map((s) => s.replace("ⓘ", "").trim()),
        ).toEqual(["Checkout", "Branch", "Starts from", "Merges into"]);
        expect(await row.locator(".field .info[title]").count()).toBe(4);

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
        // why instead of being offered. The disabled attribute is what the browser enforces.
        const current = branchKind.locator("option", { hasText: "Current branch" });
        expect(await current.getAttribute("disabled")).not.toBeNull();
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
        expect(
          (await row.locator(".field .caption").allInnerTexts()).map((s) => s.replace("ⓘ", "").trim()),
        ).toEqual(["Checkout", "Branch", "Branch name", "Merges into"]);

        // In place, the current branch becomes the offer — and taking it drops both branch pickers:
        // what a pull request merges into is the one branch question left.
        await location.selectOption("original");
        expect(await current.getAttribute("disabled")).toBeNull();
        await branchKind.selectOption("current");
        expect(await row.locator("select.name").count()).toBe(0);
        expect(await row.locator("select.base").count()).toBe(0);
        expect(await row.locator("select.target").count()).toBe(1);

        // Going back to a worktree cannot keep it: the row falls back to the change's own branch.
        await location.selectOption("new");
        expect(await branchKind.inputValue()).toBe("change");
      },
      VIEWPORT,
    );
  },
  30_000,
);

test.skipIf(!usable)(
  "the state selector speaks the record's vocabulary",
  async () => {
    await withPage(
      browser,
      async (page) => {
        await page.goto(`${url}/changes/${id}`, { waitUntil: "domcontentloaded" });
        const stateMenu = page.locator(".change-bar .menu > button").first();
        await stateMenu.click();
        const options = (await page.locator(".change-bar .menu-items button").allInnerTexts()).map((s) =>
          s.trim(),
        );
        // The words are the record's: the rename of record format v2 reaches the page.
        expect(options).toContain("Implementation");
        expect(options).toContain("Verification");
        expect(options).not.toContain("In Progress");
        expect(options).not.toContain("Awaiting Review");
      },
      VIEWPORT,
    );
  },
  30_000,
);

test.skipIf(!usable)(
  "the tab row is the plan first, then the views, then the windows",
  async () => {
    // One row, two kinds of thing: the change's views first (Plan, where a change opens), then a
    // separator, then the terminal windows. A view's tab says where you are; a window's says which
    // terminal, and only one of the two can be current.
    await withPage(
      browser,
      async (page) => {
        await page.goto(`${url}/changes/${id}`, { waitUntil: "domcontentloaded" });
        await page.locator(".change-tabs .tabs .tab").first().waitFor();
        // The extension's tab is part of the row the server tells the page about; the first tab
        // can paint before that answer arrives. Wait for the row, not just its first item.
        await waitFor(
          "the change's view tabs",
          async () =>
            (await page.locator(".change-tabs .tabs .tab").allInnerTexts())
              .map((text) => text.trim())
              .join("|") === "Plan|Dashboard|Changes",
          budget(15_000),
        );

        // Plan first, then the dashboard, then the extensions' tabs in load order.
        expect((await page.locator(".change-tabs .tabs .tab").allInnerTexts()).map((s) => s.trim())).toEqual([
          "Plan",
          "Dashboard",
          "Changes",
        ]);
        expect((await page.locator(".change-tabs .tabs .tab.current").innerText()).trim()).toBe("Plan");

        const review = page.locator(".change-tabs .tabs .tab", { hasText: "Changes" });
        await review.click();
        await page.waitForURL(`**/changes/${id}/review`);
        expect((await page.locator(".change-tabs .tabs .tab.current").innerText()).trim()).toBe("Changes");
        // A view showing means no window tab is current: there is one answer to "where am I".
        expect(await page.locator(".change-tabs .window-tab.current").count()).toBe(0);

        // The separator is between the views and the windows, in that order.
        const row = await page.locator(".change-tabs").evaluate((el) => {
          const parts = [...el.children].map((child) => child.className);
          return {
            separator: parts.findIndex((name) => name.includes("tab-separator")),
            windows: parts.findIndex((name) => name.includes("window-tabs")),
            views: parts.findIndex((name) => name.includes("views")),
          };
        });
        expect(row.views).toBeGreaterThanOrEqual(0);
        expect(row.separator).toBeGreaterThan(row.views);
        expect(row.windows).toBeGreaterThan(row.separator);
      },
      VIEWPORT,
    );
  },
  30_000,
);

test.skipIf(!usable)(
  "a change opens on its plan, and comes back on the view you left",
  async () => {
    // The memory is the page's own: remembered while it lives, and a fresh page — or a restart of
    // the app — opens the plan again (apps/web/src/app-root/remember.ts). `other`, whose name no
    // earlier test has rewritten, is the one the card can be found by.
    await withPage(browser, async (page) => {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".change-card");
      await page.locator(".change-card", { hasText: `${other}-x` }).click();
      await page.waitForURL(`**/changes/${other}`);
      expect((await page.locator(".change-tabs .tab.current").innerText()).trim()).toBe("Plan");

      await page.locator(".change-tabs .tab", { hasText: "Dashboard" }).click();
      await page.waitForURL(`**/changes/${other}/dashboard`);

      // Leave for home and come back: the view you left, not the plan again.
      await page.locator(".sidebar > button.entry", { hasText: "Changes" }).click();
      await page.waitForSelector(".change-card");
      await page.locator(".change-card", { hasText: `${other}-x` }).click();
      await page.waitForURL(`**/changes/${other}/dashboard`);
      expect((await page.locator(".change-tabs .tab.current").innerText()).trim()).toBe("Dashboard");
    });
  },
  30_000,
);

test.skipIf(!usable)(
  "the plan is where you left it: its scroll comes back",
  async () => {
    // In memory only: a fresh page — or a restart of the app — opens the document at the top
    // again (apps/web/src/app-root/remember.ts).
    const long = Array.from({ length: 120 }, (_, i) => `paragraph ${i + 1}`).join("\n\n");
    const wrote = await fetch(`${url}/api/changes/${other}/plan`, {
      method: "PUT",
      body: JSON.stringify({ text: long }),
    });
    expect(wrote.ok).toBe(true);

    await withPage(browser, async (page) => {
      await page.goto(`${url}/changes/${other}`, { waitUntil: "domcontentloaded" });
      // The document, not the empty editor the placeholder stands in for.
      await page.waitForSelector(".plan-page .md-editor .cm-placeholder", { state: "detached" });

      // Scroll the document well down…
      const scroller = page.locator(".plan-page .cm-scroller");
      const scrolled = await scroller.evaluate((el) => {
        el.scrollTop = el.scrollHeight / 2;
        return el.scrollTop;
      });
      expect(scrolled).toBeGreaterThan(0);
      // …and let it come to rest both times: the freshly filled editor measures its lines and the
      // scroll settles with them, a line or so at a time. What is remembered — and what comes
      // back — is where that leaves the reader.
      const rested = async (): Promise<number> => {
        let top = await scroller.evaluate((el) => el.scrollTop);
        for (let i = 0; i < 30; i++) {
          await Bun.sleep(150);
          const now = await scroller.evaluate((el) => el.scrollTop);
          if (Math.abs(now - top) < 2) return now;
          top = now;
        }
        return top;
      };
      const left = await rested();

      // …leave for the dashboard, and come back: the same place in the document.
      await page.locator(".change-tabs .tab", { hasText: "Dashboard" }).click();
      await page.waitForURL(`**/changes/${other}/dashboard`);
      await page.locator(".change-tabs .tab", { hasText: "Plan" }).click();
      await page.waitForURL(`**/changes/${other}`);
      await page.waitForSelector(".plan-page .md-editor .cm-placeholder", { state: "detached" });
      const restored = await rested();
      expect(Math.abs(restored - left)).toBeLessThan(60);
    });
  },
  30_000,
);

test.skipIf(!usable)(
  "the right-click menu follows the setting",
  async () => {
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

    return withPage(
      browser,
      async (page) => {
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
      },
      VIEWPORT,
    );
  },
  30_000,
);
