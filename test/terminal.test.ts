import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { budget, checkoutsOf, closePages, runSh, serverEnv, testRun, testTempDir, tmuxTempDir, until, waitFor, waitForUrl, withMachineLock  } from "./helpers.ts";
import { platformName } from "../apps/server/src/capabilities/os.ts";
import { csiuFor } from "@corvi/terminals/model";

/**
 * The terminal is process plumbing — a pty running tmux, spawned and cleaned up — so the only
 * test worth having drives the real thing through a real browser. The server runs on Node here,
 * as it does in the app; native PTY support is checked on the supported Node runtime.
 * The browser is what draws it, so a test without one would not test the terminal at all.
 *
 * It is skipped where the tools are missing rather than failing, since the rest of Corvi works
 * fine without them.
 */
/** The file a typed command was supposed to write: what proves the command ran. With `expect`,
 * the wait is for that exact content — and without it, for any content at all. A file exists as
 * soon as the shell opens it for the redirect, a moment before the command has written a byte,
 * so existence is not completion and a test that reads early reads an empty file. */
const waitForFile = (path: string, want?: string): Promise<void> =>
  waitFor(`the command to write ${path}`, async () => {
    const text = await Bun.file(path).text().catch(() => "");
    return want === undefined ? text.length > 0 : text === want;
  });

/** The pane has drawn its first line — the shell's prompt — so a command typed now is read by a
 * shell that is ready for it. Read from tmux's own screen buffer: the terminal is drawn to a
 * canvas in the browser, so what tmux holds is the same truth the browser will get around to
 * drawing. A typed line itself cannot be lost — a connecting socket and a starting shell both
 * buffer their input — which is why this is the only readiness gate there is. */
const waitForPrompt = (target = session): Promise<void> =>
  waitFor(`the pane of ${target} to draw its first line`, async () =>
    /\S/.test(await tmux("capture-pane", "-p", "-t", target)),
  );

/** The shell echoed what was typed or pasted into it: the input has arrived at the pty. The tty
 * echoes as the bytes land, so this is what to wait for before pressing Enter behind a paste.
 * `-J` joins wrapped lines: a long command's echo breaks across the grid wherever the prompt
 * and the width leave off, and an un-joined capture splits the very words being looked for. A
 * timeout prints the pane, so a failure says what did arrive. */
const echoInPane = async (text: string): Promise<void> => {
  const capture = async (): Promise<string> => tmux("capture-pane", "-p", "-J", "-t", session);
  const found = await until(async () => (await capture()).includes(text), true);
  if (!found) throw new Error(`timed out waiting for the pane to show ${text}; the pane held:\n${await capture()}`);
};

/** The tmux clients attached to a session: one per open terminal's pty. */
const clientCount = async (target: string): Promise<number> =>
  (await tmux("list-clients", "-t", target)).split("\n").filter(Boolean).length;

/** tmux, on the private server this test runs: Bun.spawn does not pick up an environment
 * variable set after it started, so it is passed explicitly. */
async function tmux(...args: string[]): Promise<string> {
  // Every call names this run's own socket with -S: the same one the server under test was given
  // (CORVI_TMUX_SOCKET, below). -S beats $TMUX, so even a forgotten `delete process.env.TMUX` could
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
/** The socket file itself, handed to the server under test through CORVI_TMUX_SOCKET and named
 * explicitly by every tmux call here. Under the run's own temp dir: scripts/clean-test.ts
 * decides ownership by exactly that. */
let testSocket: string;
let browser: Browser;
let url: string;
let server: ReturnType<typeof Bun.spawn>;
const id = "PROJ-TERM";
const session = `corvi-${id}`;

/** Start the server the app would start: `apps/server/src/server.ts` on Node. Port 0: the OS picks a free
 * one, so parallel workers never collide; readiness is the server's own `corvi on <url>` line.
 * CORVI_TMUX_SOCKET is added after the scrub in serverEnv — serverEnv removes every CORVI_*
 * variable (it would otherwise leak another file's socket), then the test's own socket is set
 * deliberately. */
const startServer = async (): Promise<void> => {
  server = Bun.spawn(["node", "apps/server/src/server.ts", `--corvi-test-run=${testRun()}`], {
    // TMUX_TMPDIR is the short socket dir, not tmp: the same value this file's own tmux
    // calls use. The server itself resolves its socket through CORVI_TMUX_SOCKET below (a
    // path, so -S), never through TMUX_TMPDIR — this is for the pane shells it spawns.
    env: { ...serverEnv(tmp, { TMUX_TMPDIR: tmuxTmp }), CORVI_TMUX_SOCKET: testSocket },
    stdout: "pipe",
    stderr: process.env.CORVI_TEST_LOUD ? "inherit" : "ignore",
  });
  url = await waitForUrl(server);
};

beforeAll(async () => {
  if (!usable) return;
  tmp = await testTempDir("term");
  tmuxTmp = await tmuxTempDir();
  // A tmux server of our own, so the test can change server options and kill everything
  // afterwards without touching the sessions you are working in. TMUX_TMPDIR alone does not do
  // that when the suite is run from inside tmux: $TMUX wins, and every tmux command here —
  // `kill-server` included — would reach the server you are working in. So the socket is named
  // explicitly (CORVI_TMUX_SOCKET for the server, -S for this file's own calls), which beats $TMUX
  // whatever it says; deleting it keeps the bare-tmux test below honest as well.
  delete process.env.TMUX;
  process.env.TMUX_TMPDIR = tmuxTmp;
  testSocket = join(tmuxTmp, `tmux-${process.getuid?.() ?? 0}`, "corvi");
  await mkdir(join(tmuxTmp, `tmux-${process.getuid?.() ?? 0}`), { recursive: true });
  process.env.CORVI_TMUX_SOCKET = testSocket;
  await startServer();
  // The repository is only needed because a change must have one; the terminal ignores it.
  const repo = join(tmp, "repo");
  await runSh(["git", "init", "-b", "main", repo]);
  await fetch(`${url}/api/changes`, {
    method: "POST",
    body: JSON.stringify({ id, checkouts: checkoutsOf([repo]) }),
  });
  browser = await chromium.launch();
  // The hook carries its own waits — a server that answers within a minute (waitForUrl), a
  // browser to launch — so its budget is theirs rather than the suite's 30-second default for a
  // test. A hook that times out is reported as one unnamed failure with every terminal test gone.
}, budget(120_000));

afterEach(async () => {
  // A test that fails mid-way must not leave its page open or its session alive: the page's pty
  // keeps its tmux client attached, and windows of one test would pile up in the strip counts
  // and current-window ambiguity of the next. Every test therefore starts with no session at
  // all — it is created by whatever the test does first — and the tests close their own pages;
  // this is the net under them (screenshots first, for CI's failure artifacts), so one failure
  // stays one failure.
  await closePages(browser, "terminal");
  await tmux("kill-session", "-t", session);
});

/** The change's session exists. The page draws its terminal before the pty has started tmux —
 * the socket's connect and the session's creation are the page's asynchronous business — so a
 * window made, a window list read or a server killed against nothing is a race, not a test.
 * Every test starts with no session (afterEach below), so each one that needs it says so. */
const sessionUp = (): Promise<void> =>
  waitFor(`the session of ${id} to start`, async () => (await tmux("ls")).includes(session));

/** The change's session with one window in it, made the way the product makes one: opening the
 * terminal page and letting go of it. A few tests need the session before their own page is the
 * one that makes it — one clicks into it from the sidebar, one counts its windows, one asserts
 * it is there — and closing the page keeps the session (a test below says so). */
const seedSession = async (): Promise<void> => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`${url}/changes/${id}/terminals`);
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await sessionUp();
  await page.close();
};

