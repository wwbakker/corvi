import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { runSh, testRun, testTempDir, tmuxTempDir } from "./helpers.ts";
import { platformName } from "../src/capabilities/os.ts";
import { csiuFor } from "../src/terminals/model.ts";

/**
 * The terminal is process plumbing — a pty running tmux, spawned and cleaned up — so the only
 * test worth having drives the real thing through a real browser. The server runs on Node here,
 * as it does in the app: Bun never delivers pty output (docs/decisions/node-pty-terminal.md).
 * The browser is what draws it, so a test without one would not test the terminal at all.
 *
 * It is skipped where the tools are missing rather than failing, since the rest of IWE works
 * fine without them.
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
  // Every call names this run's own socket with -S: the same one the server under test was given
  // (IWE_TMUX_SOCKET, below). -S beats $TMUX, so even a forgotten `delete process.env.TMUX` could
  // not point a kill-server at the server you are working in.
  const proc = Bun.spawn(["tmux", "-S", testSocket, ...args], {
    env: { ...process.env, TMUX_TMPDIR: tmuxTmp },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return out.trim();
}

const have = async (tool: string): Promise<boolean> => (await runSh(["which", tool])).code === 0;
/** Playwright downloads its browsers separately (`bunx playwright install chromium`, README),
 * and launching one that is not there throws in the `beforeAll` below — which bun reports as a
 * single unnamed failure, with every terminal test silently gone. A missing browser is the same
 * kind of missing tool as a missing tmux: skip, as this file's own docstring promises. The path
 * can also be unanswerable, which is just as good a reason to skip. */
const haveBrowser = await (async (): Promise<boolean> => {
  try {
    return await Bun.file(chromium.executablePath()).exists();
  } catch {
    return false;
  }
})();
const usable = (await have("tmux")) && haveBrowser;

let tmp: string;
/** The private tmux server's socket directory, which is not `tmp`: a unix socket path is capped
 * at 103 characters and this directory has to fit inside that (test/helpers.ts explains). */
let tmuxTmp: string;
/** The socket file itself, handed to the server under test through IWE_TMUX_SOCKET and named
 * explicitly by every tmux call here. Under the run's own temp dir: scripts/clean-test.ts
 * decides ownership by exactly that. */
let testSocket: string;
let browser: Browser;
let port: number;
let server: ReturnType<typeof Bun.spawn>;
const id = "PROJ-TERM";
const session = `iwe-${id}`;

/** Start the server the app would start: `src/server.ts` on Node. */
const startServer = (): ReturnType<typeof Bun.spawn> =>
  Bun.spawn(["node", "src/server.ts", `--iwe-test-run=${testRun()}`], {
    env: { ...process.env, IWE_ROOT: join(tmp, "changes"), IWE_PORT: String(port) },
    stdout: "ignore",
    stderr: process.env.IWE_TEST_LOUD ? "inherit" : "ignore",
  });

