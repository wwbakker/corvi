import { test, expect, beforeAll, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { runSh, testRun, testTempDir } from "./helpers.ts";
import { isLinux } from "../src/capabilities/os.ts";
import { terminalPath } from "../src/terminals/server/index.ts";

/**
 * The terminal is process plumbing — ttyd spawned, tmux attached, both cleaned up — so the only
 * test worth having drives the real thing through a real browser. It is skipped where the tools
 * are missing rather than failing, since the rest of IWE works fine without them.
 */
/** Poll until a value is what it should be: the strip refreshes on its own timer. */
async function until<T>(read: () => Promise<T>, want: T, tries = 50): Promise<T> {
  let last = await read();
  for (let i = 0; i < tries && last !== want; i++) {
    await Bun.sleep(200);
    last = await read();
  }
  return last;
}

/** tmux, on the private server this test runs: Bun.spawn does not pick up an environment
 * variable set after it started, so it is passed explicitly. */
async function tmux(...args: string[]): Promise<string> {
  const proc = Bun.spawn(["tmux", ...args], {
    env: { ...process.env, TMUX_TMPDIR: tmp },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return out.trim();
}

const have = async (tool: string): Promise<boolean> => (await runSh(["which", tool])).code === 0;
const usable = (await have("ttyd")) && (await have("tmux"));

/** The renderer is a performance decision, not a detail. This machine's WebKitGTK can only take
 * the software-composited path (accelerated compositing presents canvas updates a frame late),
 * and in that path ttyd's WebGL default and 2D canvas fallback peg a core on ordinary terminal
 * output — the whole app then lags by hundreds of milliseconds. xterm's DOM renderer damages
 * only the changed text. macOS keeps WebGL, where the compositor is correct and cheap. */
test("the terminal asks for the renderer its engine can afford", () => {
  const path = terminalPath("PROJ-TERM");
  if (isLinux) expect(path).toBe("/terminal/PROJ-TERM/?rendererType=dom");
  else expect(path).toBe("/terminal/PROJ-TERM/");
});

let tmp: string;
let browser: Browser;
let port: number;
let server: ReturnType<typeof Bun.spawn>;
const id = "PROJ-TERM";
const session = `iwe-${id}`;

beforeAll(async () => {
  if (!usable) return;
  tmp = await testTempDir("term");
  // A tmux server of our own, so the test can change server options and kill everything
  // afterwards without touching the sessions you are working in. TMUX_TMPDIR alone does not do
  // that when the suite is run from inside tmux: $TMUX wins, and every tmux command here —
  // `kill-server` included — would reach the server you are working in. So it is deleted, not
  // just overridden.
  delete process.env.TMUX;
  process.env.TMUX_TMPDIR = tmp;
  port = 4300 + Math.floor(Math.random() * 200);
  server = Bun.spawn(["bun", "src/server.ts", `--iwe-test-run=${testRun()}`], {
    env: { ...process.env, IWE_ROOT: join(tmp, "changes"), IWE_PORT: String(port) },
    stdout: "ignore",
    stderr: process.env.IWE_TEST_LOUD ? "inherit" : "ignore",
  });
  // The repository is only needed because a change must have one; the terminal ignores it.
  const repo = join(tmp, "repo");
  await runSh(["git", "init", "-b", "main", repo]);
  for (let i = 0; i < 40; i++) {
    if ((await fetch(`http://127.0.0.1:${port}/api/changes`).catch(() => null))?.ok) break;
    await Bun.sleep(100);
  }
  await fetch(`http://127.0.0.1:${port}/api/changes`, {
    method: "POST",
    body: JSON.stringify({ id, repos: [repo] }),
  });
  browser = await chromium.launch();
});

afterAll(async () => {
  if (!usable) return;
  await browser?.close();
  server?.kill();
  await runSh(["pkill", "-f", `new-session -A -s ${session}`]);
  await tmux("kill-server"); // ours alone: TMUX_TMPDIR points at the temporary directory
  await rm(tmp, { recursive: true, force: true });
});

test.skipIf(!usable)("a terminal outlives the server that started it", async () => {
  const before = await (await fetch(`http://127.0.0.1:${port}/api/changes/${id}/terminal`)).json();

  // Restart, as happens constantly while working on IWE itself.
  server.kill();
  await Bun.sleep(500);
  server = Bun.spawn(["bun", "src/server.ts", `--iwe-test-run=${testRun()}`], {
    env: { ...process.env, IWE_ROOT: join(tmp, "changes"), IWE_PORT: String(port) },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    if ((await fetch(`http://127.0.0.1:${port}/api/changes`).catch(() => null))?.ok) break;
    await Bun.sleep(100);
  }

  // The same ttyd, so the page keeps working and the shells keep running.
  const after = await (await fetch(`http://127.0.0.1:${port}/api/changes/${id}/terminal`)).json();
  expect(after).toEqual(before);
}, 60_000);

test.skipIf(!usable)("the terminal tab runs a shell in the change directory", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  // Straight to the terminal page: the navigation column has no "Terminals" button, because
  // "the terminals" is not something to look at — a window is.
  await page.goto(`http://127.0.0.1:${port}/changes/${id}/terminals`);
  await page.waitForSelector(".terminal iframe");

  // The terminal is ttyd's to draw; what the shell did is read from the shell's own output file.
  const term = page.frameLocator(".terminal iframe").locator("body");
  await term.waitFor({ state: "visible", timeout: 15_000 });
  await term.click();

  // tmux only starts when the browser connects, and the shell only prompts after that.
  const started = async (): Promise<boolean> => (await tmux("ls")).includes(session);
  for (let i = 0; i < 50 && !(await started()); i++) await Bun.sleep(200);
  expect(await started()).toBe(true);
  await Bun.sleep(1000); // the shell's own startup, before it can read a command

  await page.keyboard.type("pwd > out.txt\n");
  for (let i = 0; i < 30; i++) {
    if (await Bun.file(join(tmp, "changes", id, "out.txt")).exists()) break;
    await Bun.sleep(200);
  }
  expect(await Bun.file(join(tmp, "changes", id, "out.txt")).text()).toBe(
    `${join(tmp, "changes", id)}\n`,
  );

  // A second window is tmux's own business, and the prefix key has to reach it through xterm.js.
  await page.keyboard.press("Control+b");
  await page.keyboard.press("c");
  await Bun.sleep(800);
  expect((await tmux("list-windows", "-t", session)).split("\n").length).toBe(2);

  // Scrolling should scroll, which is tmux's mouse mode rather than the shell's history.
  expect(await tmux("show-options", "-t", session, "mouse")).toBe("mouse on");

  // The navigation column lists tmux's windows, and its entries are tmux's own commands.
  const strip = page.locator(".sidebar .entry.window");
  expect(await until(() => strip.count(), 2)).toBe(2); // the shell, and the ctrl-b c one above
  // Windows are labelled by where they are, so a window that walks into a repository says so.
  // Until-poll rather than an instant read: a window that has just been created still shows the
  // tmux that forked it as its command, for as long as the shell takes to exec.
  expect(
    await until(
      async () => (await strip.allInnerTexts()).every((l) => l.trim() === id),
      true,
    ),
  ).toBe(true);
  await page.keyboard.type(`cd ${join(tmp, "repo")}\n`);
  expect(await until(async () => (await strip.allInnerTexts()).join(" "), `${id} repo`)).toBe(
    `${id} repo`,
  );

  // An agent that says what it is doing is taken at its word: `node` never would. This is what
  // pi's busy-title extension sets on its own pane.
  await page.keyboard.type("tmux set -p @agent_status working\n");
  expect(
    await until(async () => (await strip.allInnerTexts())[1]?.trim(), "repo - (pi working)"),
  ).toBe("repo - (pi working)");
  // The name pi gives the session replaces the composed label, in the column and in the tabs
  // alike; the state is still there, in the icon's colour.
  await page.keyboard.type("tmux set -p @agent_session_name 'Build PROJ-1681'\n");
  expect(
    await until(async () => (await strip.allInnerTexts())[1]?.trim(), "Build PROJ-1681"),
  ).toBe("Build PROJ-1681");
  await page.keyboard.type("tmux set -p -u @agent_session_name\n");
  expect(
    await until(async () => (await strip.allInnerTexts())[1]?.trim(), "repo - (pi working)"),
  ).toBe("repo - (pi working)");
  await page.keyboard.type("tmux set -p @agent_status waiting\n");
  expect(
    await until(async () => (await strip.allInnerTexts())[1]?.trim(), "repo - (pi waiting)"),
  ).toBe("repo - (pi waiting)");
  // Unset when the agent leaves, and the window is a shell in a directory again.
  await page.keyboard.type("tmux set -p -u @agent_status\n");
  expect(await until(async () => (await strip.allInnerTexts())[1]?.trim(), "repo")).toBe("repo");

  // A new window starts where the current one is, not back at the change: the second window
  // walked into the repository above, so this one starts there too.
  await page.locator(".sidebar .new-window").click();
  expect(await until(() => strip.count(), 3)).toBe(3);
  expect((await tmux("list-windows", "-t", session)).split("\n").length).toBe(3);
  expect(await until(async () => (await strip.allInnerTexts())[2]?.trim(), "repo")).toBe("repo");

  // cmd-t does the same, from inside the terminal, where the keyboard is.
  await page.keyboard.press("Meta+t");
  expect(await until(() => strip.count(), 4)).toBe(4);

  // Selecting one makes it tmux's current window. The first entry is the lowest index, which is
  // the session's base: 0 by default, but a user's ~/.tmux.conf may shift it — the private
  // server this test runs still reads that file.
  const baseIndex = (await tmux("show-window-option", "-g", "base-index")).trim().split(" ").pop() ?? "0";
  await strip.first().click();
  await Bun.sleep(500);
  expect(await tmux("display-message", "-p", "-t", session, "#{window_index}")).toBe(baseIndex);

  // Clicking a window must not take the keyboard with it: you click a window to type in it.
  await page.locator(".sidebar .new-window").click();
  await Bun.sleep(1000);
  await page.keyboard.type("pwd > typed-after-click.txt\n");
  for (let i = 0; i < 30; i++) {
    if (await Bun.file(join(tmp, "changes", id, "typed-after-click.txt")).exists()) break;
    await Bun.sleep(200);
  }
  expect(await Bun.file(join(tmp, "changes", id, "typed-after-click.txt")).exists()).toBe(true);

  // Asking twice reuses the same ttyd instead of leaving one behind per visit.
  const first = await (await fetch(`http://127.0.0.1:${port}/api/changes/${id}/terminal`)).json();
  const again = await (await fetch(`http://127.0.0.1:${port}/api/changes/${id}/terminal`)).json();
  expect(again).toEqual(first);

  await page.close();
}, 60_000);

test.skipIf(!usable)("the terminal page's bar is its windows, not the change's controls", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`http://127.0.0.1:${port}/changes/${id}/terminals`);
  await page.waitForSelector(".terminal iframe");

  // The change's own controls — id, name, state, actions — are the dashboard's: they say
  // nothing while a shell has the keyboard, and the windows are what you switch between.
  expect(await page.locator("header h2").count()).toBe(0);
  expect(await page.locator("header select").count()).toBe(0);

  // The first tab is the change's overview, not a window: the terminal page is not a one-way
  // door. Then a tab per tmux window, and the key reference on the right.
  const allTabs = page.locator(".window-tab");
  expect((await allTabs.first().innerText()).trim()).toBe("Overview");
  const tabs = page.locator(".window-tab:not(.new):not(.overview)");
  const windows = (await tmux("list-windows", "-t", session)).split("\n").length;
  expect(await until(() => tabs.count(), windows)).toBe(windows);
  expect(await page.getByRole("button", { name: "tmux cheat sheet" }).count()).toBe(1);

  // The current window's tab is marked the way the column marks its own: filled, white text and
  // icon, rounded only at the top, and sitting on the terminal rather than above a gap or line.
  const currentTab = page.locator(".window-tab.current");
  const bar = page.locator(".terminal-bar");
  expect(await currentTab.count()).toBe(1);
  const marked = await currentTab.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      background: style.backgroundColor,
      radius: style.borderRadius,
      label: getComputedStyle(el.querySelector(".label")!).color,
    };
  });
  expect(marked.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(marked.radius).toBe("6px 6px 0px 0px");
  expect(marked.label).toBe("rgb(255, 255, 255)");
  expect(await bar.evaluate((el) => getComputedStyle(el).borderBottomWidth)).toBe("0px");

  // The state icon keeps the column's colours — green while its agent is working — even on the
  // tab you are looking at, where only the label goes white. This is the working pi window.
  const active = await tmux("display-message", "-p", "-t", session, "#{window_index}");
  await tmux("set-option", "-p", "-t", `${session}:${active}`, "@agent_status", "working");
  const green = currentTab.locator(".state-ok");
  expect(await until(() => green.count(), 1)).toBe(1);
  expect(await green.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(63, 185, 80)");
  expect(
    await currentTab.evaluate((el) => getComputedStyle(el.querySelector(".label")!).color),
  ).toBe("rgb(255, 255, 255)");
  await tmux("set-option", "-p", "-t", `${session}:${active}`, "-u", "@agent_status");

  // The terminal fills the space: no gap under the tabs or against the column, a small margin
  // on the right — half the column's own left padding — and none below.
  const [inner, box, barBox, currentBox, sidebar] = await Promise.all([
    page.evaluate(() => [window.innerWidth, window.innerHeight] as const),
    page.locator(".terminal iframe").boundingBox(),
    bar.boundingBox(),
    currentTab.boundingBox(),
    page.locator(".sidebar").boundingBox(),
  ]);
  expect(Math.abs(currentBox!.y + currentBox!.height - (barBox!.y + barBox!.height))).toBeLessThanOrEqual(1);
  expect(Math.abs(box!.y - (barBox!.y + barBox!.height))).toBeLessThanOrEqual(1);
  expect(Math.abs(box!.x - (sidebar!.x + sidebar!.width))).toBeLessThanOrEqual(1);
  expect(inner[0] - (box!.x + box!.width)).toBeGreaterThanOrEqual(2);
  expect(inner[0] - (box!.x + box!.width)).toBeLessThanOrEqual(6);
  expect(box!.y + box!.height).toBeGreaterThanOrEqual(inner[1] - 1);

  // And the overview tab goes back to the page the change is about — where the same strip is
  // waiting at the very top, above the change's header, with the overview tab where you are.
  await allTabs.first().click();
  await page.waitForSelector(".widget");
  expect(new URL(page.url()).pathname).toBe(`/changes/${id}`);
  expect(await page.locator(".window-bar .window-tab.overview.current").count()).toBe(1);
  expect(await page.locator(".window-bar .window-tab:not(.new):not(.overview)").count()).toBe(
    windows,
  );
  const [topBar, titleBar, columnBox] = await Promise.all([
    page.locator(".window-bar").boundingBox(),
    page.locator("header").boundingBox(),
    page.locator(".sidebar").boundingBox(),
  ]);
  const viewport = await page.evaluate(() => [window.innerWidth, window.innerHeight] as const);
  // Above the title, and against the top, the column and the right edge of the content area
  // rather than under the page's own padding — the terminal bar's position, on a page that
  // keeps its padding.
  expect(topBar!.y).toBeLessThan(titleBar!.y);
  expect(topBar!.y).toBe(0);
  expect(Math.abs(topBar!.x - (columnBox!.x + columnBox!.width))).toBeLessThanOrEqual(1);
  expect(Math.abs(topBar!.x + topBar!.width - viewport[0])).toBeLessThanOrEqual(1);

  // And a window tab from here opens that terminal, rather than selecting a window you cannot
  // see: on the dashboard the tab is the way in.
  await page.locator(".window-bar .window-tab:not(.new):not(.overview)").first().click();
  await page.waitForSelector(".terminal iframe");
  expect(new URL(page.url()).pathname).toBe(`/changes/${id}/terminals`);
  await page.close();
}, 60_000);