afterAll(async () => {
  // Other test files share this process: the socket this file gave the server must not shape
  // their pinned argv (a complete-flow test asserts the exact tmux command, -L corvi and all).
  delete process.env.CORVI_TMUX_SOCKET;
  if (!usable) return;
  await browser?.close();
  server?.kill();
  await tmux("kill-server"); // ours alone: named by -S, the socket this file gave the server
  await rm(tmp, { recursive: true, force: true });
  // Its own budget too: closing a browser, a server and a tmux server is work the 30-second
  // default does not owe, and a timeout here would fail a run whose tests all passed.
}, budget(60_000));

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
  const { terminalUnavailable } = await import("../apps/server/src/terminals/server/session.ts");
  expect(terminalUnavailable()).toContain("needs Node");
});

test.skipIf(!usable)("a terminal outlives the server that started it", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`${url}/changes/${id}/terminals`);
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await page.locator(".terminal-screen").click();
  await waitForPrompt();
  // The export only lives in the shell itself, so the test can tell a surviving shell from a
  // fresh one that happens to have the same windows. The write beside it is the proof the line
  // ran before the server goes away under it.
  await page.keyboard.type(`export CORVI_SURVIVED=yes; echo set > ${join(tmp, "survived-set.txt")}\n`);
  await waitForFile(join(tmp, "survived-set.txt"), "set\n");

  // Restart, as happens constantly while working on Corvi itself.
  server.kill();
  await server.exited;
  await startServer();

  // The session, and the shell in it, belong to tmux; the new server's pty attaches to them.
  // A fresh navigation, not a reload: the restarted server listens on a new port (port 0),
  // so the old URL is gone with the old server.
  await page.goto(`${url}/changes/${id}/terminals`);
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await page.locator(".terminal-screen").click();
  await waitForPrompt();
  // The old server's attachment went with it: the session has the new server's client, and no
  // orphaned attach client from the process that was just killed.
  expect(await until(() => clientCount(`corvi-${id}`), 1)).toBe(1);
  await page.keyboard.type("echo $CORVI_SURVIVED > survived.txt\n");
  await waitForFile(join(tmp, "changes", id, "survived.txt"), "yes\n");
  expect(await Bun.file(join(tmp, "changes", id, "survived.txt")).text()).toBe("yes\n");
  await page.close();
}, budget(60_000));

test.skipIf(!usable)("another change's terminal is another pty", async () => {
  // Navigating from one change's terminal to another's must not keep the first change's pty:
  // the shells are separate sessions, and a command typed in the second must land there.
  await seedSession(); // the first change's window — what the sidebar click below opens
  const second = "PROJ-TERM-2";
  const repo = join(tmp, "repo2");
  await runSh(["git", "init", "-b", "main", repo]);
  const created = await fetch(`${url}/api/changes`, {
    method: "POST",
    body: JSON.stringify({ id: second, checkouts: checkoutsOf([repo]) }),
  });
  expect(created.ok).toBe(true);

  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`${url}/changes/${second}/terminals`);
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await page.locator(".terminal-screen").click();
  await waitForPrompt(`corvi-${second}`);
  await page.keyboard.type("pwd > second.txt\n");
  await waitForFile(join(tmp, "changes", second, "second.txt"), `${join(tmp, "changes", second)}\n`);
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
  await waitForPrompt();
  await page.keyboard.type("pwd > back.txt\n");
  await waitForFile(join(tmp, "changes", id, "back.txt"), `${join(tmp, "changes", id)}\n`);
  expect(await Bun.file(join(tmp, "changes", id, "back.txt")).text()).toBe(
    `${join(tmp, "changes", id)}\n`,
  );
  // The second change's session is not needed again, and leaving it would put its windows in
  // the sidebar counts the tests after this one make.
  await tmux("kill-session", "-t", `corvi-${second}`);
  await page.close();
}, budget(60_000));