const waitForServer = async (): Promise<void> => {
  for (let i = 0; i < 60; i++) {
    if ((await fetch(`http://127.0.0.1:${port}/api/changes`).catch(() => null))?.ok) return;
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up");
};

beforeAll(async () => {
  if (!usable) return;
  tmp = await testTempDir("term");
  tmuxTmp = await tmuxTempDir();
  // A tmux server of our own, so the test can change server options and kill everything
  // afterwards without touching the sessions you are working in. TMUX_TMPDIR alone does not do
  // that when the suite is run from inside tmux: $TMUX wins, and every tmux command here —
  // `kill-server` included — would reach the server you are working in. So the socket is named
  // explicitly (IWE_TMUX_SOCKET for the server, -S for this file's own calls), which beats $TMUX
  // whatever it says; deleting it keeps the bare-tmux test below honest as well.
  delete process.env.TMUX;
  process.env.TMUX_TMPDIR = tmuxTmp;
  testSocket = join(tmuxTmp, `tmux-${process.getuid?.() ?? 0}`, "iwe");
  await mkdir(join(tmuxTmp, `tmux-${process.getuid?.() ?? 0}`), { recursive: true });
  process.env.IWE_TMUX_SOCKET = testSocket;
  port = 4300 + Math.floor(Math.random() * 200);
  server = startServer();
  // The repository is only needed because a change must have one; the terminal ignores it.
  const repo = join(tmp, "repo");
  await runSh(["git", "init", "-b", "main", repo]);
  await waitForServer();
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
  await tmux("kill-server"); // ours alone: TMUX_TMPDIR points at the temporary directory
  await rm(tmp, { recursive: true, force: true });
});

test("the keys a terminal cannot encode are sent as CSI u", () => {
  const key = (
    over: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>,
  ): Parameters<typeof csiuFor>[0] => ({
    key: "Enter",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  });
  expect(csiuFor(key({ shiftKey: true }))).toBe("\u001b[13;2u");
  expect(csiuFor(key({ ctrlKey: true }))).toBe("\u001b[13;5u");
  expect(csiuFor(key({ shiftKey: true, ctrlKey: true }))).toBe("\u001b[13;6u");
  // Plain Enter, alt-Enter and the command key are xterm's, which encodes those correctly.
  expect(csiuFor(key({}))).toBeUndefined();
  expect(csiuFor(key({ altKey: true }))).toBeUndefined();
  expect(csiuFor(key({ metaKey: true, shiftKey: true }))).toBeUndefined();
  expect(csiuFor(key({ key: "a", shiftKey: true }))).toBeUndefined();
});

test("a Bun server says it has no terminal rather than opening a silent socket", async () => {
  // The suite runs under Bun, which is exactly the runtime where node-pty never delivers data;
  // this is the guard that turns that into a message instead of an empty pane.
  const { terminalUnavailable } = await import("../src/terminals/server/session.ts");
  expect(terminalUnavailable()).toContain("needs Node");
});

test.skipIf(!usable)("a terminal outlives the server that started it", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`http://127.0.0.1:${port}/changes/${id}/terminals`);
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await page.locator(".terminal-screen").click();
  await Bun.sleep(1000);
  // Something that only lives in the shell itself, so the test can tell a surviving shell from
  // a fresh one that happens to have the same windows.
  await page.keyboard.type("export IWE_SURVIVED=yes\n");
  await Bun.sleep(500);

  // Restart, as happens constantly while working on IWE itself.
  server.kill();
  await Bun.sleep(500);
  server = startServer();
  await waitForServer();

  // The session, and the shell in it, belong to tmux; the new server's pty attaches to them.
  await page.reload();
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await page.locator(".terminal-screen").click();
  await Bun.sleep(1000);
  await page.keyboard.type("echo $IWE_SURVIVED > survived.txt\n");
  for (let i = 0; i < 30; i++) {
    if (await Bun.file(join(tmp, "changes", id, "survived.txt")).exists()) break;
    await Bun.sleep(200);
  }
  expect(await Bun.file(join(tmp, "changes", id, "survived.txt")).text()).toBe("yes\n");
  await page.close();
}, 60_000);

test.skipIf(!usable)("another change's terminal is another pty", async () => {
  // Navigating from one change's terminal to another's must not keep the first change's pty:
  // the shells are separate sessions, and a command typed in the second must land there.
  const second = "PROJ-TERM-2";
  const repo = join(tmp, "repo2");
  await runSh(["git", "init", "-b", "main", repo]);
  const created = await fetch(`http://127.0.0.1:${port}/api/changes`, {
    method: "POST",
    body: JSON.stringify({ id: second, repos: [repo] }),
  });
  expect(created.ok).toBe(true);

  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`http://127.0.0.1:${port}/changes/${second}/terminals`);
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await page.locator(".terminal-screen").click();
  await Bun.sleep(1000);
  await page.keyboard.type("pwd > second.txt\n");
  for (let i = 0; i < 30; i++) {
    if (await Bun.file(join(tmp, "changes", second, "second.txt")).exists()) break;
    await Bun.sleep(200);
  }
  expect(await Bun.file(join(tmp, "changes", second, "second.txt")).text()).toBe(
    `${join(tmp, "changes", second)}\n`,
  );

  // The first change's terminal, without a reload: the sidebar lists every change's windows, and
  // clicking one is the client-side navigation that must retire the second change's pty.
  const firstEntry = page.locator(".sidebar .change-entry").filter({ hasText: new RegExp(`${id}(?!-)`) }).first();
  await firstEntry.locator(".entry.window").first().click();
  await page.waitForURL(`**/changes/${id}/terminals`);
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await page.locator(".terminal-screen").click();
  await Bun.sleep(1000);
  await page.keyboard.type("pwd > back.txt\n");
  for (let i = 0; i < 30; i++) {
    if (await Bun.file(join(tmp, "changes", id, "back.txt")).exists()) break;
    await Bun.sleep(200);
  }
  expect(await Bun.file(join(tmp, "changes", id, "back.txt")).text()).toBe(
    `${join(tmp, "changes", id)}\n`,
  );
  // The second change's session is not needed again, and leaving it would put its windows in
  // the sidebar counts the tests after this one make.
  await tmux("kill-session", "-t", `iwe-${second}`);
  await page.close();
}, 60_000);