test.skipIf(!usable)("a window tab dragged onto another takes its place", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`http://127.0.0.1:${port}/changes/${id}/terminals`);
  await page.waitForSelector(".terminal iframe");
  const tabs = page.locator(".window-tab:not(.new):not(.overview)");
  await tabs.first().waitFor();
  expect(await tabs.count()).toBeGreaterThanOrEqual(2);

  // Window ids rather than indices: a swap changes which window holds which index, so the
  // index list would read the same afterwards.
  const order = (): Promise<string> => tmux("list-windows", "-t", session, "-F", "#{window_id}");
  const before = (await order()).split("\n");
  const source = (await tabs.nth(0).boundingBox())!;
  const target = (await tabs.nth(1).boundingBox())!;
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 5 });
  // Mid-drag the strip says which window is moving, and which one it is over.
  expect(await until(() => page.locator(".window-tab.dragging").count(), 1)).toBe(1);
  expect(await until(() => page.locator(".window-tab.drop-target").count(), 1)).toBe(1);
  await page.mouse.up();

  // The dragged window takes the other's place, the one it displaced shifts left, and the fixed
  // ends of the strip have not moved.
  const expected = [before[1], before[0], ...before.slice(2)].join("\n");
  expect(await until(order, expected)).toBe(expected);
  expect((await page.locator(".window-tab").first().innerText()).trim()).toBe("Overview");
  expect((await page.locator(".window-tab").last().innerText()).trim()).toBe("new");
  await page.close();
}, 60_000);

