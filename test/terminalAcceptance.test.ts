import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { budget, checkoutsOf, closePages, requireFreshWebBundle, runSh, serverEnv, testRun, testTempDir, until, waitForUrl } from "./helpers.ts";
import { ensureHost } from "../apps/server/src/terminals/host/client.ts";

/**
 * The terminal's user-facing invariants, through a real browser. These are the seams the recent
 * regressions lived in and no test watched:
 *
 *  - the pty and the page agree on the grid, which is what makes wrapping and backspace line up;
 *  - a window is its own shell with its own screen, and that survives a reload and a restart;
 *  - a subagent's window is the one the Subagents page shows, at the page's size;
 *  - an action's kept-open window freezes over its output, and the agent-status channel keeps the
 *    window strip honest.
 *
 * The subagent harness is a fake `pi` on PATH that execs a shell: the harness window here is only
 * a place to type `stty size`, and a real coding agent would neither run a shell nor be a geometry
 * probe. Each test uses its own change, so window records never leak between them.
 *
 * Skipped where the browser is missing, since the rest of Corvi works without it.
 */
const haveBrowser = await (async (): Promise<boolean> => {
  try {
    return await Bun.file(chromium.executablePath()).exists();
  } catch {
    return false;
  }
})();
const usable = haveBrowser;
if (usable) requireFreshWebBundle();

let tmp: string;
let browser: Browser;
let url: string;
let server: ReturnType<typeof Bun.spawn>;
/** The fake harness's directory, kept on PATH for every server start — including the restart the
 * restore test does, which would otherwise hand a new host the real `pi`. */
let fakePath = "";

const fileText = (path: string): Promise<string> => Bun.file(path).text().catch(() => "");

/** Wait until the pane's socket is attached to the window the page names: the pty is alive by then
 * and buffers input until the shell reads it, so a command typed afterwards cannot be lost. */
const awaitAttached = (page: Page): Promise<void> =>
  page.waitForSelector(".terminal-screen[data-attached]", { timeout: budget(60_000) }).then(() => undefined);

const startServer = async (port = 0): Promise<void> => {
  server = Bun.spawn(["node", "apps/server/src/server.ts", `--corvi-test-run=${testRun()}`], {
    env: serverEnv(tmp, { CORVI_PORT: String(port), PATH: fakePath }),
    stdout: "pipe",
    stderr: process.env.CORVI_TEST_LOUD ? "inherit" : "ignore",
  });
  url = await waitForUrl(server);
};

beforeAll(async () => {
  if (!usable) return;
  tmp = await testTempDir("accept");
  // The fake harness a subagent window runs. It is found through PATH, which `serverEnv` hands to
  // the spawned server and therefore to the host it starts.
  const fakeBin = join(tmp, "bin");
  await mkdir(fakeBin, { recursive: true });
  const fakePi = join(fakeBin, "pi");
  await writeFile(fakePi, "#!/bin/sh\nexec /bin/sh\n");
  await chmod(fakePi, 0o755);
  fakePath = `${fakeBin}:${process.env.PATH ?? ""}`;
  server = Bun.spawn(["node", "apps/server/src/server.ts", `--corvi-test-run=${testRun()}`], {
    env: serverEnv(tmp, { PATH: fakePath }),
    stdout: "pipe",
    stderr: process.env.CORVI_TEST_LOUD ? "inherit" : "ignore",
  });
  url = await waitForUrl(server);
  // The flags keep a headless page's timers unthrottled (see test/terminal.test.ts).
  browser = await chromium.launch({
    args: [
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ],
  });
}, budget(120_000));

afterEach(async () => {
  await closePages(browser, "terminal-acceptance");
});

afterAll(async () => {
  if (!usable) return;
  await browser?.close();
  server?.kill();
  await server?.exited;
  await ensureHost({ socket: join(tmp, "state", "corvi", "host.sock"), checkout: process.cwd(), buildId: process.env.CORVI_BUILD ?? "dev", runtime: "node" })
    .then((result) => result.client.shutdown())
    .catch(() => undefined);
  await rm(tmp, { recursive: true, force: true });
}, budget(60_000));

/** A change with one git repo, and the directory its terminals open in. */
const createChange = async (id: string): Promise<string> => {
  const repo = join(tmp, `repo-${id}`);
  await runSh(["git", "init", "-b", "main", repo]);
  const created = await fetch(`${url}/api/changes`, {
    method: "POST",
    body: JSON.stringify({ id, checkouts: checkoutsOf([repo]) }),
  });
  expect(created.status).toBeLessThan(300);
  return join(tmp, "changes", id);
};