test.skipIf(!usable)("the terminal tab runs a shell in the change directory", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  // Straight to the terminal page: the navigation column has no "Terminals" button, because
  // "the terminals" is not something to look at — a window is.
  await page.goto(`${url}/changes/${id}/terminals`);
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await page.locator(".terminal-screen").click();

  // tmux only starts when the browser connects, and the shell only prompts after that.
  const started = async (): Promise<boolean> => (await tmux("ls")).includes(session);
  await waitFor("the session to start", started);
  await waitForPrompt();

  await page.keyboard.type("pwd > out.txt\n");
  await waitForFile(join(tmp, "changes", id, "out.txt"), `${join(tmp, "changes", id)}\n`);
  expect(await Bun.file(join(tmp, "changes", id, "out.txt")).text()).toBe(
    `${join(tmp, "changes", id)}\n`,
  );

  // A second window is tmux's own business, and the prefix key has to reach it through xterm.js.
  await page.keyboard.press("Control+b");
  await page.keyboard.press("c");
  expect(
    await until(async () => (await tmux("list-windows", "-t", session)).split("\n").length, 2),
  ).toBe(2);

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
  // the pi reporter sets on its own pane.
  await page.keyboard.type("tmux set -p @agent_name pi\n");
  await page.keyboard.type("tmux set -p @agent_status working\n");
  expect(
    await until(async () => (await strip.allInnerTexts())[1]?.trim(), "repo - (pi working)"),
  ).toBe("repo - (pi working)");
  // The name the session is given replaces the composed label, in the column and in the tabs
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
  await page.keyboard.type("tmux set -p -u @agent_name\n");
  expect(await until(async () => (await strip.allInnerTexts())[1]?.trim(), "repo")).toBe("repo");

  // A new window starts where the current one is, not back at the change: the second window
  // walked into the repository above, so this one starts there too. The strip's own new tab is the
  // way to ask for one; the navigation column lists the windows there are and no more.
  await page.locator(".window-tab.new").click();
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
  expect(
    await until(async () => tmux("display-message", "-p", "-t", session, "#{window_index}"), baseIndex),
  ).toBe(baseIndex);

  // Clicking a tab must not take the keyboard with it: you click one to type in the window it opens.
  await page.locator(".window-tab.new").click();
  await waitForPrompt();
  await page.keyboard.type("pwd > typed-after-click.txt\n");
  await waitForFile(join(tmp, "changes", id, "typed-after-click.txt"));

  // And closing the cheat sheet hands the keyboard back: it is a modal dialog, so the browser moved
  // the focus into it, and a terminal you have to click before typing is a terminal clicked twice.
  // The cheat sheet is the actions menu's last item now (apps/web/src/actions/RunMenu.tsx).
  await page.locator("header.change-bar .menu > button").click();
  await page.getByRole("button", { name: "tmux cheat sheet" }).click();
  await page.locator("dialog[open]").waitFor();
  await page.getByRole("button", { name: "Close" }).click();
  await page.locator("dialog[open]").waitFor({ state: "detached" });
  await page.keyboard.type("pwd > typed-after-sheet.txt\n");
  await waitForFile(join(tmp, "changes", id, "typed-after-sheet.txt"));

  // The pty follows the pane: a resized window re-fits xterm and tells the pty, so tmux's client
  // size follows instead of leaving a strip of the terminal unused. Height counts as much as
  // width: the xterm canvas is the height of its last fit, and a content-sized terminal page
  // makes that canvas the floor of the document — the page grows with it and then cannot shrink,
  // so a shorter window scrolls and the shell keeps its old size. The height assertions below are
  // what a width-only check let pass (wide and short is not the same as smaller).
  const clientSize = async (): Promise<{ width: number; height: number }> => {
    const [size = ""] = (
      await tmux("list-clients", "-t", session, "-F", "#{client_width}x#{client_height}")
    ).split("\n");
    const [width, height] = size.split("x");
    return { width: Number(width), height: Number(height) };
  };
  const clientWhen = async (
    want: (size: { width: number; height: number }) => boolean,
  ): Promise<{ width: number; height: number }> => {
    let size = await clientSize();
    await waitFor("the pty to follow the resized window", async () => {
      size = await clientSize();
      return want(size);
    });
    return size;
  };
  const before = await clientSize();
  await page.setViewportSize({ width: 1000, height: 700 });
  const smaller = await clientWhen((s) => s.width < before.width && s.height < before.height);
  expect(smaller.width).toBeLessThan(before.width);
  expect(smaller.height).toBeLessThan(before.height);
  // The page fits the window: a taller terminal than the window is what put a scrollbar on the
  // page, and the terminal is only able to shrink because the page can.
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  // And back up: the pane is not a ratchet that only remembers its largest size.
  await page.setViewportSize({ width: 1200, height: 900 });
  const bigger = await clientWhen((s) => s.height > before.height);
  expect(bigger.height).toBeGreaterThan(before.height);

  await page.close();
}, budget(60_000));

test.skipIf(!usable)("a pane's environment is the user's, not the launcher's", async () => {
  // The server runs on Electron's own Node with the launcher's variables in its environment
  // (CORVI_PORT, CORVI_ROOT here; ELECTRON_RUN_AS_NODE whenever this suite itself runs inside such a
  // server, which is exactly the leak). The pane's shells are the user's, so they must not see
  // any of it — and they must see the change's context, which Corvi adds on purpose
  // (apps/server/src/capabilities/env.ts).
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`${url}/changes/${id}/terminals`);
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await page.locator(".terminal-screen").click();
  await waitForPrompt();
  // An absolute path, so the command reads the same whatever directory the pane is standing in.
  const out = join(tmp, "changes", id, "pane-env.txt");
  // The output is published in one move: the file appears only once `env` has finished writing
  // it. What the environment holds is what this test asserts on, so its content cannot be the
  // wait — and a file read early is empty, which would read as "the env was never set".
  await page.keyboard.type(`env > ${out}.tmp && mv ${out}.tmp ${out}\n`);
  await waitForFile(out);
  const env = await Bun.file(out).text();
  // Line-anchored: the suite's own `npm_lifecycle_script` ("export CORVI_ROOT=\"$ROOT\" …") rides
  // along in the environment, so a bare substring would false-positive on it.
  const hasVar = (name: string): boolean =>
    env.split("\n").some((line) => line.startsWith(`${name}=`));
  expect(hasVar("ELECTRON_RUN_AS_NODE")).toBe(false);
  expect(hasVar("CORVI_PORT")).toBe(false);
  expect(hasVar("CORVI_ROOT")).toBe(false);
  // A failing run prints what the pane got and what tmux thinks the session holds: together
  // they say whether the context never arrived, or arrived as someone else's.
  if (!hasVar("CORVI_CHANGE_ID")) {
    console.log(
      `pane env:\n${env}\nsession env:\n${await tmux("show-environment", "-t", session)}`,
    );
  }
  expect(hasVar("CORVI_CHANGE_ID")).toBe(true);
  expect(env).toContain(`CORVI_CHANGE_DIR=${join(tmp, "changes", id)}`);
  await page.close();
}, budget(60_000));

