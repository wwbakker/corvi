import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { budget, checkoutsOf, closePages, requireFreshWebBundle, runSh, serverEnv, testRun, testTempDir, tmuxTempDir, until, waitForUrl } from "./helpers.ts";
import { csiuFor } from "@corvi/terminals/model";
import { ensureHost } from "../apps/server/src/terminals/host/client.ts";

/**
 * The terminal through a real browser. The pty is owned by the terminal host now, not tmux: the
 * page's xterm is a glass over a host session, the window strip is the server's registry, and the
 * shells outlive the server. The server runs on Node (the host does too); the tmux socket below
 * exists only to keep the server's tmux reads — subagent windows — off the user's own server.
 *
 * The terminal itself is a canvas, so the tests assert what a command *did* (a file) rather than
 * reading the drawn text. A typed line cannot be lost — the socket and the starting shell both
 * buffer input — and the command is retried until its effect appears, which is the readiness gate.
 *
 * Skipped where the browser is missing, since the rest of Corvi works without it.
 */
const fileText = (path: string): Promise<string> => Bun.file(path).text().catch(() => "");

/** Run one command until its effect appears and settles. The retry covers the socket not being
 * open yet; the settle loop lets a duplicate retry that was already typed finish writing, so the
 * assertion after this does not read the file mid-truncate. */
const runCommand = async (page: Page, command: string, file: string, want: string): Promise<void> => {
  for (let attempt = 0; attempt < 40; attempt++) {
    await page.keyboard.type(`${command}\n`);
    for (let settle = 0; settle < 6; settle++) {
      if ((await fileText(file)) === want) {
        await Bun.sleep(150);
        if ((await fileText(file)) === want) return;
      }
      await Bun.sleep(150);
    }
  }
  throw new Error(`the command never wrote ${file} with ${JSON.stringify(want)} (saw ${JSON.stringify(await fileText(file))})`);
};

/** Run one command until it writes anything to `file` (for output whose exact bytes vary). */
const runToFile = async (page: Page, command: string, file: string): Promise<string> => {
  for (let attempt = 0; attempt < 40; attempt++) {
    await page.keyboard.type(`${command}\n`);
    const text = await fileText(file);
    if (text.length > 0) return text;
    await Bun.sleep(500);
  }
  throw new Error(`the command never wrote ${file}`);
};

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
let tmuxTmp: string;
let testSocket: string;
let browser: Browser;
let url: string;
let server: ReturnType<typeof Bun.spawn>;
const id = "PROJ-TERM";
const second = "PROJ-TERM-2";

const startServer = async (): Promise<void> => {
  server = Bun.spawn(["node", "apps/server/src/server.ts", `--corvi-test-run=${testRun()}`], {
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
  // A tmux socket of this run's own: the server's tmux reads (subagent windows) must never reach
  // the user's server, and a private path beats $TMUX whatever it says.
  delete process.env.TMUX;
  process.env.TMUX_TMPDIR = tmuxTmp;
  testSocket = join(tmuxTmp, `tmux-${process.getuid?.() ?? 0}`, "corvi");
  await mkdir(join(tmuxTmp, `tmux-${process.getuid?.() ?? 0}`), { recursive: true });
  process.env.CORVI_TMUX_SOCKET = testSocket;
  await startServer();
  const repo = join(tmp, "repo");
  await runSh(["git", "init", "-b", "main", repo]);
  await fetch(`${url}/api/changes`, { method: "POST", body: JSON.stringify({ id, checkouts: checkoutsOf([repo]) }) });
  const repo2 = join(tmp, "repo2");
  await runSh(["git", "init", "-b", "main", repo2]);
  await fetch(`${url}/api/changes`, { method: "POST", body: JSON.stringify({ id: second, checkouts: checkoutsOf([repo2]) }) });
  browser = await chromium.launch();
}, budget(120_000));

afterEach(async () => {
  await closePages(browser, "terminal");
});

afterAll(async () => {
  delete process.env.CORVI_TMUX_SOCKET;
  if (!usable) return;
  await browser?.close();
  server?.kill();
  await server?.exited;
  // The host outlives the server by design; the test still leaves none behind.
  await ensureHost({ socket: join(tmp, "state", "corvi", "host.sock"), checkout: process.cwd(), buildId: process.env.CORVI_BUILD ?? "dev", runtime: "node" })
    .then((result) => result.client.shutdown())
    .catch(() => undefined);
  await rm(tmp, { recursive: true, force: true });
}, budget(60_000));

const openTerminal = async (change: string): Promise<{ page: Page; dir: string }> => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`${url}/changes/${change}/terminals`);
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await page.locator(".terminal-screen").click();
  return { page, dir: join(tmp, "changes", change) };
};

/** Kill a change's live host session, as a crashed shell would leave the pane. */
const killHostSession = async (change: string): Promise<void> => {
  const { client } = await ensureHost({
    socket: join(tmp, "state", "corvi", "host.sock"),
    checkout: process.cwd(),
    buildId: process.env.CORVI_BUILD ?? "dev",
    runtime: "node",
  });
  const session = (await client.list()).find((entry) => entry.alive && entry.metadata?.change === change);
  if (session !== undefined) await client.kill(session.id);
  client.close();
};