const openTerminal = async (change: string, page = "terminals"): Promise<Page> => {
  const found = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await found.goto(`${url}/changes/${change}/${page}`);
  await found.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await found.locator(".terminal-screen").click();
  await awaitAttached(found);
  return found;
};

/** The xterm instance the pane exposes on its host element: a WebGL canvas has no DOM text, and
 * the buffer is exactly what a snapshot is taken from. */
type BrowserTerminal = {
  buffer: {
    active: {
      length: number;
      cursorX: number;
      cursorY: number;
      getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
  cols: number;
  rows: number;
};

const terminalText = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const element = document.querySelector(".terminal-screen") as (HTMLElement & { corviTerminal?: BrowserTerminal }) | null;
    const term = element?.corviTerminal;
    if (!term) return "";
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buffer.length; y++) lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
    return lines.join("\n");
  });

/** The grid xterm is showing: the pty's `stty size` has to match it. */
const terminalSize = (page: Page): Promise<{ cols: number; rows: number }> =>
  page.evaluate(() => {
    const element = document.querySelector(".terminal-screen") as (HTMLElement & { corviTerminal?: BrowserTerminal }) | null;
    const term = element?.corviTerminal;
    return { cols: term?.cols ?? 0, rows: term?.rows ?? 0 };
  });

/** The shell's cursor, in the grid's own coordinates. */
const terminalCursor = (page: Page): Promise<{ x: number; y: number }> =>
  page.evaluate(() => {
    const element = document.querySelector(".terminal-screen") as (HTMLElement & { corviTerminal?: BrowserTerminal }) | null;
    const term = element?.corviTerminal;
    return { x: term?.buffer.active.cursorX ?? 0, y: term?.buffer.active.cursorY ?? 0 };
  });

/** Type one command and wait for its output to appear on the screen (not merely be echoed). */
const typeUntilText = async (page: Page, command: string, needle: string): Promise<void> => {
  await awaitAttached(page);
  await page.keyboard.type(`${command}\n`);
  const shown = await until(async () => (await terminalText(page)).includes(needle), true, budget(30_000));
  if (!shown) {
    throw new Error(`the terminal never showed ${needle} (tail ${JSON.stringify((await terminalText(page)).slice(-200))})`);
  }
};

/** Run one command and wait for its exact effect. The command is typed once, after the attach
 * gate, so no retry can run it twice. */
const runCommand = async (page: Page, command: string, file: string, want: string): Promise<void> => {
  await awaitAttached(page);
  await page.keyboard.type(`${command}\n`);
  const wrote = await until(async () => (await fileText(file)) === want, true, budget(60_000));
  if (!wrote) {
    throw new Error(`the command never wrote ${file} with ${JSON.stringify(want)} (saw ${JSON.stringify(await fileText(file))})`);
  }
  expect(await fileText(file)).toBe(want);
};

/** Ask the shell under the page for its tty size. `guard` is a shell predicate the target window
 * alone satisfies, so a retry cannot be answered by another window's shell; the attach gate above
 * covers the socket, and the small retry covers the pane re-attaching to the subagent's window. */
const ptySize = async (page: Page, file: string, guard = ""): Promise<{ rows: number; cols: number }> => {
  await awaitAttached(page);
  const command = guard === "" ? `stty size > ${file}` : `[ ${guard} ] && stty size > ${file} || true`;
  let reported = "";
  for (let attempt = 0; attempt < 50 && !/^\d+ \d+$/.test(reported); attempt++) {
    // Clear any half-typed line first: a reconnect mid-command can drop the opening quote of a
    // guard and leave the shell at a `>` continuation, where the next retry would only pile on.
    await page.keyboard.press("Control+C");
    await page.keyboard.type(`${command}\n`);
    await Bun.sleep(200);
    reported = (await fileText(file)).trim();
  }
  if (!/^\d+ \d+$/.test(reported)) {
    throw new Error(`no tty size reported (saw ${JSON.stringify(reported)}; screen tail ${JSON.stringify((await terminalText(page)).slice(-300))})`);
  }
  const [rows = 0, cols = 0] = reported.split(/\s+/).map(Number);
  return { rows, cols };
};