test.skipIf(!usable)("a bare tmux command cannot reach the change's session", async () => {
  // Corvi's sessions live on their own socket (CORVI_TMUX_SOCKET, tmux.ts): a tmux command that
  // forgets to name it resolves the way tmux always does — $TMUX, else $TMUX_TMPDIR/tmux-<uid>/
  // default — and finds nothing of ours. This is what makes a careless kill-server from a probe,
  // a script or an agent's stray test harmless to Corvi's terminals.
  await seedSession(); // the session the assertions below are about
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
  // The session is there for whoever names the socket, as the terminal page that made it did.
  expect(await tmux("ls")).toContain(session);
}, budget(60_000));

test.skipIf(!usable)("the terminal page's bar is its windows, not the change's controls", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`${url}/changes/${id}/terminals`);
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });

  // The row is the windows' and the key reference's, and of the change itself it says nothing: the
  // name is the column's entry, and the state and the actions are its other views' — they say
  // nothing while a shell has the keyboard, which is why the windows are what you switch between.
  // The one menu it carries is the terminal's own (its actions and, last, the key reference), not
  // the change's.
  expect(
    await page
      .locator(".page.terminal-page .change-bar h2, .page.terminal-page .change-bar .subject")
      .count(),
  ).toBe(0);
  expect(await page.locator("header select").count()).toBe(0);
  expect(await page.locator("header .menu").count()).toBe(1);
  expect(await page.getByRole("button", { name: "Actions ▾" }).count()).toBe(1);
  expect(await page.locator(".change-tabs").count()).toBe(0);
  // And the screen carries no tooltip: the window's row says which change's terminal it is, and a
  // floating "terminal for …" over the grid is in the way of reading it.
  expect(await page.locator(".terminal-screen").getAttribute("title")).toBeNull();

  // The first tab is the change's overview, not a window: the terminal page is not a one-way
  // door. Then a tab per tmux window, and the menu on the right (its last item is the key
  // reference — the item itself is pinned in the action-menu test).
  const allTabs = page.locator(".window-tab");
  expect((await allTabs.first().innerText()).trim()).toBe("Overview");
  const tabs = page.locator(".window-tab:not(.new):not(.overview)");
  await sessionUp();
  const windows = (await tmux("list-windows", "-t", session)).split("\n").length;
  expect(await until(() => tabs.count(), windows)).toBe(windows);

  // The current window's tab is marked the way the column marks its own: filled, white text and
  // icon, rounded only at the top, and sitting on the terminal rather than above a gap or line.
  const currentTab = page.locator(".window-tab.current");
  const bar = page.locator(".page.terminal-page .change-bar");
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
  // tab you are looking at, where only the label goes white. This is the working agent window.
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

  // And the overview tab goes back to the page the change is about — where the same row is waiting
  // at the very top, with the overview tab where you are and the same terminals beside the name.
  // The change's views open on its plan (remember.ts): nothing else has been viewed in this page.
  await allTabs.first().click();
  await page.waitForSelector(".plan-page .md-editor");
  expect(new URL(page.url()).pathname).toBe(`/changes/${id}`);
  expect(await page.locator(".change-bar .window-tab.overview.current").count()).toBe(1);
  expect(await page.locator(".change-bar .window-tab:not(.new):not(.overview)").count()).toBe(
    windows,
  );
  const [titleBar, tabsRow, columnBox] = await Promise.all([
    page.locator(".change-bar").boundingBox(),
    page.locator(".change-tabs").boundingBox(),
    page.locator(".sidebar").boundingBox(),
  ]);
  const viewport = await page.evaluate(() => [window.innerWidth, window.innerHeight] as const);
  // The change's own row is the page's first row — the window's title bar in the app, and the same
  // one the terminal page showed — with the tabs row right under it: both against the top, the
  // column and the right edge of the content area rather than under the page's own padding
  // (docs/manual/interface.md).
  expect(titleBar!.y).toBe(0);
  expect(Math.abs(titleBar!.x - (columnBox!.x + columnBox!.width))).toBeLessThanOrEqual(1);
  expect(Math.abs(titleBar!.x + titleBar!.width - viewport[0])).toBeLessThanOrEqual(1);
  expect(Math.abs(tabsRow!.y - (titleBar!.y + titleBar!.height))).toBeLessThanOrEqual(1);
  expect(Math.abs(tabsRow!.x - (columnBox!.x + columnBox!.width))).toBeLessThanOrEqual(1);
  expect(Math.abs(tabsRow!.x + tabsRow!.width - viewport[0])).toBeLessThanOrEqual(1);

  // The two pages' rows are the same row — same height, held at the top — and neither carries the
  // change's name (docs/manual/interface.md).
  expect(await page.locator(".change-bar .subject").count()).toBe(0);
  expect(Math.abs(titleBar!.height - barBox!.height)).toBeLessThanOrEqual(1);

  // And a window tab from here opens that terminal, rather than selecting a window you cannot
  // see: on the dashboard the tab is the way in.
  await page.locator(".change-bar .window-tab:not(.new):not(.overview)").first().click();
  await page.waitForSelector(".terminal-screen .xterm-screen");
  expect(new URL(page.url()).pathname).toBe(`/changes/${id}/terminals`);
  await page.close();
}, budget(60_000));

test.skipIf(!usable)("out of a terminal, the overview lands where you left off", async () => {
  // The way around a change: the window strip's Overview tab against its terminal windows. Out
  // of a terminal it opens the change's views — its plan until you have been elsewhere in them,
  // and then the view you left. Remembered for the page's life only (remember.ts).
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  try {
    await page.goto(`${url}/changes/${id}/terminals`);
    await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
    await page.locator(".window-tab:not(.new):not(.overview)").first().waitFor();

    // Nothing remembered yet: the plan, where a change opens.
    await page.locator(".window-tab.overview").click();
    await page.waitForSelector(".change-tabs .tab.current");
    expect(new URL(page.url()).pathname).toBe(`/changes/${id}`);
    expect((await page.locator(".change-tabs .tab.current").innerText()).trim()).toBe("Plan");

    // Elsewhere in the views, then back into a terminal window…
    await page.locator(".change-tabs .tab", { hasText: "Dashboard" }).click();
    await page.waitForSelector(".widget");
    await page.locator(".window-tab:not(.new):not(.overview)").first().click();
    await page.waitForSelector(".terminal-screen .xterm-screen");

    // …and out again: the dashboard, where you left off — not the plan again.
    await page.locator(".window-tab.overview").click();
    await page.waitForSelector(".widget");
    expect(new URL(page.url()).pathname).toBe(`/changes/${id}/dashboard`);
    expect((await page.locator(".change-tabs .tab.current").innerText()).trim()).toBe("Dashboard");
  } finally {
    await page.close();
  }
}, budget(60_000));

