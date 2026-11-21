import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, type Page } from "playwright";
import {
  closePages,
  gitRepo,
  openEngine,
  startTestServer,
  stopTestServer,
  testTempDir,
  withPage,
} from "./helpers.ts";

/**
 * Leader mode through the page: `Ctrl+Space` lays the column's keys over the controls, the next
 * key goes where its badge says, an unmapped or disabled key does nothing, and an open menu is
 * numbered and unwound one layer at a time. The key assignment itself is pinned in
 * leader.test.ts; this is the way through the mode, which is where the elements, the dialogs and
 * the focus live.
 */
let browser: Browser;
const usable = await openEngine((opened) => {
  browser = opened;
});

let tmp: string;
let url: string;
let server: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  if (!usable) return;
  tmp = await testTempDir("leader-page");
  ({ server, url } = await startTestServer(tmp));

  // A started change for the row that has a state menu (an idea shows a chip instead), with a
  // real checkout so the server accepts it.
  const repos = join(tmp, "repos");
  await mkdir(repos, { recursive: true });
  const checkout = await gitRepo(repos, "alpha");
  for (const id of ["STARTED-1", "STARTED-2"]) {
    const started = await fetch(`${url}/api/changes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id,
        title: `A started change (${id})`,
        state: "Implementation",
        checkouts: [{ path: checkout, location: "original", branch: { kind: "current" } }],
      }),
    });
    expect(started.status).toBe(201);
  }
  const idea = await fetch(`${url}/api/changes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "LEADER-1", title: "An idea", state: "Ideation" }),
  });
  expect(idea.status).toBe(201);
});

afterAll(async () => {
  if (!usable) return;
  await closePages(browser, "leader-page");
  await browser?.close();
  await stopTestServer(server, tmp);
  await rm(tmp, { recursive: true, force: true });
});

const open = async (page: Page): Promise<void> => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".sidebar .list");
};

/** Wait for the column to have read the changes it lists: the list element is there before its
 * rows are, and a selector pressed too early would find nothing to pick. */
const waitForIdeas = (page: Page, count: number): Promise<unknown> =>
  page.waitForFunction(
    (wanted) => document.querySelectorAll('[data-leader-item="ideas"]').length >= wanted,
    count,
    { timeout: 15_000 },
  );

/** The leader's layer as drawn: every cap by label and position, and the boxes around the groups,
 * each saying whether it is the quiet one the caps come with or the numbered one. */
type Layer = {
  readonly keys: readonly { label: string; x: number; y: number; width: number; height: number }[];
  readonly outlines: readonly {
    resting: boolean;
    x: number;
    y: number;
    width: number;
    height: number;
  }[];
};

const layer = (page: Page): Promise<Layer> =>
  page.evaluate(() => {
    const at = (element: Element): { x: number; y: number; width: number; height: number } => {
      const box = element.getBoundingClientRect();
      return {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
      };
    };
    return {
      keys: [...document.querySelectorAll(".leader-key")].map((key) => ({
        label: key.textContent ?? "",
        ...at(key),
      })),
      outlines: [...document.querySelectorAll(".leader-outline")].map((outline) => ({
        resting: outline.classList.contains("rest"),
        ...at(outline),
      })),
    };
  });

/** One cap's placement, waiting until the render that puts it there has happened. */
const capAt = async (page: Page, label: string): Promise<Layer["keys"][number]> => {
  await page.waitForFunction(
    (wanted) => [...document.querySelectorAll(".leader-key")].some((badge) => badge.textContent === wanted),
    label,
    { timeout: 8000 },
  );
  const drawn = await layer(page);
  const cap = drawn.keys.find((key) => key.label === label);
  if (cap === undefined) throw new Error(`no ${label} cap`);
  return cap;
};

/** What the focused element is, by class: `<body>` has none and is the thing a lost keyboard
 * looks like. */
const focused = (page: Page): Promise<string> =>
  page.evaluate(() => document.activeElement?.className || document.activeElement?.tagName || "");

/** The terminal's line under the cursor, read from xterm's own buffer. */
type TerminalHost = {
  corviTerminal?: {
    buffer: {
      active: {
        length: number;
        baseY: number;
        cursorY: number;
        getLine(y: number): { translateToString(trim: boolean): string } | undefined;
      };
    };
  };
};

const cursorLine = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const screen = document.querySelector(".terminal-screen") as unknown as TerminalHost | null;
    const buffer = screen?.corviTerminal?.buffer.active;
    if (buffer === undefined) return "";
    const line = buffer.getLine(buffer.baseY + buffer.cursorY);
    return line?.translateToString(true) ?? "";
  });