test.skipIf(!usable)("a line wider than the terminal wraps at the grid, and backspace takes it back", async () => {
  const id = "ACC-WRAP";
  await createChange(id);
  const page = await openTerminal(id);
  // Readiness: the prompt is printed and the cursor sits still at it.
  await typeUntilText(page, "echo WRAP-READY", "WRAP-READY");
  await Bun.sleep(400);

  const { cols } = await terminalSize(page);
  const before = await terminalCursor(page);
  const x0 = before.x;
  const y0 = before.y;
  // Exactly to the end of the row and five characters past it: the tail must land on the next row
  // if the shell's width is the grid's.
  const tail = "TAILZ";
  const line = "Q".repeat(cols - x0 + 5 - tail.length) + tail;
  await page.keyboard.type(line);
  await until(async () => (await terminalText(page)).includes(tail), true, budget(10_000));
  // The cursor reaches the next row at the cell the grid says; a pty at another width lands
  // somewhere else (or leaves the tail mid-row), which is exactly the 80x24 mismatch.
  const expected = { x: 5, y: y0 + 1 };
  const settled = await until(
    () => terminalCursor(page).then((c) => `${c.x},${c.y}`),
    `${expected.x},${expected.y}`,
    budget(10_000),
  );
  expect(settled).toBe(`${expected.x},${expected.y}`);
  expect(await terminalCursor(page)).toEqual(expected);

  // Backspace removes the wrapped tail and returns the cursor to the exact cell the grid implies:
  // the line ends at the right margin, which zsh reports as the start of the row below.
  for (let i = 0; i < tail.length; i++) await page.keyboard.press("Backspace");
  const removed = await until(async () => (await terminalText(page)).includes(tail), false, budget(10_000));
  expect(removed).toBe(false);
  const back = await until(
    () => terminalCursor(page).then((c) => `${c.x},${c.y}`),
    `0,${y0 + 1}`,
    budget(10_000),
  );
  expect(back).toBe(`0,${y0 + 1}`);
  await page.keyboard.press("Control+C");
  await page.close();
}, budget(90_000));

test.skipIf(!usable)("each window keeps its own shell and its own screen across a reload and a restart", async () => {
  const id = "ACC-RESTORE";
  const dir = await createChange(id);
  const page = await openTerminal(id);
  const tabs = page.locator(".window-tab:not(.new):not(.overview)");
  await tabs.first().waitFor({ timeout: 15_000 });

  // Window 1: its own shell, with a variable only it has, and a distinctive screen.
  const marker = join(dir, "win-set.txt");
  await runCommand(page, `export WIN_ONE=yes; echo "$WIN_ONE" > ${marker}`, marker, "yes\n");
  await typeUntilText(page, "seq -f 'W1-DEEP-%g' 1 80", "W1-DEEP-80");

  // A second window is its own shell, showing its own screen. The pane reconnects to it when the
  // active window changes; wait for the switch (window 1's marker leaves the screen) before
  // typing, or the keystrokes land in window 1 and the test retries into the void.
  await page.locator(".window-tab.new").click();
  expect(await until(() => tabs.count(), 2)).toBe(2);
  await until(async () => (await terminalText(page)).includes("W1-DEEP-80"), false, budget(20_000));
  await typeUntilText(page, "seq -f 'W2-DEEP-%g' 1 80", "W2-DEEP-80");
  const second = await terminalText(page);
  expect(second).toContain("W2-DEEP-80");
  expect(second).not.toContain("W1-DEEP-80");

  // Snapshot the visible window and reload: the active window (2) restores its own screen, and
  // window 1 restores its own when selected again.
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await Bun.sleep(400);
  await page.reload();
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await page.locator(".terminal-screen").click();
  expect(await until(async () => (await terminalText(page)).includes("W2-DEEP-80"), true, budget(20_000))).toBe(true);
  expect(await terminalText(page)).not.toContain("W1-DEEP-80");

  await tabs.first().click();
  expect(await until(async () => (await terminalText(page)).includes("W1-DEEP-80"), true, budget(20_000))).toBe(true);
  expect(await terminalText(page)).not.toContain("W2-DEEP-80");

  // A server restart adopts the host and its shells; the page reconnects without a reload.
  const port = Number(new URL(url).port);
  server.kill();
  await server.exited;
  await startServer(port);
  await page.reload();
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await page.locator(".terminal-screen").click();
  expect(await until(async () => (await terminalText(page)).includes("W1-DEEP-80"), true, budget(20_000))).toBe(true);
  // The variable is re-read from the adopted shell, not merely the screen: the restart must not
  // have silently started a fresh shell behind the same window.
  const survived = join(dir, "win-survived.txt");
  await runCommand(page, `echo "$WIN_ONE" > ${survived}`, survived, "yes\n");
  expect(await fileText(survived)).toBe("yes\n");
  await tabs.nth(1).click();
  expect(await until(async () => (await terminalText(page)).includes("W2-DEEP-80"), true, budget(20_000))).toBe(true);
  expect(await terminalText(page)).not.toContain("W1-DEEP-80");
  await page.close();
}, budget(180_000));