test.skipIf(!usable)("a window tab dragged onto another takes its place", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`${url}/changes/${id}/terminals`);
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  // Two windows to drag between — the fresh session this test starts with has one, so the second
  // is its own rather than an earlier test's leftover. The session first: a window made before
  // the pty has started tmux is made against nothing.
  await sessionUp();
  await tmux("new-window", "-t", session, "-d");
  const tabs = page.locator(".window-tab:not(.new):not(.overview)");
  await tabs.first().waitFor();
  expect(await until(() => tabs.count(), 2)).toBe(2);

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
}, budget(60_000));

test.skipIf(!usable)("a window that starts waiting is announced, and the notice opens it", async () => {
  // The session and its window first: what the watcher reports below must be this test's own
  // window, not an earlier test's leftover.
  await seedSession();
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  // Stand in for the app's host: the real window exposes `window.corviHost` from its preload
  // (apps/desktop/src/electron/preload.ts), a browser has none, so the test installs the same shape
  // and keeps the open-window callback the page registers on mount.
  await page.addInitScript(() => {
    const store: unknown[] = [];
    (window as unknown as { __notices: unknown[] }).__notices = store;
    (window as unknown as { corviHost: unknown }).corviHost = {
      notify: (message: unknown) => store.push(message),
      onOpenWindow: (callback: (change: string, window: string) => void) => {
        (window as unknown as { __openWindow: unknown }).__openWindow = callback;
      },
    };
  });
  await page.goto(`${url}/changes/${id}/dashboard`);
  await page.waitForSelector(".widget");

  const active = await tmux("display-message", "-p", "-t", session, "#{window_index}");
  const windowId = await tmux("display-message", "-p", "-t", `${session}:${active}`, "#{window_id}");
  const agentOption = (name: string, value?: string): Promise<string> =>
    tmux("set-option", "-p", "-t", `${session}:${active}`, ...(value === undefined ? ["-u", name] : [name, value]));

  /** The window labels the navigation column shows — what the page has heard from the watcher.
   * A label rides the `windows` event, and the watcher announces it from the same tick that
   * records the attention diff (apps/server/src/capabilities/watch.ts): the column showing a
   * state is proof the watcher recorded it, so the edge into "waiting" is watched happen rather
   * than timed. The notice is an edge — a window the watcher first finds already waiting only
   * seeds the picture and says nothing. */
  const shown = (text: string): Promise<void> =>
    waitFor(`the column to show ${text}`, async () =>
      (await page.locator(".sidebar .entry.window").allInnerTexts()).join(" | ").includes(text),
    );

  // Working first, and waiting for the column to show it: that tick's attention diff records
  // the non-waiting state before the flip.
  await agentOption("@agent_name", "pi");
  await agentOption("@agent_status", "working");
  await shown("pi working");

  await agentOption("@agent_session_name", "Build the thing");
  await agentOption("@agent_last_message", "I fixed the layout.");
  await agentOption("@agent_status", "waiting");

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

  // Dismissing the notification the page draws itself — the toast, still up from the notice
  // above — must not take the keyboard from the terminal it floats over: a terminal you have to
  // click before typing is a terminal clicked twice. Typing is what proves it, because only the
  // terminal's own input has the pty, and the shell is in the repo by now, so the markers are
  // written by absolute path rather than by where the last test left it.
  await page.locator(".terminal-screen").click();
  await waitForPrompt();
  await page.keyboard.type(`echo ready > ${join(tmp, "terminal-ready.txt")}\n`);
  await waitForFile(join(tmp, "terminal-ready.txt"), "ready\n");

  await page.locator(".toast-close").click();
  await page.locator(".toast").waitFor({ state: "detached" });
  await page.keyboard.type(`echo typed > ${join(tmp, "typed-after-toast.txt")}\n`);
  await waitForFile(join(tmp, "typed-after-toast.txt"), "typed\n");

  // Looking straight at it is the one silent case: the watcher still reports the edge, and the
  // page holds its tongue because you are looking at it. The name is put back first — it replaces
  // the composed label the gates read — then working, then waiting, then one more labelled
  // change. The watcher emits a tick's windows announce before that tick's notify, so the last
  // label arriving is proof the page has already handled whatever the flip's tick produced.
  expect(await page.evaluate(() => document.hasFocus())).toBe(true);
  await agentOption("@agent_session_name");
  await agentOption("@agent_last_message");
  await shown("pi waiting");
  await agentOption("@agent_status", "working");
  await shown("pi working");
  await agentOption("@agent_status", "waiting");
  await shown("pi waiting");
  await agentOption("@agent_session_name", "Witness");
  await shown("Witness");
  expect((await notices()).length).toBe(1);

  for (const option of ["@agent_status", "@agent_name", "@agent_session_name", "@agent_last_message"]) {
    await agentOption(option);
  }
  await page.close();
}, budget(60_000));

test.skipIf(!usable)("closing the page detaches the pty but keeps the session", async () => {
  // A pty dies with its socket, the way one dies when its page is closed — and the session, and
  // everything running in it, must not be taken with it. The next connection attaches to the
  // same windows.
  await seedSession();
  await tmux("set-option", "-g", "destroy-unattached", "off"); // a developer's tmux.conf must not decide this
  await tmux("new-window", "-t", session, "-d"); // one more than the session already has
  const before = (await tmux("list-windows", "-t", session)).split("\n").length;

  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`${url}/changes/${id}/terminals`);
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await waitFor("the page's pty to attach", async () => (await clientCount(session)) > 0); // the pty attached
  await page.close();
  await waitFor("the closed page's client to detach", async () => (await clientCount(session)) === 0);

  // A fresh connection finds the session and its windows, not a fresh session.
  const again = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await again.goto(`${url}/changes/${id}/terminals`);
  await again.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  expect((await tmux("list-windows", "-t", session)).split("\n").length).toBe(before);
  await again.close();
}, budget(60_000));