test("the column's keys sit on its controls, and the next key goes there", async () => {
  if (!usable) return;
  await withPage(browser, async (page) => {
    await open(page);
    // The workspace switcher is in the Workspace section now, not in the brand row.
    expect(await page.locator(".sidebar > .band button").count()).toBe(0);
    expect(await page.locator(".sidebar .workspace-row button.workspace").count()).toBe(1);

    await page.keyboard.press("Control+Space");
    await page.waitForSelector(".leader-layer");
    // The column reads top to bottom: changes, the new idea and its group, the workspace and the
    // pages under it; the bottom row is its own. Wait for the set rather than reading once: a
    // read can land on the commit that is still adding them.
    const columnKeys = ["Q", "W", "E", "T", "Y", "U", "Z", "X"];
    await page.waitForFunction(
      (expected) => {
        const shown = [...document.querySelectorAll(".leader-key")].map((badge) => badge.textContent);
        return expected.every((key) => shown.includes(key));
      },
      columnKeys,
      { timeout: 5000 },
    );

    // A key with nothing mapped leaves the mode on rather than falling through to the page.
    await page.keyboard.press("1");
    expect(await page.locator(".leader-layer").count()).toBe(1);

    // W is the + beside Ideas: it opens the wizard, and the mode ends with the navigation.
    await page.keyboard.press("w");
    await page.waitForSelector(".wizard");
    await page.waitForSelector(".leader-layer", { state: "detached" });
  });
}, 30_000);

test("the column's keys share one rail, and each list wears its box", async () => {
  if (!usable) return;
  await withPage(browser, async (page) => {
    await open(page);
    await waitForIdeas(page, 1);
    await page.keyboard.press("Control+Space");
    await page.waitForSelector(".leader-layer");
    await capAt(page, "O");

    const boxes = await page.evaluate(() => {
      const lists = [...document.querySelectorAll<HTMLElement>(".sidebar .list-group")].map((list) => {
        const box = list.getBoundingClientRect();
        return {
          left: Math.round(box.left),
          right: Math.round(box.right),
          top: Math.round(box.top),
          bottom: Math.round(box.bottom),
        };
      });
      const sidebar = document.querySelector(".sidebar")!.getBoundingClientRect();
      return { lists, sidebarRight: Math.round(sidebar.right), viewport: window.innerHeight };
    });
    // The lane is the column's content edge: its own 10px of padding inside the drag handle.
    const rail = boxes.sidebarRight - 10 - 9;

    // The column reads as one rail: every cap on it, however far its control reaches.
    const drawn = await layer(page);
    for (const label of ["Q", "W", "E", "R", "T", "Y", "U", "I", "O"]) {
      const cap = drawn.keys.find((key) => key.label === label);
      expect({ label, x: cap?.x }).toEqual({ label, x: rail });
    }

    // Each group's cap is at the middle of the part of its list that is on screen, and its box is
    // drawn before anything is numbered.
    expect(drawn.outlines.length).toBe(boxes.lists.length);
    boxes.lists.forEach((list, index) => {
      const middle = (Math.max(list.top, 0) + Math.min(list.bottom, boxes.viewport)) / 2;
      const cap = drawn.keys.find((key) => key.label === ["E", "R"][index]);
      expect(cap).toBeDefined();
      // The cap is centred on that middle: its own top is half a cap above it.
      expect(Math.abs((cap?.y ?? 0) + 9 - middle)).toBeLessThanOrEqual(1);
      const outline = drawn.outlines[index];
      expect(outline?.resting).toBe(true);
      expect(outline?.x).toBe(list.left - 4);
      expect(outline?.width).toBe(list.right - list.left + 8);
    });

    // Numbering a group keeps the same box and makes it the numbered one: what changes is what is
    // inside it. (The changes' group, since a group with one item goes there instead.)
    await page.keyboard.press("r");
    await page.waitForSelector(".leader-key.number");
    const numbered = await layer(page);
    expect(numbered.outlines.length).toBe(1);
    expect(numbered.outlines[0]?.resting).toBe(false);
    expect({ x: numbered.outlines[0]?.x, width: numbered.outlines[0]?.width }).toEqual({
      x: drawn.outlines[1]?.x,
      width: drawn.outlines[1]?.width,
    });
  });
}, 30_000);