test.skipIf(!usable)("the terminal tab runs a shell in the change directory", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  // Straight to the terminal page: the navigation column has no "Terminals" button, because
  // "the terminals" is not something to look at — a window is.
  await page.goto(`http://127.0.0.1:${port}/changes/${id}/terminals`);
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await page.locator(".terminal-screen").click();

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

  // The pty follows the pane: a resized window re-fits xterm and tells the pty, so tmux's client
  // size follows instead of leaving a strip of the terminal unused.
  const clientSize = async (): Promise<string> =>
    (await tmux("list-clients", "-t", session, "-F", "#{client_width}x#{client_height}"))
      .split("\n")[0] ?? "";
  const before = await clientSize();
  await page.setViewportSize({ width: 1000, height: 700 });
  let after = before;
  for (let i = 0; i < 50 && after === before; i++) {
    await Bun.sleep(200);
    after = await clientSize();
  }
  expect(after).not.toBe(before);

  await page.close();
}, 60_000);

test.skipIf(!usable)("a pane's environment is the user's, not the launcher's", async () => {
  // The server runs on Electron's own Node with the launcher's variables in its environment
  // (IWE_PORT, IWE_ROOT here; ELECTRON_RUN_AS_NODE whenever this suite itself runs inside such a
  // server, which is exactly the leak). The pane's shells are the user's, so they must not see
  // any of it — and they must see the change's context, which IWE adds on purpose
  // (src/capabilities/env.ts).
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`http://127.0.0.1:${port}/changes/${id}/terminals`);
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await page.locator(".terminal-screen").click();
  await Bun.sleep(1000);
  // An absolute path, because the session's active window may be any window the tests above left
  // behind, in whatever directory it had walked to.
  const out = join(tmp, "changes", id, "pane-env.txt");
  await page.keyboard.type(`env > ${out}\n`);
  for (let i = 0; i < 30; i++) {
    if (await Bun.file(out).exists()) break;
    await Bun.sleep(200);
  }
  const env = await Bun.file(out).text();
  // Line-anchored: the suite's own `npm_lifecycle_script` ("export IWE_ROOT=\"$ROOT\" …") rides
  // along in the environment, so a bare substring would false-positive on it.
  const hasVar = (name: string): boolean =>
    env.split("\n").some((line) => line.startsWith(`${name}=`));
  expect(hasVar("ELECTRON_RUN_AS_NODE")).toBe(false);
  expect(hasVar("IWE_PORT")).toBe(false);
  expect(hasVar("IWE_ROOT")).toBe(false);
  expect(hasVar("IWE_CHANGE_ID")).toBe(true);
  expect(env).toContain(`IWE_CHANGE_DIR=${join(tmp, "changes", id)}`);
  await page.close();
}, 60_000);

test.skipIf(!usable)("a bare tmux command cannot reach the change's session", async () => {
  // IWE's sessions live on their own socket (IWE_TMUX_SOCKET, tmux.ts): a tmux command that
  // forgets to name it resolves the way tmux always does — $TMUX, else $TMUX_TMPDIR/tmux-<uid>/
  // default — and finds nothing of ours. This is what makes a careless kill-server from a probe,
  // a script or an agent's stray test harmless to IWE's terminals.
  const proc = Bun.spawn(["tmux", "ls"], {
    env: { ...process.env, TMUX_TMPDIR: tmuxTmp }, // TMUX deleted in beforeAll
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(await proc.exited).not.toBe(0); // no server on the default socket of this run
  expect(`${out}${err}`).not.toContain(session);
  // The session is there for whoever names the socket, as the tests above do.
  expect(await tmux("ls")).toContain(session);
}, 60_000);

test.skipIf(!usable)("the terminal page's bar is its windows, not the change's controls", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`http://127.0.0.1:${port}/changes/${id}/terminals`);
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });

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
    page.locator(".terminal-screen").boundingBox(),
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
  await page.waitForSelector(".terminal-screen .xterm-screen");
  expect(new URL(page.url()).pathname).toBe(`/changes/${id}/terminals`);
  await page.close();
}, 60_000);