test.skipIf(!usable)("the terminal fills the frame, with no scrollbar of its own", async () => {
  // xterm's stylesheet gives the viewport `overflow-y: scroll` whatever the scrollback is, and
  // the fit addon reserves the scrollbar's width when there is scrollback to scroll. On a machine
  // that shows scrollbars always, the two together are a pale empty bar down the right of the
  // terminal and a grid a couple of columns narrower than the frame. tmux owns scrolling (mouse
  // mode), so the terminal is started with no scrollback and the stylesheet takes the bar itself
  // away.
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`${url}/changes/${id}/terminals`);
  const screen = page.locator(".terminal-screen .xterm-screen");
  await screen.waitFor({ timeout: 15_000 });

  // One character cell, from the two sides: the pane's own column count, and the grid's width.
  // The client's size is the pty's, so wait for the pty rather than read a client that is not
  // there yet.
  await waitFor("the page's pty to attach", async () => (await clientCount(session)) > 0);
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
  // xterm's own stylesheet is part of the page's (apps/web/src/app-root/styles.css imports it, and the build
  // inlines it). It is the one thing the measurements above cannot see: without it the screen is not
  // positioned and the terminal draws over nothing — an empty page — while every box here still
  // measures correctly. `position: relative` on the screen is xterm's rule, not ours.
  expect(await screen.evaluate((el) => getComputedStyle(el).position)).toBe("relative");
  // The grid may be short by less than one cell — columns are whole characters — but no more.
  // A scrollbar is a good deal wider than one cell, which is the strip this catches.
  expect(rightGap).toBeLessThan(box.width / cols);
  await page.close();
}, budget(60_000));

test.skipIf(!usable)("a right click is tmux's menu, not the browser's as well", async () => {
  // tmux draws its own menu into the terminal grid when mouse mode reports a right click; the
  // browser does not know that happened, and shows its own on top unless told not to.
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`${url}/changes/${id}/terminals`);
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  const prevented = await page.locator(".terminal-screen").evaluate((el) =>
    !el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
  );
  expect(prevented).toBe(true);
  await page.close();
}, budget(60_000));