test("the chord works from inside the terminal, keeps keys out of it, and gives it back", async () => {
  if (!usable) return;
  await withPage(browser, async (page) => {
    await page.goto(`${url}/changes/LEADER-1/terminals`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 20_000 });
    await page.locator(".terminal-screen").click();
    expect(await focused(page)).toContain("xterm-helper-textarea");

    // The prompt is drawn a moment after the pty starts. Wait for the same line twice: a prompt
    // that is still being drawn would be a baseline the next line is compared against wrongly.
    await page.waitForFunction(
      () => {
        const screen = document.querySelector(".terminal-screen") as unknown as TerminalHost | null;
        const buffer = screen?.corviTerminal?.buffer.active;
        if (buffer === undefined) return false;
        const text = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? "";
        const seen = window as unknown as { stablePrompt?: string };
        if (text.trim() === "") {
          seen.stablePrompt = undefined;
          return false;
        }
        if (seen.stablePrompt === text) return true;
        seen.stablePrompt = text;
        return false;
      },
      null,
      { timeout: 20_000, polling: 100 },
    );
    const line = await cursorLine(page);
    await page.keyboard.press("Control+Space");
    await page.waitForSelector(".leader-layer");
    // The chord is taken at the document, so the shell never saw it (NUL) and the mode is on.
    expect(await focused(page)).toContain("xterm-helper-textarea");

    // An unmapped key does nothing at all: it is not typed into the shell. A short grace is the
    // only gate a negative assertion has; nothing in the page reports "a key did not arrive".
    await page.keyboard.press("1");
    await page.waitForTimeout(200);
    expect(await cursorLine(page)).toBe(line);

    // A held chord repeats: every repeat is taken before xterm's handler sees it.
    await page.evaluate(() => {
      const counts = window as unknown as { xtermKeys: number };
      counts.xtermKeys = 0;
      document.querySelector(".xterm-helper-textarea")?.addEventListener(
        "keydown",
        () => {
          counts.xtermKeys += 1;
        },
        true,
      );
    });
    await page.evaluate(() => {
      const target = document.activeElement ?? document.body;
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          code: "Space",
          key: " ",
          ctrlKey: true,
          repeat: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(await page.evaluate(() => (window as unknown as { xtermKeys: number }).xtermKeys)).toBe(0);
    expect(await page.locator(".leader-layer").count()).toBe(1);
    expect(await cursorLine(page)).toBe(line);

    // Escape leaves the mode and the keyboard is still the terminal's. The key stays *down* for
    // the repeat check below: its auto-repeat belongs to this press, not to the shell.
    await page.keyboard.down("Escape");
    await page.waitForSelector(".leader-layer", { state: "detached" });
    expect(await focused(page)).toContain("xterm-helper-textarea");

    // Without the tail guard the repeat below reaches xterm and sends an escape.
    await page.evaluate(() => {
      const counts = window as unknown as { xtermKeys: number };
      counts.xtermKeys = 0;
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          repeat: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(await page.evaluate(() => (window as unknown as { xtermKeys: number }).xtermKeys)).toBe(0);
    await page.keyboard.up("Escape");

    // A press on empty shell chrome hands the keyboard back to the terminal, not to the body.
    await page.keyboard.press("Control+Space");
    await page.waitForSelector(".leader-layer");
    const band = await page.locator(".sidebar > .band").boundingBox();
    if (!band) throw new Error("the brand row did not lay out");
    await page.mouse.click(band.x + 120, band.y + band.height / 2);
    await page.waitForSelector(".leader-layer", { state: "detached" });
    expect(await focused(page)).toContain("xterm-helper-textarea");

    // No page owns Ctrl+Enter here: it is an unmapped key, taken, and the mode stays — it must not
    // reach TerminalPane, which would encode it into the pty.
    await page.keyboard.press("Control+Space");
    await page.waitForSelector(".leader-layer");
    await page.keyboard.press("Control+Enter");
    expect(await page.locator(".leader-layer").count()).toBe(1);
    await page.keyboard.press("Escape");
    await page.waitForSelector(".leader-layer", { state: "detached" });

    // A press into the terminal is a press on the biggest control there is: xterm focuses its own
    // textarea, and the mode must not hand the keyboard back to the button it started from.
    const gear = page.locator(".sidebar .bottom-row button").first();
    await gear.focus();
    await page.keyboard.press("Control+Space");
    await page.waitForSelector(".leader-layer");
    await page.locator(".terminal-screen").click();
    await page.waitForSelector(".leader-layer", { state: "detached" });
    expect(await focused(page)).toContain("xterm-helper-textarea");

    // G opens another window; the mode ends with the navigation. The first window has to be in
    // the client's list: a change with no window has nothing to add one to.
    await page.waitForSelector('[data-window-index="0"]', { timeout: 10_000 }).catch(async (e) => {
      throw e;
    });
    await page.keyboard.press("Control+Space");
    await page.waitForSelector(".leader-layer");
    await page.keyboard.press("g");
    await page.waitForSelector('[data-window-index="1"]');
    await page.waitForSelector(".leader-layer", { state: "detached" });

    // F numbers the change's terminals; a digit picks one and the mode ends on it.
    await page.keyboard.press("Control+Space");
    await page.waitForSelector(".leader-layer");
    await page.keyboard.press("f");
    await page.waitForSelector(".leader-key.number");
    expect(await page.locator(".leader-key.number").count()).toBe(2);
    await page.keyboard.press("1");
    await page.waitForSelector(".leader-layer", { state: "detached" });
    // The switch is the session's: wait for the tab to say it is the one on screen.
    await page.waitForFunction(() =>
      document.querySelector('.window-tab[data-window-index="0"]')?.classList.contains("current"),
    );
  });
}, 30_000);

test("the wizard's controls are the view's row, and a disabled control takes no key", async () => {
  if (!usable) return;
  await withPage(browser, async (page) => {
    await page.goto(`${url}/new`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".wizard");

    await page.keyboard.press("Control+Space");
    await page.waitForSelector(".leader-layer");
    // Discard, the plan, then the sections' Edit… buttons: the column's keys are there too, and
    // S/D/F belong to the view alone. A (Create idea) is disabled until the id is set, so it has
    // no key of its own — the slot is still A, and pressing it does nothing. The badges are a
    // render away from the controls, so wait for the set rather than reading it once.
    await page.waitForFunction(() => {
      const shown = [...document.querySelectorAll(".leader-key")].map((badge) => badge.textContent);
      return ["S", "D", "F"].every((key) => shown.includes(key)) && !shown.includes("A");
    });
    await page.keyboard.press("a");
    expect(await page.locator(".leader-layer").count()).toBe(1);
    expect(await page.locator(".wizard").count()).toBe(1);

    // S is Discard: the draft goes and the mode with it.
    await page.keyboard.press("s");
    await page.waitForSelector(".wizard", { state: "detached" });
    await page.waitForSelector(".leader-layer", { state: "detached" });
  });
}, 30_000);

test("a menu opened by its key is numbered, and Escape unwinds one layer at a time", async () => {
  if (!usable) return;
  await withPage(browser, async (page) => {
    await open(page);
    await page.keyboard.press("Control+Space");
    await page.waitForSelector(".leader-layer");

    // T opens the workspace switcher, which the mode then numbers.
    await page.keyboard.press("t");
    await page.waitForSelector(".sidebar .workspace-row .menu-items");
    await page.waitForSelector(".leader-key.number");
    // The current workspace is a disabled row: number only what a digit can press.
    expect(await page.locator(".leader-key.number").count()).toBe(
      await page.locator(".sidebar .workspace-row .menu-items button:not(:disabled)").count(),
    );
    expect(await page.locator(".leader-key.number").count()).toBeGreaterThan(0);

    // A press on a menu item runs it: the mode's teardown must not take the row out from under
    // the click. The row it picks is the one the switcher then shows.
    const item = page.locator(".sidebar .workspace-row .menu-items button:not(:disabled)").first();
    const picked = (await item.innerText()).trim();
    await item.click();
    await page.waitForSelector(".sidebar .workspace-row .menu-items", { state: "detached" });
    await page.waitForSelector(".leader-layer", { state: "detached" });
    await page.waitForFunction(
      (wanted) =>
        document.querySelector(".sidebar .workspace-row button.workspace")?.textContent?.includes(wanted),
      picked,
      { timeout: 8000 },
    );

    // The keyboard path, opened again: the first Escape closes the menu and the mode stays.
    await page.keyboard.press("Control+Space");
    await page.waitForSelector(".leader-layer");
    await page.keyboard.press("t");
    await page.waitForSelector(".sidebar .workspace-row .menu-items");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".sidebar .workspace-row .menu-items", { state: "detached" });
    await page.waitForSelector(".leader-key.number", { state: "detached" });
    expect(await page.locator(".leader-layer").count()).toBe(1);

    // A held Escape is one press: its repeat must not reach the mode's exit.
    await page.evaluate(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          repeat: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(await page.locator(".leader-layer").count()).toBe(1);

    // The second is the mode's.
    await page.keyboard.press("Escape");
    await page.waitForSelector(".leader-layer", { state: "detached" });
  });
}, 30_000);

test("a group with one item goes there, and the keys stay up for the next one", async () => {
  if (!usable) return;
  // One idea: E has a single item, so it goes to it instead of numbering the group.
  await withPage(browser, async (page) => {
    await open(page);
    await waitForIdeas(page, 1);
    // This is the one-idea case by construction: LEADER-1 is the only idea before this point.
    expect(await page.locator('[data-leader-item="ideas"]').count()).toBe(1);
    await page.keyboard.press("Control+Space");
    await page.waitForSelector(".leader-layer");
    // The cap is on the list, not on the heading over it: one item is still a group.
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".leader-key")].some((badge) => badge.textContent === "E"),
    );

    // An idea is a place to go: it opens, and the keys stay up for the view or terminal next, with
    // the view's own keys over the page that arrived.
    await page.keyboard.press("e");
    await page.waitForSelector(".change-chrome");
    expect(await page.locator(".leader-layer").count()).toBe(1);
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".leader-key")].some((badge) => badge.textContent === "A"),
    );

    await page.keyboard.press("Escape");
    await page.waitForSelector(".leader-layer", { state: "detached" });
  });
}, 30_000);