test.skipIf(!usable)("a window that starts waiting is announced, and the notice opens it", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  // Stand in for the app's host: the page posts to window.webkit.messageHandlers.iwe in
  // WKWebView and WebKitGTK alike.
  await page.addInitScript(() => {
    const store: unknown[] = [];
    (window as unknown as { __notices: unknown[] }).__notices = store;
    (window as unknown as { webkit: unknown }).webkit = {
      messageHandlers: { iwe: { postMessage: (message: unknown) => store.push(message) } },
    };
  });
  await page.goto(`http://127.0.0.1:${port}/changes/${id}`);
  await page.waitForSelector(".widget");
  // Let the watcher start. The notice is an edge into "waiting", and the server only reports an
  // edge it watched happen: a window it first sees already waiting seeds the picture and says
  // nothing, so a page connecting does not replay every agent that is already blocked. Working
  // first, and then waiting for the server itself to have read that non-waiting state —
  // /api/terminals is the same presented read the watcher diffs — makes the edge real rather
  // than timed.
  await page.waitForTimeout(1000);

  const active = await tmux("display-message", "-p", "-t", session, "#{window_index}");
  const windowId = await tmux("display-message", "-p", "-t", `${session}:${active}`, "#{window_id}");
  await tmux("set-option", "-p", "-t", `${session}:${active}`, "@agent_status", "working");

  /** The windows the server reports for this change: the presented read the watcher diffs. */
  const presented = async (): Promise<{ attention?: boolean }[]> =>
    (await fetch(`http://127.0.0.1:${port}/api/terminals`).then((r) => r.json()))[id] ?? [];
  expect(
    await until(async () => (await presented()).some((w) => w.attention === false), true),
  ).toBe(true);
  // One full watcher tick, so its diff has recorded the non-waiting window before the flip.
  await page.waitForTimeout(1700);
  await tmux("set-option", "-p", "-t", `${session}:${active}`, "@agent_session_name", "Build the thing");
  await tmux("set-option", "-p", "-t", `${session}:${active}`, "@agent_last_message", "I fixed the layout.");
  await tmux("set-option", "-p", "-t", `${session}:${active}`, "@agent_status", "waiting");

  const notices = (): Promise<unknown[]> =>
    page.evaluate(() => (window as unknown as { __notices: unknown[] }).__notices);
  expect(await until(async () => (await notices()).length === 1, true)).toBe(true);
  expect((await notices())[0]).toMatchObject({
    kind: "notify",
    title: "Build the thing",
    subtitle: id,
    body: "I fixed the layout.",
    change: id,
    window: windowId,
    sound: true,
  });

  // What the host does with a click: activate, then call the page's own entry point. It resolves
  // the window by its id against the live list, so a reorder after the notice is harmless.
  await page.evaluate(
    ([change, windowId]) => {
      // `window` here is the page's, not the window id beside it.
      window.iwe.openWindow(change!, windowId!);
    },
    [id, windowId] as const,
  );
  await page.waitForSelector(".terminal iframe");
  expect(new URL(page.url()).pathname).toBe(`/changes/${id}/terminals`);

  // Looking straight at it is the one silent case. Working long enough for the watcher to see
  // it, then waiting again: the host hears nothing this time.
  expect(
    await page.evaluate(
      () => document.hasFocus() || document.activeElement?.tagName === "IFRAME",
    ),
  ).toBe(true);
  await tmux("set-option", "-p", "-t", `${session}:${active}`, "@agent_status", "working");
  await page.waitForTimeout(2500);
  await tmux("set-option", "-p", "-t", `${session}:${active}`, "@agent_status", "waiting");
  await page.waitForTimeout(3500);
  expect((await notices()).length).toBe(1);

  for (const option of ["@agent_status", "@agent_session_name", "@agent_last_message"]) {
    await tmux("set-option", "-p", "-t", `${session}:${active}`, "-u", option);
  }
  await page.close();
}, 60_000);