test.skipIf(!usable)("a window tab dragged onto another takes its place", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`http://127.0.0.1:${port}/changes/${id}/terminals`);
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
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
  // Stand in for the app's host: the real window exposes `window.iweHost` from its preload
  // (scripts/app/electron/preload.ts), a browser has none, so the test installs the same shape
  // and keeps the open-window callback the page registers on mount.
  await page.addInitScript(() => {
    const store: unknown[] = [];
    (window as unknown as { __notices: unknown[] }).__notices = store;
    (window as unknown as { iweHost: unknown }).iweHost = {
      notify: (message: unknown) => store.push(message),
      onOpenWindow: (callback: (change: string, window: string) => void) => {
        (window as unknown as { __openWindow: unknown }).__openWindow = callback;
      },
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
      // What the host does on a click: call the callback the page registered on mount.
      (window as unknown as { __openWindow: (c: string, w: string) => void }).__openWindow(
        change!,
        windowId!,
      );
    },
    [id, windowId] as const,
  );
  await page.waitForSelector(".terminal-screen .xterm-screen");
  expect(new URL(page.url()).pathname).toBe(`/changes/${id}/terminals`);

  // Looking straight at it is the one silent case. Working long enough for the watcher to see
  // it, then waiting again: the host hears nothing this time.
  expect(await page.evaluate(() => document.hasFocus())).toBe(true);
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

test.skipIf(!usable)("closing the page detaches the pty but keeps the session", async () => {
  // A pty dies with its socket, the way one dies when its page is closed — and the session, and
  // everything running in it, must not be taken with it. The next connection attaches to the
  // same windows.
  await tmux("set-option", "-g", "destroy-unattached", "off"); // a developer's tmux.conf must not decide this
  await tmux("new-window", "-t", session, "-d"); // one more than the session already has
  const before = (await tmux("list-windows", "-t", session)).split("\n").length;

  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`http://127.0.0.1:${port}/changes/${id}/terminals`);
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await Bun.sleep(500); // the pty attached
  await page.close();
  await Bun.sleep(500);

  // A fresh connection finds the session and its windows, not a fresh session.
  const again = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await again.goto(`http://127.0.0.1:${port}/changes/${id}/terminals`);
  await again.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  expect((await tmux("list-windows", "-t", session)).split("\n").length).toBe(before);
  await again.close();
}, 60_000);

test.skipIf(!usable)("the terminal fills the frame, with no scrollbar of its own", async () => {
  // xterm's stylesheet gives the viewport `overflow-y: scroll` whatever the scrollback is, and
  // the fit addon reserves the scrollbar's width when there is scrollback to scroll. On a machine
  // that shows scrollbars always, the two together are a pale empty bar down the right of the
  // terminal and a grid a couple of columns narrower than the frame. tmux owns scrolling (mouse
  // mode), so the terminal is started with no scrollback and the stylesheet takes the bar itself
  // away.
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`http://127.0.0.1:${port}/changes/${id}/terminals`);
  const screen = page.locator(".terminal-screen .xterm-screen");
  await screen.waitFor({ timeout: 15_000 });

  // One character cell, from the two sides: the pane's own column count, and the grid's width.
  const cols = Number(
    (await tmux("list-clients", "-t", session, "-F", "#{client_width}")).split("\n")[0],
  );
  const box = (await screen.boundingBox())!;
  const { overflowY, rightGap } = await screen.evaluate((el) => {
    const viewport = el.ownerDocument.querySelector(".xterm-viewport") as HTMLElement;
    return {
      overflowY: getComputedStyle(viewport).overflowY,
      rightGap: viewport.getBoundingClientRect().right - el.getBoundingClientRect().right,
    };
  });
  expect(overflowY).toBe("hidden");
  // The grid may be short by less than one cell — columns are whole characters — but no more.
  // A scrollbar is a good deal wider than one cell, which is the strip this catches.
  expect(rightGap).toBeLessThan(box.width / cols);
  await page.close();
}, 60_000);

test.skipIf(!usable)("a right click is tmux's menu, not the browser's as well", async () => {
  // tmux draws its own menu into the terminal grid when mouse mode reports a right click; the
  // browser does not know that happened, and shows its own on top unless told not to.
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`http://127.0.0.1:${port}/changes/${id}/terminals`);
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  const prevented = await page.locator(".terminal-screen").evaluate((el) =>
    !el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
  );
  expect(prevented).toBe(true);
  await page.close();
}, 60_000);