test("a numbered group is picked by a digit, or walked with the arrows", async () => {
  if (!usable) return;
  // This test's own second idea: E numbers two items, whatever the other tests left behind.
  const created = await fetch(`${url}/api/changes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "EXTRA-1", title: "Another idea", state: "Ideation" }),
  });
  expect(created.status).toBe(201);

  await withPage(browser, async (page) => {
    await open(page);
    await waitForIdeas(page, 2);
    await page.keyboard.press("Control+Space");
    await page.waitForSelector(".leader-layer");
    await page.keyboard.press("e");
    await page.waitForSelector(".leader-key.number");
    // The numbers are the only keys then: a letter cap would be a key that does nothing.
    expect(await page.locator(".leader-key:not(.number)").count()).toBe(0);
    const ideas = await page.locator('[data-leader-item="ideas"]').count();
    expect(await page.locator(".leader-key.number").count()).toBe(Math.min(ideas, 10));

    // Escape backs out of the numbering and leaves the mode on; a second leaves the mode.
    await page.keyboard.press("Escape");
    await page.waitForSelector(".leader-key.number", { state: "detached" });
    expect(await page.locator(".leader-layer").count()).toBe(1);
    await page.keyboard.press("Escape");
    await page.waitForSelector(".leader-layer", { state: "detached" });

    // The digit picks that item; the idea opens and the keys stay up for the view next.
    await page.keyboard.press("Control+Space");
    await page.waitForSelector(".leader-layer");
    await page.keyboard.press("e");
    await page.waitForSelector(".leader-key.number");
    await page.keyboard.press("1");
    await page.waitForSelector(".change-chrome");
    await page.waitForSelector(".leader-key.number", { state: "detached" });
    expect(await page.locator(".leader-layer").count()).toBe(1);
    await page.keyboard.press("Escape");
    await page.waitForSelector(".leader-layer", { state: "detached" });

    // The arrows move the highlight and Enter takes it — and, being a pick, leaves the mode on.
    await open(page);
    await waitForIdeas(page, 2);
    await page.keyboard.press("Control+Space");
    await page.waitForSelector(".leader-layer");
    await page.keyboard.press("e");
    await page.waitForSelector(".leader-key.number");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".change-chrome");
    expect(await page.locator(".leader-layer").count()).toBe(1);
    await page.keyboard.press("Escape");
    await page.waitForSelector(".leader-layer", { state: "detached" });
  });
}, 30_000);

test("R numbers the active changes, and a digit picks one", async () => {
  if (!usable) return;
  await withPage(browser, async (page) => {
    await open(page);
    await page.waitForFunction(
      () => document.querySelectorAll('[data-leader-item="changes"]').length >= 2,
      null,
      { timeout: 15_000 },
    );
    await page.keyboard.press("Control+Space");
    await page.waitForSelector(".leader-layer");
    await page.keyboard.press("r");
    await page.waitForSelector(".leader-key.number");
    const changes = await page.locator('[data-leader-item="changes"]').count();
    expect(await page.locator(".leader-key.number").count()).toBe(Math.min(changes, 10));
    await page.keyboard.press("2");
    await page.waitForSelector(".change-chrome");
    // A change is somewhere to go: the keys stay up for its views and terminals.
    await page.waitForSelector(".leader-key.number", { state: "detached" });
    expect(await page.locator(".leader-layer").count()).toBe(1);
    await page.keyboard.press("Escape");
    await page.waitForSelector(".leader-layer", { state: "detached" });
  });
}, 30_000);

test("a change's own row is keyed, and its menus are numbered", async () => {
  if (!usable) return;
  await withPage(browser, async (page) => {
    await page.goto(`${url}/changes/STARTED-1`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".change-bar");
    // The row's menus are the change's: they arrive with the record, not with the chrome.
    await page.waitForSelector(".change-bar button.actions");

    await page.keyboard.press("Control+Space");
    await page.waitForSelector(".leader-layer");
    // The badges are computed at render from the controls; wait for the set rather than reading
    // once, which can land on the commit that is still adding them.
    await page.waitForFunction(
      () => {
        const shown = [...document.querySelectorAll(".leader-key")].map((badge) => badge.textContent);
        return ["A", "S", "D", "G", "H", "J"].every((key) => shown.includes(key));
      },
      null,
      { timeout: 5000 },
    );
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll(".leader-key")].map((badge) => badge.textContent),
      ),
    ).not.toContain("F");

    // J opens the actions menu, which is numbered; the mode stays.
    await page.keyboard.press("j");
    await page.waitForSelector(".change-bar [data-leader-menu]");
    await page.waitForSelector(".leader-key.number");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".change-bar [data-leader-menu]", { state: "detached" });
    expect(await page.locator(".leader-layer").count()).toBe(1);
    await page.keyboard.press("Escape");
    await page.waitForSelector(".leader-layer", { state: "detached" });

    // H opens the state menu, which is numbered like any other list; the current state is
    // disabled, so only the states that can be moved to are numbered.
    await page.keyboard.press("Control+Space");
    await page.waitForSelector(".leader-layer");
    await page.keyboard.press("h");
    await page.waitForSelector(".change-bar [data-leader-menu]");
    await page.waitForSelector(".leader-key.number");
    expect(await page.locator(".leader-key.number").count()).toBe(
      await page.locator(".change-bar [data-leader-menu] button:not(:disabled)").count(),
    );
    await page.keyboard.press("Escape");
    await page.waitForSelector(".change-bar [data-leader-menu]", { state: "detached" });
    expect(await page.locator(".leader-layer").count()).toBe(1);
    await page.keyboard.press("Escape");
    await page.waitForSelector(".leader-layer", { state: "detached" });

    // S is Dashboard: the row goes where its badge says.
    await page.keyboard.press("Control+Space");
    await page.waitForSelector(".leader-layer");
    await page.keyboard.press("s");
    await page.waitForSelector(".dashboard-page");
    expect(await page.locator(".change-tabs .tab.current").innerText()).toContain("Dashboard");
  });
}, 30_000);

test("a dialog that opens under the mode takes the keyboard", async () => {
  if (!usable) return;
  await withPage(browser, async (page) => {
    // A guarded page with somewhere to go back to: an unsaved settings edit makes Back ask, and
    // the question is a modal.
    await open(page);
    // The bottom row's first control is Settings (the gear's own SVG also names it, so match the
    // button element rather than the name).
    await page.locator(".sidebar .bottom-row button").first().click();
    await page.waitForSelector("nav.tabs");
    await page.getByLabel("Repositories directory").fill("/tmp/a-repositories-draft");
    await page.keyboard.press("Control+Space");
    await page.waitForSelector(".leader-layer");
    // `[` is Back while the mode is on; the guard holds it and opens its dialog.
    await page.keyboard.press("[");
    const prompt = page.locator("dialog", { hasText: "Unsaved settings" });
    await prompt.waitFor();
    // The dialog owns the keyboard from the moment it is there: the keys go with it.
    await page.waitForSelector(".leader-layer", { state: "detached" });
    // And Escape is the dialog's (Stay), not a mode key.
    await page.keyboard.press("Escape");
    await prompt.waitFor({ state: "detached" });
    expect(new URL(page.url()).pathname).toBe("/settings");
  });
}, 30_000);

test("the chord does not press a dialog's focused button", async () => {
  if (!usable) return;
  await withPage(browser, async (page) => {
    await page.goto(`${url}/changes/LEADER-1`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".change-bar");
    // The cheat sheet is a modal dialog whose first focusable control is Close; Space is a
    // button's activation key, so the chord must be taken rather than left to it.
    await page.locator(".change-bar button", { hasText: "Actions" }).click();
    await page.getByRole("button", { name: "terminal cheat sheet" }).click();
    await page.waitForSelector("dialog[open]");
    await page.locator("dialog[open] button", { hasText: "Close" }).focus();

    await page.keyboard.press("Control+Space");
    expect(await page.locator("dialog[open]").count()).toBe(1);
    expect(await page.locator(".leader-layer").count()).toBe(0);
  });
}, 30_000);

test("Ctrl+Enter creates the idea, and a dialog's own Ctrl+Enter is the dialog's", async () => {
  if (!usable) return;
  await withPage(browser, async (page) => {
    await page.goto(`${url}/new`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".wizard-body");
    await page.getByLabel("Change id").fill("KEYS-7");

    // The repositories browser is a modal dialog: the leader does not open over it, its Ctrl+Enter
    // closes it, and the page under it is not created. Closing it puts the keyboard back on the
    // "Edit…" that opened it.
    const edit = page.locator(".wizard-sections .repos-field").getByRole("button", { name: "Edit…" });
    await edit.click();
    await page.waitForSelector("dialog[open]");
    await page.keyboard.press("Control+Space");
    expect(await page.locator(".leader-layer").count()).toBe(0);
    await page.keyboard.press("Control+Enter");
    await page.waitForSelector("dialog[open]", { state: "detached" });
    expect(await page.locator(".wizard").count()).toBe(1);
    expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.textContent)).toContain(
      "Edit",
    );

    // Outside the dialog the same key is the wizard's — with the keycaps up too, since the hint
    // on Create idea advertises it there. An open menu is the mode's and goes with it.
    await page.keyboard.press("Control+Space");
    await page.waitForSelector(".leader-layer");
    await page.keyboard.press("t");
    await page.waitForSelector(".sidebar .workspace-row [data-leader-menu]");
    await page.keyboard.press("Control+Enter");
    await page.waitForSelector(".change-chrome");
    await page.waitForSelector(".leader-layer", { state: "detached" });
    await page.waitForSelector(".sidebar .workspace-row [data-leader-menu]", { state: "detached" });
    expect(new URL(page.url()).pathname).toBe("/changes/KEYS-7");
  });
}, 30_000);

test("Ctrl+Enter in the plan editor is the wizard's, not the editor's", async () => {
  if (!usable) return;
  await withPage(browser, async (page) => {
    await page.goto(`${url}/new`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".wizard-body");
    // CodeMirror binds Mod-Enter to insertBlankLine: the wizard takes the key ahead of it, so the
    // plan is not edited and nothing is created while the id is still empty.
    await page.locator(".cm-content").click();
    const lines = await page.locator(".cm-line").count();
    await page.keyboard.press("Control+Enter");
    // Taken at the document capture, before CodeMirror's handler would run: the count cannot have
    // moved, and waiting for a pause would only hide a leak that had.
    expect(await page.locator(".cm-line").count()).toBe(lines);
    expect(await page.locator(".wizard").count()).toBe(1);

    await page.getByLabel("Change id").fill("EDITOR-9");
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+Enter");
    await page.waitForSelector(".change-chrome");
    expect(new URL(page.url()).pathname).toBe("/changes/EDITOR-9");
  });
}, 30_000);

test("on a narrow window the keys open the column, and the toggle closes both", async () => {
  if (!usable) return;
  await withPage(
    browser,
    async (page) => {
      // Narrow enough for the drawer: the column is off-screen and out of the tab order, so its
      // keys would be nowhere. It is in the DOM, but not visible, which is the point.
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".sidebar .list", { state: "attached" });
      expect(await page.locator(".sidebar.open").count()).toBe(0);

      await page.keyboard.press("Control+Space");
      await page.waitForSelector(".leader-layer");
      await page.waitForSelector(".sidebar.open");

      // A control in the auto-opened drawer takes the press: the mode ends on mousedown, the
      // drawer closes after the click, and the navigation still happens.
      await page.locator(".sidebar .bottom-row button").first().click();
      await page.waitForFunction(() => location.pathname === "/settings");
      await page.waitForSelector(".sidebar.open", { state: "detached" });

      // Back to the overview for the keyboard paths.
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".sidebar .list", { state: "attached" });
      await page.keyboard.press("Control+Space");
      await page.waitForSelector(".leader-layer");
      await page.waitForSelector(".sidebar.open");

      // A menu under the drawer is the mode's layer, not the drawer's: Escape closes the menu and
      // leaves the drawer and the mode up.
      await page.keyboard.press("t");
      await page.waitForSelector(".sidebar [data-leader-menu]");
      await page.waitForSelector(".leader-key.number");
      await page.keyboard.press("Escape");
      await page.waitForSelector(".sidebar [data-leader-menu]", { state: "detached" });
      expect(await page.locator(".sidebar.open").count()).toBe(1);
      expect(await page.locator(".leader-layer").count()).toBe(1);

      // The toggle owns its press: the click ends the mode and closes the drawer it opened.
      await page.locator(".drawer-toggle").click();
      await page.waitForSelector(".leader-layer", { state: "detached" });
      await page.waitForSelector(".sidebar.open", { state: "detached" });

      // Escape does the same when the mode is opened again.
      await page.keyboard.press("Control+Space");
      await page.waitForSelector(".leader-layer");
      await page.waitForSelector(".sidebar.open");
      await page.keyboard.press("Escape");
      await page.waitForSelector(".leader-layer", { state: "detached" });
      await page.waitForSelector(".sidebar.open", { state: "detached" });
    },
    { width: 600, height: 800 },
  );
}, 30_000);

test("a press while the mode is off does not keep the drawer open later", async () => {
  if (!usable) return;
  await withPage(
    browser,
    async (page) => {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".sidebar .list", { state: "attached" });
      // Two ordinary presses with the mode off, and no goto in between: the flag they touch must
      // not outlive them.
      await page.locator(".drawer-toggle").click();
      await page.locator(".drawer-toggle").click();
      await page.keyboard.press("Control+Space");
      await page.waitForSelector(".sidebar.open");
      await page.keyboard.press("Escape");
      await page.waitForSelector(".leader-layer", { state: "detached" });
      await page.waitForSelector(".sidebar.open", { state: "detached" });
    },
    { width: 600, height: 800 },
  );
}, 30_000);

test("a window narrowing under the mode gives it the drawer", async () => {
  if (!usable) return;
  await withPage(browser, async (page) => {
    await open(page);
    await page.keyboard.press("Control+Space");
    await page.waitForSelector(".leader-layer");
    expect(await page.locator(".sidebar.open").count()).toBe(0);

    await page.setViewportSize({ width: 600, height: 800 });
    await page.waitForSelector(".sidebar.open");

    await page.keyboard.press("Escape");
    await page.waitForSelector(".leader-layer", { state: "detached" });
    await page.waitForSelector(".sidebar.open", { state: "detached" });
  });
}, 30_000);

test("a list taller than the window keeps its key at the middle of what is on screen", async () => {
  if (!usable) return;
  // Enough ideas that the column scrolls in a short window: the whole list's middle is below the
  // fold, and a cap there would be a key nobody can see.
  for (let index = 0; index < 30; index += 1) {
    const created = await fetch(`${url}/api/changes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: `MANY-${index}`, title: `An idea, number ${index}`, state: "Ideation" }),
    });
    expect(created.status).toBe(201);
  }

  await withPage(
    browser,
    async (page) => {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".sidebar .list");
      await page.waitForFunction(
        () => document.querySelectorAll('[data-leader-item="ideas"]').length >= 30,
        null,
        { timeout: 20_000 },
      );
      await page.keyboard.press("Control+Space");
      await page.waitForSelector(".leader-layer");
      const cap = await capAt(page, "E");
      const list = await page.evaluate(() => {
        const box = document.querySelector<HTMLElement>(".sidebar .list-group")!.getBoundingClientRect();
        return { top: Math.round(box.top), bottom: Math.round(box.bottom), viewport: window.innerHeight };
      });
      // Taller than the window: the middle of the whole list would be off the bottom.
      expect(list.bottom).toBeGreaterThan(list.viewport);
      const middle = (Math.max(list.top, 0) + Math.min(list.bottom, list.viewport)) / 2;
      expect(Math.abs(cap.y + 9 - middle)).toBeLessThanOrEqual(1);
      expect(cap.y).toBeGreaterThanOrEqual(0);
      expect(cap.y).toBeLessThanOrEqual(list.viewport - 18);
    },
    { width: 1280, height: 520 },
  );
}, 40_000);