test.skipIf(!usable)("a dead ttyd is replaced without taking the session with it", async () => {
  // A ttyd can die while its session lives: a crash, a lost note, or someone deleting the
  // process. Starting a replacement must attach to that session, not end it. The cleanup that
  // clears a stale ttyd must not match the tmux server's own command line as well: that would
  // take the server, and with it every window, leaving a fresh one-window session in its place.
  await tmux("set-option", "-g", "destroy-unattached", "off"); // a developer's tmux.conf must not decide this
  await tmux("new-window", "-t", session, "-d"); // more than one window, so a lost session is unmistakable
  const before = (await tmux("list-windows", "-t", session)).split("\n").length;

  const note = (await Bun.file(join(tmp, "changes", id, "terminal.json")).json()) as { pid: number };
  process.kill(note.pid);
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(note.pid, 0);
      await Bun.sleep(100);
    } catch {
      break;
    }
  }

  // Asking again starts a fresh ttyd, which must find the session and attach to it.
  await fetch(`http://127.0.0.1:${port}/api/changes/${id}/terminal`);
  expect((await tmux("list-windows", "-t", session)).split("\n").length).toBe(before);
}, 60_000);

test.skipIf(!usable)("the terminal fills the frame, with no scrollbar of its own", async () => {
  // xterm's stylesheet gives the viewport `overflow-y: scroll` whatever the scrollback is, and
  // the fit addon reserves the scrollbar's width when there is scrollback to scroll. On a machine
  // that shows scrollbars always, the two together are a pale empty bar down the right of the
  // terminal and a grid a couple of columns narrower than the frame. tmux owns scrolling (mouse
  // mode), so the terminal is started with no scrollback and the injected style takes the bar
  // itself away.
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`http://127.0.0.1:${port}/changes/${id}/terminals`);
  const screen = page.frameLocator(".terminal iframe").locator(".xterm-screen");
  await screen.waitFor({ timeout: 15_000 });

  // The options arrive over the socket after the first fit, so the scrollback may still be the
  // default for a moment.
  const shape = (): Promise<{
    scrollback: number;
    overflowY: string;
    cellWidth: number;
    rightGap: number;
    padding: number;
  }> =>
    screen.evaluate((el) => {
      const doc = el.ownerDocument;
      const term = (doc.defaultView as unknown as {
        term: { cols: number; options: { scrollback: number } };
      }).term;
      const viewport = doc.querySelector(".xterm-viewport") as HTMLElement;
      const root = doc.querySelector(".xterm") as HTMLElement;
      const box = el.getBoundingClientRect();
      return {
        scrollback: term.options.scrollback,
        overflowY: getComputedStyle(viewport).overflowY,
        cellWidth: box.width / term.cols,
        rightGap: viewport.getBoundingClientRect().right - box.right,
        padding: parseFloat(getComputedStyle(root).paddingRight),
      };
    });
  let facts = await shape();
  for (let i = 0; i < 25 && facts.scrollback !== 0; i++) {
    await Bun.sleep(200);
    facts = await shape();
  }

  expect(facts.scrollback).toBe(0);
  expect(facts.overflowY).toBe("hidden");
  // The grid may be short by less than one cell — columns are whole characters — but no more.
  // A scrollbar is a good deal wider than one cell, which is the strip this catches.
  expect(facts.rightGap).toBeLessThan(facts.padding + facts.cellWidth);
  await page.close();
}, 60_000);