test("the keys a terminal cannot encode are sent as CSI u", () => {
  const key = (
    over: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>,
  ): Parameters<typeof csiuFor>[0] => ({ key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });
  expect(csiuFor(key({ shiftKey: true }))).toBe("\u001b[13;2u");
  expect(csiuFor(key({ ctrlKey: true }))).toBe("\u001b[13;5u");
  expect(csiuFor(key({ shiftKey: true, ctrlKey: true }))).toBe("\u001b[13;6u");
  expect(csiuFor(key({}))).toBeUndefined();
  expect(csiuFor(key({ altKey: true }))).toBeUndefined();
  expect(csiuFor(key({ metaKey: true, shiftKey: true }))).toBeUndefined();
  expect(csiuFor(key({ key: "a", shiftKey: true }))).toBeUndefined();
});

test("a Bun server says it has no terminal rather than opening a silent socket", async () => {
  const { terminalUnavailable } = await import("../apps/server/src/terminals/server/session.ts");
  expect(terminalUnavailable()).toContain("needs Node");
});

test.skipIf(!usable)("the terminal tab runs a shell in the change directory", async () => {
  const { page, dir } = await openTerminal(id);
  await runCommand(page, "pwd > out.txt", join(dir, "out.txt"), `${dir}\n`);
  expect(await fileText(join(dir, "out.txt"))).toBe(`${dir}\n`);
  await page.close();
}, budget(90_000));

test.skipIf(!usable)("a terminal outlives the server that started it", async () => {
  const { page, dir } = await openTerminal(id);
  await runCommand(page, `export CORVI_SURVIVED=yes; echo set > ${join(dir, "survived-set.txt")}`, join(dir, "survived-set.txt"), "set\n");

  server.kill();
  await server.exited;
  await startServer();

  // A fresh page on the restarted server: the host survived, so the same shell answers.
  const again = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await again.goto(`${url}/changes/${id}/terminals`);
  await again.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await again.locator(".terminal-screen").click();
  await runCommand(again, `echo $CORVI_SURVIVED > ${join(dir, "survived.txt")}`, join(dir, "survived.txt"), "yes\n");
  expect(await fileText(join(dir, "survived.txt"))).toBe("yes\n");
  await again.close();
  await page.close();
}, budget(120_000));

test.skipIf(!usable)("the window strip is the server's registry: a new tab is a new shell", async () => {
  const { page } = await openTerminal(id);
  const tabs = page.locator(".window-tab:not(.new):not(.overview)");
  await tabs.first().waitFor({ timeout: 15_000 });
  expect(await tabs.count()).toBe(1);

  await page.locator(".window-tab.new").click();
  expect(await until(() => tabs.count(), 2)).toBe(2);

  // The navigation column lists the registry's windows too.
  const entries = page.locator(".sidebar .entry.window");
  expect(await until(() => entries.count(), 2)).toBe(2);

  // Selecting a tab makes it the active window.
  const label = (await tabs.first().innerText()).trim();
  await tabs.first().click();
  expect(await until(() => page.locator(".window-tab.current").innerText(), label)).toBe(label);
  await page.close();
}, budget(60_000));

test.skipIf(!usable)("another change's terminal is another pty", async () => {
  const first = await openTerminal(id);
  await runCommand(first.page, "pwd > first.txt", join(first.dir, "first.txt"), `${first.dir}\n`);

  const other = await openTerminal(second);
  await runCommand(other.page, "pwd > second.txt", join(other.dir, "second.txt"), `${other.dir}\n`);
  expect(await fileText(join(other.dir, "second.txt"))).toBe(`${other.dir}\n`);
  expect(await fileText(join(first.dir, "first.txt"))).toBe(`${first.dir}\n`);

  await first.page.close();
  await other.page.close();
}, budget(120_000));

test.skipIf(!usable)("a pane's environment is the user's, not the launcher's", async () => {
  const { page, dir } = await openTerminal(id);
  const out = join(dir, "pane-env.txt");
  const env = await runToFile(page, `env > ${out}`, out);
  // Line-anchored: the suite's own script text rides along in the environment, so a bare
  // substring would false-positive on it.
  const hasVar = (name: string): boolean => env.split("\n").some((line) => line.startsWith(`${name}=`));
  expect(hasVar("ELECTRON_RUN_AS_NODE")).toBe(false);
  expect(hasVar("CORVI_PORT")).toBe(false);
  expect(hasVar("CORVI_ROOT")).toBe(false);
  expect(hasVar("CORVI_CHANGE_ID")).toBe(true);
  expect(env).toContain(`CORVI_CHANGE_DIR=${dir}`);
  await page.close();
}, budget(90_000));

test.skipIf(!usable)("closing the page detaches but keeps the shell", async () => {
  const { page, dir } = await openTerminal(id);
  await runCommand(page, `export CORVI_KEEP=yes; echo set > ${join(dir, "keep-set.txt")}`, join(dir, "keep-set.txt"), "set\n");
  await page.close();

  const again = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await again.goto(`${url}/changes/${id}/terminals`);
  await again.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await again.locator(".terminal-screen").click();
  await runCommand(again, `echo $CORVI_KEEP > ${join(dir, "keep.txt")}`, join(dir, "keep.txt"), "yes\n");
  expect(await fileText(join(dir, "keep.txt"))).toBe("yes\n");
  await again.close();
}, budget(120_000));

test.skipIf(!usable)("a terminal whose session is gone says so", async () => {
  const { page, dir } = await openTerminal(id);
  await runCommand(page, "echo ready > ready.txt", join(dir, "ready.txt"), "ready\n");
  await killHostSession(id);
  await until(() => page.locator(".terminal-gone").count(), 1, budget(30_000));
  await page.close();
}, budget(60_000));