test("the terminal tabs wear their box, and their key sits over the whole group", async () => {
  if (!usable) return;
  await withPage(browser, async (page) => {
    await page.goto(`${url}/changes/STARTED-2/terminals`, { waitUntil: "domcontentloaded" });
    // The session starts with the page, and its first window is what the + adds beside: until then
    // the + has nothing to add to.
    await page.waitForSelector('.change-tabs [data-window-index="0"]', { timeout: 20_000 });
    // A second window, so the group is a strip rather than one tab.
    await page.locator(".change-tabs button.window-tab.new").click();
    await page.waitForSelector('.change-tabs [data-window-index="1"]', { timeout: 20_000 });

    await page.keyboard.press("Control+Space");
    await page.waitForSelector(".leader-layer");
    const cap = await capAt(page, "F");
    const drawn = await layer(page);

    const strip = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll<HTMLElement>(".change-tabs [data-window-index]")];
      const first = tabs[0]!.getBoundingClientRect();
      const last = tabs.at(-1)!.getBoundingClientRect();
      return {
        left: Math.round(first.left),
        right: Math.round(last.right),
        top: Math.round(first.top),
        bottom: Math.round(first.bottom),
      };
    });

    // The box is around the tabs, drawn before the group is numbered.
    const box = drawn.outlines.find((outline) => Math.abs(outline.x - (strip.left - 4)) <= 1);
    expect(box?.resting).toBe(true);
    expect(Math.abs((box?.width ?? 0) - (strip.right - strip.left + 8))).toBeLessThanOrEqual(1);

    // The key is centred on the group's trailing edge, and its own centre on the strip's top edge:
    // over the whole strip rather than on the first tab, and clear of the tabs' labels. (The
    // layer's coordinates are fractional; the tab boxes read here are rounded.)
    expect(Math.abs(cap.x + 9 - strip.right)).toBeLessThanOrEqual(1);
    expect(Math.abs(cap.y + 9 - strip.top)).toBeLessThanOrEqual(1);

    // A window is where you type: picking one puts the keys away rather than leaving them over the
    // shell.
    await page.keyboard.press("f");
    await page.waitForSelector(".leader-key.number");
    await page.keyboard.press("1");
    await page.waitForSelector(".leader-layer", { state: "detached" });
  });
}, 40_000);