test.skipIf(!usable)("a terminal whose session is gone says so", async () => {
  // It takes the private tmux server down with it, so nothing that needs tmux may follow.
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`http://127.0.0.1:${port}/changes/${id}/terminals`);
  await page.waitForSelector(".terminal iframe");
  expect(await page.locator(".terminal-gone").count()).toBe(0);

  // The pane waits five seconds after its window list empties before calling the session gone,
  // so that a terminal merely starting is not mistaken for one that was lost. That wait is what
  // this test is about, so it is advanced rather than sat through: the clock goes in after the
  // terminal is up, and the timer the pane starts when the list empties is then ours to run.
  await page.clock.install();

  // The server goes away under the open terminal, the way a killed tmux server does: the page
  // has to say so rather than leave a dead frame that looks merely slow.
  await tmux("kill-server");
  // Wait on the page's own state, not on the clock: the window list emptying is what starts the
  // timer, and that is a fact about the server (its watcher has seen the session die), not a
  // duration to guess at.
  const windows = page.locator(".sidebar .entry.window");
  expect(await until(() => windows.count(), 0, 60)).toBe(0);
  await page.clock.runFor(5000);
  expect(await until(() => page.locator(".terminal-gone").count(), 1)).toBe(1);

  // And it is said again when the tab is reopened: the server answers with the stale ttyd and the
  // pid to stop. That report has a grace — a ttyd whose note is younger than five seconds is not
  // judged, so a terminal that is merely starting is not called dead — and the test before this
  // one restarts the ttyd. Age the note past the grace so the reopen tests the report, not the
  // birth.
  const note = join(tmp, "changes", id, "terminal.json");
  const running = JSON.parse(await Bun.file(note).text()) as { at?: number };
  await Bun.write(note, `${JSON.stringify({ ...running, at: Date.now() - 60_000 })}\n`);

  await page.reload();
  await page.waitForSelector(".terminal iframe");
  expect(await until(() => page.locator(".terminal-gone").count(), 1)).toBe(1);
  expect(await page.locator(".terminal-gone code").first().innerText()).toContain("kill ");
  await page.close();
}, 60_000);