test.skipIf(!usable)("the page copies and pastes through the system clipboard", async () => {
  // ttyd's page owned these chords; with xterm.js in the page they are ours. The browser
  // permission is granted here the way the app grants it (scripts/app/electron/main.ts).
  const page = await browser.newPage({
    viewport: { width: 1200, height: 800 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  await page.goto(`http://127.0.0.1:${port}/changes/${id}/terminals`);
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await page.locator(".terminal-screen").click();
  await Bun.sleep(1000);

  // A known line at the top of the screen.
  await page.keyboard.type("clear; echo COPY-MARKER-42\n");
  await Bun.sleep(800);

  // A modifier-drag across the whole screen, because mouse mode is on: a plain drag is tmux's
  // selection. Which modifier is xterm.js's (SelectionService.shouldForceSelection): shift
  // everywhere but macOS, where it is option — the same chord the cheat sheet gives, and the only
  // one a Mac has. The whole screen rather than a few rows, because tmux's status line sits
  // wherever the user's ~/.tmux.conf puts it (top or bottom) and a pixel offset lands a row off;
  // all this needs is the marker inside the selection.
  const forceSelection = platformName === "mac" ? "Alt" : "Shift";
  const screen = (await page.locator(".terminal-screen .xterm-screen").boundingBox())!;
  await page.keyboard.down(forceSelection);
  await page.mouse.move(screen.x + 1, screen.y + 1);
  await page.mouse.down();
  await page.mouse.move(screen.x + screen.width - 2, screen.y + screen.height - 2, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up(forceSelection);

  await page.keyboard.press("Control+Shift+C");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  // The first cell depends on where the drag's pixel lands in a character cell; the marker in
  // the clipboard is what this is about.
  expect(copied).toContain("MARKER-42");

  // And back in: the chord pastes the clipboard into the shell's editor, where Enter runs it.
  // An absolute path, because the session's active window may be any window the tests above
  // left behind, in whatever directory it had walked to.
  const pasted = join(tmp, "changes", id, "pasted.txt");
  await page.evaluate((path) => navigator.clipboard.writeText(`echo PASTED > ${path}`), pasted);
  await page.locator(".terminal-screen").click();
  await page.keyboard.press("Control+Shift+V");
  // The clipboard read is asynchronous; Enter before it lands would execute an empty line.
  await Bun.sleep(400);
  await page.keyboard.press("Enter");
  for (let i = 0; i < 30; i++) {
    if (await Bun.file(pasted).exists()) break;
    await Bun.sleep(200);
  }
  expect(await Bun.file(pasted).text()).toBe("PASTED\n");
  await page.close();
}, 60_000);

test.skipIf(!usable)("a terminal whose session is gone says so", async () => {
  // It takes the private tmux server down with it, so nothing that needs tmux may follow.
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`http://127.0.0.1:${port}/changes/${id}/terminals`);
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  expect(await page.locator(".terminal-gone").count()).toBe(0);

  // The pane waits five seconds after its window list empties before calling the session gone,
  // so that a terminal merely starting is not mistaken for one that was lost. That wait is what
  // this test is about, so it is advanced rather than sat through: the clock goes in after the
  // terminal is up, and the timer the pane starts when the list empties is then ours to run.
  await page.clock.install();

  // The server goes away under the open terminal, the way a killed tmux server does: the page
  // has to say so rather than leave a dead pane that looks merely slow.
  await tmux("kill-server");
  // Wait on the page's own state, not on the clock: the window list emptying is what starts the
  // timer, and that is a fact about the server (its watcher has seen the session die), not a
  // duration to guess at.
  const windows = page.locator(".sidebar .entry.window");
  expect(await until(() => windows.count(), 0, 60)).toBe(0);
  await page.clock.runFor(5000);
  expect(await until(() => page.locator(".terminal-gone").count(), 1)).toBe(1);

  // Reopening the tab starts a fresh session, which is what `new-session -A` would have done
  // anyway; the banner is about the loss, not a request to clean anything up.
  await page.reload();
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  let fresh = false;
  for (let i = 0; i < 50 && !fresh; i++) {
    fresh = (await tmux("ls")).includes(session);
    if (!fresh) await Bun.sleep(200);
  }
  expect(fresh).toBe(true);
  expect(await until(() => page.locator(".terminal-gone").count(), 0)).toBe(0);
  await page.close();
}, 60_000);