test.skipIf(!usable)("a subagent window is the size the page shows", async () => {
  const id = "ACC-SUB";
  await createChange(id);
  const created = await fetch(`${url}/api/changes/${id}/subagents`, {
    method: "POST",
    body: JSON.stringify({ profile: "builtin:reviewer", prompt: "geometry" }),
  });
  expect(created.status).toBe(201);

  const page = await openTerminal(id, "subagents");
  // The pane shows the selected subagent's window, so the terminal here is that window's shell.
  await page.locator(".subagent-list .entry").first().waitFor({ timeout: 15_000 });
  await until(async () => (await page.locator(".subagent-list .entry .summary").first().innerText()) === "attached", true, budget(20_000));
  // The pane reconnects when the subagent's window becomes active; prove the shell under it
  // answers before typing the long guarded command, or a mid-type reconnect could split it.
  await typeUntilText(page, "echo SUB-READY", "SUB-READY");

  // The guard is the subagent window's own environment: only its shell can answer.
  const size = await ptySize(page, join(tmp, "subagent-size.txt"), '-n "$CORVI_SUBAGENT_ID"');
  expect(size).toEqual(await terminalSize(page));
  await page.close();
}, budget(120_000));

test.skipIf(!usable)("an action window freezes over its output, and its agent status shows", async () => {
  const id = "ACC-ACTION";
  await createChange(id);
  const written = await fetch(`${url}/api/actions/files`, {
    method: "PUT",
    body: JSON.stringify({
      scope: "global",
      id: "freeze-me",
      text: '---\nlabel: Freeze Me\nkind: command\ntarget: new\nkeepOpen: true\nnotify: true\n---\necho ACTION-FROZEN\n',
    }),
  });
  expect(written.status).toBe(200);

  const page = await openTerminal(id);
  const tabs = page.locator(".window-tab:not(.new):not(.overview)");
  // Run it from the page's own menu, the path a person takes.
  await page.getByRole("button", { name: "Actions ▾" }).click();
  await page.locator(".menu-items button", { hasText: "Freeze Me" }).click();

  // The kept-open window stays in the strip, labelled from the action.
  const frozen = tabs.filter({ hasText: "Freeze Me" });
  await frozen.first().waitFor({ timeout: 20_000 });
  // Its output is still there: the window did not vanish with the command.
  await frozen.first().click();
  expect(await until(async () => (await terminalText(page)).includes("ACTION-FROZEN"), true, budget(20_000))).toBe(true);

  // The agent-status channel, through the endpoint the CLI uses. It is a live fact about a
  // running process, so it is reported for the change's live shell — the frozen command window's
  // pty has ended, and a status for it is refused by design.
  const listing = (await (await fetch(`${url}/api/changes/${id}/terminal/windows`)).json()) as { id: string; label: string }[];
  const live = listing.find((entry) => entry.label === id);
  expect(live).toBeDefined();
  const { client } = await ensureHost({ socket: join(tmp, "state", "corvi", "host.sock"), checkout: process.cwd(), buildId: process.env.CORVI_BUILD ?? "dev", runtime: "node" });
  const incarnation = (await client.list()).find((entry) => entry.id === live!.id)?.incarnation;
  client.close();
  expect(incarnation).toBeDefined();
  const reported = await fetch(`${url}/api/terminals/status`, {
    method: "POST",
    body: JSON.stringify({ sessionId: live!.id, incarnation, status: "working", name: "pi", sessionName: "orders-api" }),
  });
  expect(reported.ok).toBe(true);
  // The watcher pushes the window list when the presented facts change; the strip then names the
  // session the agent gave.
  expect(await until(async () => (await tabs.filter({ hasText: "orders-api" }).count()) > 0, true, budget(20_000))).toBe(true);
  await page.close();
}, budget(120_000));