test.skipIf(!usable)("the page sends CSI u for the keys a terminal cannot encode", async () => {
  // The script is what IWE owns; tmux's forwarding of those sequences is tmux's business, and
  // is governed by `extended-keys`. A stub socket makes the bytes visible without a shell.
  const page = await browser.newPage();
  // From our own origin, as the terminal page is: the server refuses requests another site made,
  // and a fixture on about:blank is another site. Loading it there passed until that was true.
  await page.addInitScript(() => {
    (window as unknown as { __sent: string[] }).__sent = [];
    // A socket the script can capture, standing in for the one ttyd opens.
    window.WebSocket = class {
      readyState = 1;
      send(frame: ArrayBuffer): void {
        (window as unknown as { __sent: string[] }).__sent.push(new TextDecoder().decode(frame));
      }
    } as unknown as typeof WebSocket;
  });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<textarea id="t"></textarea>'));
  await page.addScriptTag({ url: "/terminal-keys.js" });
  const frames = await page.evaluate(() => {
    new WebSocket("ws://127.0.0.1:1/never"); // the script keeps a reference to it
    const press = (init: KeyboardEventInit): boolean =>
      document
        .getElementById("t")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...init }));
    press({ shiftKey: true });
    press({ ctrlKey: true });
    press({ shiftKey: true, ctrlKey: true });
    press({}); // plain Enter is left to the terminal, which encodes it correctly
    press({ altKey: true }); // as is alt-Enter
    return (window as unknown as { __sent: string[] }).__sent;
  });
  // "0" is ttyd's input command; then the CSI u sequence: 13 is Enter, then the modifier.
  expect(frames).toEqual(["0\u001b[13;2u", "0\u001b[13;5u", "0\u001b[13;6u"]);
  await page.close();
}, 30_000);

test.skipIf(!usable)("a right click is tmux's menu, not the browser's as well", async () => {
  // tmux draws its own menu into the terminal grid when mouse mode reports a right click; the
  // browser does not know that happened, and shows its own on top unless told not to.
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.addScriptTag({ url: "/terminal-keys.js" });
  const prevented = await page.evaluate(
    () => !window.dispatchEvent(new MouseEvent("contextmenu", { cancelable: true })),
  );
  expect(prevented).toBe(true);
  await page.close();
});