test.skipIf(!usable)("the page copies and pastes through the system clipboard", () =>
  // The system clipboard is the one thing every suite on the machine shares: another suite
  // running this same test erases this one's marker mid-wait, and this one erases its marker —
  // both flake on a wait neither can ever satisfy. The machine-wide lock gives the clipboard one
  // user at a time however many suites are up; this test's budget covers the wait for it.
  withMachineLock("clipboard", async () => {
  // ttyd's page owned these chords; with xterm.js in the page they are ours. The browser
  // permission is granted here the way the app grants it (apps/desktop/src/electron/main.ts).
  const page = await browser.newPage({
    viewport: { width: 1200, height: 800 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  await page.goto(`${url}/changes/${id}/terminals`);
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await page.locator(".terminal-screen").click();

  // The pty attaches when the page's socket opens, and the attach is what starts tmux and sets
  // the session options; until then there is no server to ask. The pane drawing its prompt is
  // that having happened — no duration guessed.
  await waitForPrompt();

  // Corvi asks tmux for the clipboard explicitly; the page only has a clipboard to write into
  // because tmux sends its copies as OSC 52 (tmux.ts, and the addon in TerminalPane).
  expect(
    await until(async () => tmux("show-options", "-s", "set-clipboard"), "set-clipboard on"),
  ).toBe("set-clipboard on");

  // A known line at the top of the screen. The status line is hidden so the pane fills the
  // grid: the drag below starts in the pane's first cell whatever the user's ~/.tmux.conf does
  // with the status bar.
  await tmux("set-option", "-t", session, "status", "off");
  await page.keyboard.type("clear; echo COPY-MARKER-42\n");
  await echoInPane("COPY-MARKER-42");

  const screen = (await page.locator(".terminal-screen .xterm-screen").boundingBox())!;
  const clipboard = (): Promise<string> => page.evaluate(() => navigator.clipboard.readText());
  const dragAcrossScreen = async (): Promise<void> => {
    await page.mouse.move(screen.x + 1, screen.y + 1);
    await page.mouse.down();
    await page.mouse.move(screen.x + screen.width - 2, screen.y + screen.height - 2, { steps: 8 });
    await page.mouse.up();
  };
  // The write comes back through tmux (mouseup, the pty, the page), so the read has to wait for
  // that round trip rather than race it.
  const markerSoon = async (): Promise<string> => {
    let text = "";
    await waitFor("the selection to reach the clipboard", async () => {
      text = await clipboard();
      return text.includes("MARKER-42");
    });
    return text;
  };

  // A plain drag is tmux's selection (mouse mode is on) and now lands on the system clipboard by
  // itself: tmux sends it as OSC 52, which the page's addon writes. No chord, no buffer step.
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await dragAcrossScreen();
  expect(await markerSoon()).toContain("MARKER-42");

  // tmux is not a clipboard writer from here on. The shift-drag below reaches tmux as well as
  // xterm, and tmux answers a drag on the cells the first drag already covered with a copy of
  // its own — an OSC 52 that the page writes into the system clipboard whenever it happens to
  // arrive. It arrived two milliseconds after the payload the paste below checks was written,
  // which pasted tmux's word instead of the command. The chord and the middle click that follow
  // have nothing of their own to do with tmux's clipboard, so the two stop racing for it; the
  // tmux half of the story is the drag above, asserted, and the option this test read as `on`.
  await tmux("set-option", "-s", "set-clipboard", "off");

  // The browser's own selection is still a modifier away, because mouse mode is on. Which
  // modifier is xterm.js's (SelectionService.shouldForceSelection): shift everywhere but macOS,
  // where it is option — the same chord the cheat sheet gives, and the only one a Mac has. All
  // this needs is the marker inside the selection.
  await page.evaluate(() => navigator.clipboard.writeText(""));
  const forceSelection = platformName === "mac" ? "Alt" : "Shift";
  await page.keyboard.down(forceSelection);
  await dragAcrossScreen();
  await page.keyboard.up(forceSelection);

  await page.keyboard.press("Control+Shift+C");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  // The first cell depends on where the drag's pixel lands in a character cell; the marker in
  // the clipboard is what this is about.
  expect(copied).toContain("MARKER-42");

  // And back in: the chord pastes the clipboard into the shell's editor, where Enter runs it.
  // An absolute path, so the command reads the same whatever directory the pane is standing in.
  const pasted = join(tmp, "changes", id, "pasted.txt");
  await page.evaluate((path) => navigator.clipboard.writeText(`echo PASTED > ${path}`), pasted);
  // The clipboard must still hold what was just written when the chord reads it: that read is
  // the whole of the paste, and a clipboard clobbered in between pastes someone else's text.
  expect(await clipboard()).toBe(`echo PASTED > ${pasted}`);
  await page.locator(".terminal-screen").click();
  expect(await page.evaluate(() => document.hasFocus())).toBe(true);
  await page.keyboard.press("Control+Shift+V");
  // The clipboard read is asynchronous; Enter before it lands would execute an empty line — so
  // wait for the pasted text to appear in the pane, which is the shell having received it. A
  // failure says what the page saw instead: focus (the chord needs the terminal to have it) and
  // the clipboard the chord would have read.
  try {
    await echoInPane("echo PASTED >");
  } catch (error) {
    const probe = await page.evaluate(async () => ({
      focus: document.hasFocus(),
      clipboard: await navigator.clipboard.readText().catch((e) => `read failed: ${e}`),
    }));
    throw new Error(`${String(error)}\nafter the chord the page saw: ${JSON.stringify(probe)}`);
  }
  await page.keyboard.press("Enter");
  await waitForFile(pasted, "PASTED\n");
  expect(await Bun.file(pasted).text()).toBe("PASTED\n");

  // Middle-click pastes the system clipboard too, not tmux's newest buffer: the page takes the
  // mousedown before xterm can report it (TerminalPane).
  const middle = join(tmp, "changes", id, "middle.txt");
  await page.evaluate((path) => navigator.clipboard.writeText(`echo MIDDLE > ${path}`), middle);
  await page.mouse.click(screen.x + 20, screen.y + 20, { button: "middle" });
  // The clipboard read is asynchronous here too; Enter before it lands runs an empty line.
  await echoInPane("echo MIDDLE >");
  await page.keyboard.press("Enter");
  await waitForFile(middle, "MIDDLE\n");
  expect(await Bun.file(middle).text()).toBe("MIDDLE\n");
  await page.close();
  }),
  budget(180_000),
);

test.skipIf(!usable)("the action menu lists the actions and pastes one without submitting it", async () => {
  // An action file in the global scope — beside the test's config.json (serverEnv names it) —
  // picked up on the next menu open: discovery is per request, no restart.
  const ranFile = join(tmp, "changes", id, "menu-ran.txt");
  await mkdir(join(tmp, "actions"), { recursive: true });
  await writeFile(
    join(tmp, "actions", "say-hello.md"),
    `---\nlabel: Say hello\nkind: prompt\ntarget: active\n---\necho menu-ran > ${ranFile}\n`,
  );
  // The session and its window first (every test starts with none): the pane option below is
  // set on this test's own window — or on no window at all, and the menu then sees a plain
  // shell and offers nothing to paste.
  await seedSession();
  // The window presents as an agent to the menu: `@agent_status` is exactly what pi's own
  // busy-title extension publishes (packages/agents/src/presenter.ts), and the menu's filter
  // keys on the icon it produces. "working" rather than "waiting" — a waiting window wants the
  // user, and the notification that would fire is another test's subject.
  await tmux("set-option", "-p", "-t", session, "@agent_status", "working");

  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`${url}/changes/${id}/terminals`);
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await page.locator(".terminal-screen").click();
  await waitForPrompt();

  // The menu fetches its list when opened and the filter follows the window on screen: the
  // prompt action is offered because the active window is an agent one.
  await page.locator("header.change-bar .menu > button").click();
  const items = page.locator("header.change-bar .menu-items button");
  await waitFor(
    "the menu to list the action",
    async () => (await items.allInnerTexts()).some((t) => t.includes("Say hello")),
  );
  expect((await items.allInnerTexts()).some((t) => t.includes("tmux cheat sheet"))).toBe(true);

  // Escape closes it even with the keyboard in the terminal: the terminal encodes keys as input
  // and swallows the keydown before it bubbles, so the menu takes the key in capture — and takes
  // it rather than sending an Escape to the shell below. Then it opens again on the same click.
  await page.keyboard.press("Escape");
  await waitFor(
    "the menu to close on Escape",
    async () => (await items.count()) === 0,
  );
  await page.locator("header.change-bar .menu > button").click();
  await waitFor(
    "the menu to list the action again",
    async () => (await items.allInnerTexts()).some((t) => t.includes("Say hello")),
  );

  await items.filter({ hasText: "Say hello" }).click();
  // The notice names what happened and where.
  await waitFor(
    "the notice",
    async () => (await page.locator("header.change-bar .summary").allInnerTexts()).some((t) => t.includes("read it and send it")),
  );

  // Pasted into the pane and not submitted: the line waits at the prompt and nothing ran.
  await waitFor(
    "the paste to land",
    async () => (await tmux("capture-pane", "-p", "-t", session)).includes("echo menu-ran >"),
  );
  expect(await Bun.file(ranFile).exists()).toBe(false);
  // The one keystroke Corvi keeps is yours: Enter runs the line the paste left behind.
  await tmux("send-keys", "-t", session, "Enter");
  await waitForFile(ranFile, "menu-ran\n");

  await tmux("set-option", "-p", "-u", "-t", session, "@agent_status");
  await page.close();
}, 60_000);

test.skipIf(!usable)("a notified command window freezes over its output and calls when it ends", async () => {
  // Two action files in the global scope: one that notifies (and so keeps its window), and one
  // whose window is gone when it ends. The notified one runs long enough for the watcher to see
  // it before it ends: a notice is an edge, and the edge is out of "was quiet" into "wants you".
  // Its `exit 3` is deliberate and load-bearing: an exit in the body must end the run, not the
  // wrapper that records how it ended.
  const ranFile = join(tmp, "changes", id, "notify-ran.txt");
  const plainFile = join(tmp, "changes", id, "plain-ran.txt");
  await mkdir(join(tmp, "actions"), { recursive: true });
  await writeFile(
    join(tmp, "actions", "notify-later.md"),
    `---\nlabel: Notify later\nkind: command\ntarget: new\nnotify: true\n---\necho FROZEN-OUTPUT\nsleep 3\necho done > ${ranFile}\nexit 3\n`,
  );
  await writeFile(
    join(tmp, "actions", "plain-run.md"),
    `---\nlabel: Plain run\nkind: command\ntarget: new\n---\necho done > ${plainFile}\n`,
  );

  // Stand in for the app's host, as the waiting-agent test above does: collect the notices
  // instead of showing them.
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.addInitScript(() => {
    const store: unknown[] = [];
    (window as unknown as { __notices: unknown[] }).__notices = store;
    (window as unknown as { corviHost: unknown }).corviHost = {
      notify: (message: unknown) => store.push(message),
      onOpenWindow: () => undefined,
    };
  });
  await page.goto(`${url}/changes/${id}`);
  // A change opens on its plan now (the dashboard is its own tab), and the column below shows
  // the windows on every one of its pages.
  await page.waitForSelector(".plan-page");

  const shown = (text: string): Promise<void> =>
    waitFor(`the column to show ${text}`, async () =>
      (await page.locator(".sidebar .entry.window").allInnerTexts()).join(" | ").includes(text),
    );

  const run = await fetch(`${url}/api/changes/${id}/terminal/actions`, {
    method: "POST",
    body: JSON.stringify({ key: "global:notify-later" }),
  });
  expect(run.ok).toBe(true);
  const started: { window?: { id: string } } = await run.json();
  // A real tmux window id, not merely "present": the delivery addresses the window by it.
  expect(started.window?.id).toMatch(/^@\d+$/);

  // While it runs, the wrapper's label is the window's name in the column — and a tick seeing it
  // is what records "was quiet" for the edge below.
  await shown("Notify later");
  await waitForFile(ranFile, "done\n");

  // The exit code outlived the pane it belongs to (the pane is dead but kept), the presenter
  // read it off the frozen pane, and the notice is the whole pipeline arriving.
  const notices = (): Promise<unknown[]> =>
    page.evaluate(() => (window as unknown as { __notices: unknown[] }).__notices);
  expect(await until(async () => (await notices()).length === 1, true)).toBe(true);
  expect((await notices())[0]).toMatchObject({
    kind: "notify",
    title: "Notify later",
    subtitle: id,
    body: "finished with exit code 3",
    change: id,
    window: started.window?.id,
    sound: true,
  });

  // The window stays frozen over its output: dead pane, and the text kept in its history —
  // the screen clears when the shell goes, what scrolled does not.
  expect(
    await until(
      async () => (await tmux("capture-pane", "-p", "-S", "-", "-t", started.window!.id)).includes("FROZEN-OUTPUT"),
      true,
    ),
  ).toBe(true);
  expect(await tmux("display-message", "-p", "-t", started.window!.id, "#{pane_dead}")).toBe("1");

  // A command window without notify closes when it ends and says nothing.
  const before = (await tmux("list-windows", "-t", session)).split("\n").length;
  const plain = await fetch(`${url}/api/changes/${id}/terminal/actions`, {
    method: "POST",
    body: JSON.stringify({ key: "global:plain-run" }),
  });
  expect(plain.ok).toBe(true);
  await waitForFile(plainFile, "done\n");
  expect(await until(async () => (await tmux("list-windows", "-t", session)).split("\n").length === before, true)).toBe(true);
  expect((await notices()).length).toBe(1);

  await tmux("kill-window", "-t", started.window!.id);
  await page.close();
}, 60_000);

test.skipIf(!usable)("a terminal whose session is gone says so", async () => {
  // It takes the private tmux server down with it, so nothing that needs tmux may follow.
  // The session is seeded before the page mounts: the page reads its windows once as it mounts,
  // and against a session still starting it would read an empty world and never be told
  // different until something else moved.
  await seedSession();
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`${url}/changes/${id}/terminals`);
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  expect(await page.locator(".terminal-gone").count()).toBe(0);
  const windows = page.locator(".sidebar .entry.window");
  expect(await until(() => windows.count(), 1)).toBe(1);

  // The push path is alive before the loss, or the loss could never be reported and this test
  // would be about the bus rather than about the pane: the server says it is watching
  // (/api/events/listeners, there for the tests), and a window made behind the page's back
  // arrives at the page on its own. Whatever carries the loss below carries this.
  await waitFor("the server to be watching for pages", async () => {
    const state = (await fetch(`${url}/api/events/listeners`).then((r) => r.json())) as {
      watching: boolean;
    };
    return state.watching;
  });
  await tmux("new-window", "-t", session, "-d");
  expect(await until(() => windows.count(), 2)).toBe(2);

  // The server goes away under the open terminal, the way a killed tmux server does: the page
  // has to say so rather than leave a dead pane that looks merely slow.
  await tmux("kill-server");

  // What the page notices first: its window list empties (the server's own answer went empty at
  // once — its route reads tmux per request).
  expect(await until(() => windows.count(), 0, budget(30_000))).toBe(0);

  // The pane waits five seconds after its window list empties before calling the session gone,
  // so that a terminal merely starting is not mistaken for one that was lost. The wait is
  // verified rather than advanced: a fake clock stops the page's own timers, and the page needs
  // those to hear about its loss at all — with one installed, the list above never empties —
  // while five real seconds cost less than the guessing they replace. The two checks below are
  // the grace itself, in order: quiet through the middle of it (a fixed sample of a fixed
  // product delay, deliberately not scaled with the budgets — a stretched sample would land
  // past the grace and assert nothing), and speaking after it.
  await Bun.sleep(2_500);
  expect(await page.locator(".terminal-gone").count()).toBe(0);
  expect(await until(() => page.locator(".terminal-gone").count(), 1, budget(30_000))).toBe(1);

  // Reopening the tab starts a fresh session, which is what `new-session -A` would have done
  // anyway; the banner is about the loss, not a request to clean anything up.
  await page.reload();
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  expect(await until(async () => (await tmux("ls")).includes(session), true)).toBe(true);
  expect(await until(() => page.locator(".terminal-gone").count(), 0)).toBe(0);
  await page.close();
}, budget(60_000));
