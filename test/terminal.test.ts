import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { budget, checkoutsOf, closePages, requireFreshWebBundle, runSh, serverEnv, testRun, testTempDir, until, waitForUrl } from "./helpers.ts";
import { csiuFor } from "@corvi/terminals/model";
import { SNAPSHOT_IDLE_MS, SNAPSHOT_INTERVAL_MS } from "../apps/web/src/terminals/client/snapshot.ts";
import { ensureHost } from "../apps/server/src/terminals/host/client.ts";

/**
 * The terminal through a real browser. The pty is owned by the terminal host: the page's xterm
 * is a glass over a host session, the window strip is the server's registry, and the shells
 * outlive the server. The server runs on Node (the host does too).
 *
 * The terminal itself is a canvas, so the tests assert what a command *did* (a file) rather than
 * reading the drawn text. A command is typed only once the pane's socket is attached: the pty is
 * alive by then and buffers input until the shell reads it, so the line cannot be lost and a
 * retry cannot run it twice.
 *
 * Skipped where the browser is missing, since the rest of Corvi works without it.
 */
const fileText = (path: string): Promise<string> => Bun.file(path).text().catch(() => "");

/** Wait until the pane's socket is attached to a live session. The pty is alive by then and
 * buffers input until the shell reads it, so a command typed afterwards cannot be lost; the wait
 * scales with machine load, so a busy machine delays the test rather than cascading it. */
const awaitAttached = (page: Page): Promise<void> =>
  page.waitForSelector(".terminal-screen[data-attached]", { timeout: budget(60_000) }).then(() => undefined);

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

/** Run one command and wait for it to write anything to `file` (for output whose exact bytes vary). */
const runToFile = async (page: Page, command: string, file: string): Promise<string> => {
  await awaitAttached(page);
  await page.keyboard.type(`${command}\n`);
  await until(async () => (await fileText(file)).length > 0, true, budget(60_000));
  const text = await fileText(file);
  if (text.length === 0) throw new Error(`the command never wrote ${file}`);
  return text;
};

/** The xterm buffer, read through the seam the pane sets on its host element: the WebGL canvas
 * has no DOM text to read, and the buffer is exactly what a snapshot is taken from. */
type BrowserTerminal = {
  buffer: { active: { length: number; getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined } };
  options: {
    fontSize: number;
    cursorStyle?: string;
    cursorInactiveStyle?: string;
    cursorBlink?: boolean;
    theme?: { cursor?: string; background?: string; foreground?: string };
  };
  cols: number;
  rows: number;
  getSelection(): string;
  select(column: number, row: number, length: number): void;
  focus(): void;
  write(data: string): void;
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
const terminalLength = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const element = document.querySelector(".terminal-screen") as (HTMLElement & { corviTerminal?: BrowserTerminal }) | null;
    return element?.corviTerminal?.buffer.active.length ?? 0;
  });
/** The grid xterm is showing: what the pty has to match for wrapping and backspace to line up. */
const terminalSize = (page: Page): Promise<{ cols: number; rows: number }> =>
  page.evaluate(() => {
    const element = document.querySelector(".terminal-screen") as (HTMLElement & { corviTerminal?: BrowserTerminal }) | null;
    const term = element?.corviTerminal;
    return { cols: term?.cols ?? 0, rows: term?.rows ?? 0 };
  });
const terminalSelection = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const element = document.querySelector(".terminal-screen") as (HTMLElement & { corviTerminal?: BrowserTerminal }) | null;
    return element?.corviTerminal?.getSelection() ?? "";
  });
const terminalFontSize = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const element = document.querySelector(".terminal-screen") as (HTMLElement & { corviTerminal?: BrowserTerminal }) | null;
    return element?.corviTerminal?.options.fontSize ?? 0;
  });
/** Select the first occurrence of `needle` in the buffer without disturbing the focus. */
const selectInTerminal = async (page: Page, needle: string): Promise<void> => {
  await page.evaluate((text) => {
    const element = document.querySelector(".terminal-screen") as (HTMLElement & { corviTerminal?: BrowserTerminal }) | null;
    const term = element?.corviTerminal;
    if (!term) return;
    const buffer = term.buffer.active;
    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y)?.translateToString(true) ?? "";
      const at = line.indexOf(text);
      if (at !== -1) {
        term.select(at, y, text.length);
        term.focus();
        return;
      }
    }
  }, needle);
};

/** Type one command and wait for its output to appear on the screen (not merely be echoed). */
const typeUntilText = async (page: Page, command: string, needle: string): Promise<void> => {
  await awaitAttached(page);
  await page.keyboard.type(`${command}\n`);
  const shown = await until(async () => (await terminalText(page)).includes(needle), true, budget(30_000));
  if (!shown) {
    throw new Error(`the terminal never showed ${needle} (tail ${JSON.stringify((await terminalText(page)).slice(-200))})`);
  }
};

/** Type one command and wait for its output. The attach gate makes a lost keystroke a bug rather
 * than a retry, so a command whose effect cannot be repeated (a large stream) is safe here. */
const typeOnceUntil = async (page: Page, command: string, needle: string, ms = 2000): Promise<void> => {
  await awaitAttached(page);
  await page.keyboard.type(`${command}\n`);
  await until(async () => (await terminalText(page)).includes(needle), true, budget(ms));
};

/** Put `text` on the system clipboard and paste it with the page's own chord (Ctrl+Shift+V), the
 * path a person takes, without depending on the browser's real clipboard. */
const pasteText = async (page: Page, text: string): Promise<void> => {
  await page.evaluate((clip: string) => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => undefined, readText: async () => clip },
    });
  }, text);
  await page.keyboard.press("Control+Shift+V");
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
let browser: Browser;
let url: string;
let server: ReturnType<typeof Bun.spawn>;
const id = "PROJ-TERM";
const second = "PROJ-TERM-2";

const startServer = async (port = 0): Promise<void> => {
  server = Bun.spawn(["node", "apps/server/src/server.ts", `--corvi-test-run=${testRun()}`], {
    env: serverEnv(tmp, { CORVI_PORT: String(port) }),
    stdout: "pipe",
    stderr: process.env.CORVI_TEST_LOUD ? "inherit" : "ignore",
  });
  url = await waitForUrl(server);
};

beforeAll(async () => {
  if (!usable) return;
  tmp = await testTempDir("term");
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
  await awaitAttached(page);
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
  const before = join(dir, "survived-before.txt");
  // Prove the shell has the variable before anything restarts: the export and the read are the
  // same command, so the file cannot say "yes" unless the shell really exported it.
  await runCommand(
    page,
    `export CORVI_SURVIVED=yes; echo "$CORVI_SURVIVED" > ${before}`,
    before,
    "yes\n",
  );
  expect(await fileText(before)).toBe("yes\n");
  // A marker followed by more than the host ring's 256 KiB: by the time the snapshot is taken the
  // ring has evicted the marker, so whatever brings it back after the restart can only be the
  // persisted renderer snapshot (loaded on start since 5c3f8a6), not the ring's replay.
  await typeOnceUntil(page, "echo SRV-DEEP-MARKER", "SRV-DEEP-MARKER", 15_000);
  await typeOnceUntil(page, "head -c 280000 /dev/zero | tr '\\0' X; echo SRV-FILLER-DONE", "SRV-FILLER-DONE", 60_000);
  expect(await terminalText(page)).toContain("SRV-DEEP-MARKER");
  // Wait for the output to settle — the idle snapshot fires then, with no write outstanding —
  // rather than a guessed sleep a busy machine turns into a missing snapshot. A snapshot older
  // than the ring would attach into a truncated replay whose reset clears the very marker this
  // test is about.
  await until(async () => {
    const settled = await terminalText(page);
    await Bun.sleep(1500);
    return (await terminalText(page)) === settled;
  }, true, budget(60_000));
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await Bun.sleep(300);

  server.kill();
  await server.exited;
  await startServer();

  // A fresh page on the restarted server: the deep marker proves the persisted snapshot was
  // replayed, and the exported variable proves the same shell is underneath it.
  const again = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await again.goto(`${url}/changes/${id}/terminals`);
  await again.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await again.locator(".terminal-screen").click();
  // Assert the read that satisfied the wait, rather than a second read that could race a late
  // reset: the scrollback really is back.
  let restored = "";
  await until(async () => {
    restored = await terminalText(again);
    return restored.includes("SRV-DEEP-MARKER");
  }, true, budget(30_000));
  expect(restored).toContain("SRV-DEEP-MARKER");
  await runCommand(again, `echo "$CORVI_SURVIVED" > ${join(dir, "survived.txt")}`, join(dir, "survived.txt"), "yes\n");
  expect(await fileText(join(dir, "survived.txt"))).toBe("yes\n");
  await again.close();
  await page.close();
}, budget(180_000));

test.skipIf(!usable)("the page reconnects to a restarted server without a reload", async () => {
  const { page, dir } = await openTerminal(id);
  await runCommand(page, `echo ONE > ${join(dir, "reconnect-1.txt")}`, join(dir, "reconnect-1.txt"), "ONE\n");

  // Restart on the same port: the page's URL (and so its WebSocket host) is unchanged, which is
  // what a real relaunch on a fixed port looks like in development.
  const port = Number(new URL(url).port);
  server.kill();
  await server.exited;
  await startServer(port);

  // The same page, no reload: the bounded-backoff reconnect brings the socket back itself.
  await runCommand(page, `echo TWO > ${join(dir, "reconnect-2.txt")}`, join(dir, "reconnect-2.txt"), "TWO\n");
  await page.close();
}, budget(120_000));

test.skipIf(!usable)("the window strip is the server's registry: a new tab is its own shell", async () => {
  const { page, dir } = await openTerminal(id);
  const tabs = page.locator(".window-tab:not(.new):not(.overview)");
  await tabs.first().waitFor({ timeout: 15_000 });
  expect(await tabs.count()).toBe(1);

  // A marker in the first window's shell. The checked file holds the variable's own value, so it
  // can only pass once the export ran.
  await runCommand(page, `export TAB_MARK=one; echo "$TAB_MARK" > ${join(dir, "tab-set.txt")}`, join(dir, "tab-set.txt"), "one\n");

  await page.locator(".window-tab.new").click();
  expect(await until(() => tabs.count(), 2)).toBe(2);

  // The navigation column lists the registry's windows too.
  const entries = page.locator(".sidebar .entry.window");
  expect(await until(() => entries.count(), 2)).toBe(2);

  // The new window is active and is its own pty: a fresh shell without the first one's marker.
  await runCommand(page, `echo "\${TAB_MARK:-none}" > ${join(dir, "new-tab.txt")}`, join(dir, "new-tab.txt"), "none\n");

  // Selecting the first tab attaches back to its own shell, marker intact. Both tabs share a label
  // (two shells in the change directory), so the index is what says the switch landed; the pane's
  // own attach follows it, and `runCommand` waits for that before typing.
  await tabs.first().click();
  expect(await until(() => page.locator(".window-tab.current").getAttribute("data-window-index"), "0", budget(20_000))).toBe("0");
  await runCommand(page, `echo "\${TAB_MARK:-none}" > ${join(dir, "first-tab.txt")}`, join(dir, "first-tab.txt"), "one\n");
  await page.close();
}, budget(90_000));

test.skipIf(!usable)("every window's pty is the size the page shows", async () => {
  const { page, dir } = await openTerminal(id);
  const tabs = page.locator(".window-tab:not(.new):not(.overview)");
  await tabs.first().waitFor({ timeout: 15_000 });

  // (a) the change's first window: its shell starts at the page's grid (the subagent's window is
  // pinned in test/terminalAcceptance.test.ts).
  const firstFile = join(dir, "size-first.txt");
  let firstReported = "";
  for (let attempt = 0; attempt < 40 && !/^\d+ \d+$/.test(firstReported); attempt++) {
    await page.keyboard.type(`stty size > ${firstFile}\n`);
    await Bun.sleep(200);
    firstReported = (await fileText(firstFile)).trim();
  }
  expect(firstReported).toMatch(/^\d+ \d+$/);
  const [firstRows = 0, firstCols = 0] = firstReported.split(/\s+/).map(Number);
  expect(await terminalSize(page)).toEqual({ cols: firstCols, rows: firstRows });

  // Mark the first window's shell so the new one is provably a different pty; a window created
  // before a page attached (a new tab, a subagent window) opens at a default size, and attaching
  // must resize the pty to the page's grid or wrapping and backspace break.
  await runCommand(page, `export GEO_MARK=old; echo "$GEO_MARK" > ${join(dir, "geo-set.txt")}`, join(dir, "geo-set.txt"), "old\n");
  await page.locator(".window-tab.new").click();
  expect(await until(() => tabs.count(), 2)).toBe(2);

  // Retry until the command reaches the NEW shell (the marker is absent) and it writes its tty
  // size; the old shell writes nothing, so a stray early keystroke cannot satisfy the check.
  const file = join(dir, "size.txt");
  let reported = "";
  for (let attempt = 0; attempt < 40 && !/^\d+ \d+$/.test(reported); attempt++) {
    await page.keyboard.type(`[ -z "$GEO_MARK" ] && stty size > ${file} || true\n`);
    await Bun.sleep(200);
    reported = (await fileText(file)).trim();
  }
  expect(reported).toMatch(/^\d+ \d+$/);
  const [rows = 0, cols = 0] = reported.split(/\s+/).map(Number);
  expect(await terminalSize(page)).toEqual({ cols, rows });
  await page.close();
}, budget(90_000));

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
  const exported = join(dir, "keep-exported.txt");
  // The checked file holds the variable's value, so a half-delivered retry cannot pass without the
  // export having run.
  await runCommand(page, `export CORVI_KEEP=yes; echo "$CORVI_KEEP" > ${exported}`, exported, "yes\n");
  await page.close();

  const again = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await again.goto(`${url}/changes/${id}/terminals`);
  await again.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await again.locator(".terminal-screen").click();
  await runCommand(again, `echo "$CORVI_KEEP" > ${join(dir, "keep.txt")}`, join(dir, "keep.txt"), "yes\n");
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

test.skipIf(!usable)("xterm owns the screen: scrollback survives a snapshot and a reload", async () => {
  const { page } = await openTerminal(id);
  await typeUntilText(page, "seq 1 400 | sed 's/^/ROW-/'", "ROW-400");
  const before = await terminalLength(page);
  expect(before).toBeGreaterThan(100);

  // Force the snapshot now instead of waiting out the periodic cadence, then reload: the server
  // replays the stored screen into the fresh page.
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await Bun.sleep(400);
  await page.reload();
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await until(async () => (await terminalText(page)).includes("ROW-400"), true, budget(20_000));
  const restored = await terminalText(page);
  expect(restored).toContain("ROW-400");
  expect(restored).not.toContain("ROW-401");
  // Restored, not doubled: a resume replays only from the snapshot's offset.
  const after = await terminalLength(page);
  expect(after).toBeGreaterThan(100);
  expect(after).toBeLessThan(before + 50);
  await page.close();
}, budget(90_000));

test.skipIf(!usable)("the page draws the terminal menu, and find selects a match", async () => {
  const { page } = await openTerminal(id);
  await typeUntilText(page, "echo https://example.com/marker", "example.com");

  const screen = page.locator(".terminal-screen");
  const box = await screen.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + 40, box!.y + 40, { button: "right" });
  const menu = page.locator(".terminal-menu");
  await menu.waitFor({ timeout: 10_000 });
  const items = await menu.locator("button").allInnerTexts();
  expect(items).toEqual(["Copy", "Paste", "Select all", "Clear", "Find", "Open link"]);

  await menu.locator("button", { hasText: "Find" }).click();
  const find = page.locator(".terminal-find input");
  await find.waitFor({ timeout: 5_000 });
  await find.fill("example.com");
  await find.press("Enter");
  await until(async () => (await terminalSelection(page)).includes("example.com"), true, budget(10_000));
  await find.press("Escape");
  await until(() => page.locator(".terminal-find").count(), 0, budget(5_000));
  await page.close();
}, budget(60_000));

test.skipIf(!usable)("the menu's Open link opens the selected URL", async () => {
  const { page } = await openTerminal(id);
  await typeUntilText(page, "echo https://example.com/open-me", "open-me");
  // Select the URL in the buffer, then ask the page's menu to open it. A dispatched contextmenu
  // (rather than a right click) keeps the selection intact.
  await page.evaluate(() => {
    const element = document.querySelector(".terminal-screen") as (HTMLElement & { corviTerminal?: BrowserTerminal }) | null;
    const term = element?.corviTerminal;
    if (!term) return;
    const buffer = term.buffer.active;
    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y)?.translateToString(true) ?? "";
      const at = line.indexOf("https://example.com/open-me");
      if (at !== -1) {
        term.select(at, y, "https://example.com/open-me".length);
        return;
      }
    }
  });
  await page.evaluate(() => {
    (window as unknown as { __opened: string[] }).__opened = [];
    (window as unknown as { open: (url: string) => null }).open = (url: string) => {
      (window as unknown as { __opened: string[] }).__opened.push(url);
      return null;
    };
  });
  await page.evaluate(() => {
    document.querySelector(".terminal-screen")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }));
  });
  await page.locator(".terminal-menu").waitFor({ timeout: 10_000 });
  await page.locator(".terminal-menu button", { hasText: "Open link" }).click();
  await until(async () => (await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened))[0], "https://example.com/open-me", budget(10_000));
  await page.close();
}, budget(60_000));

test.skipIf(!usable)("the context-menu setting also silences the terminal's own menu", async () => {
  const current = (await fetch(`${url}/api/settings`).then((response) => response.json())) as { file: Record<string, unknown> };
  const write = (contextMenu: boolean): Promise<Response> =>
    fetch(`${url}/api/settings`, { method: "PUT", body: JSON.stringify({ ...current.file, contextMenu }) });
  try {
    await write(false);
    const { page } = await openTerminal(id);
    const box = await page.locator(".terminal-screen").boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + 40, box!.y + 40, { button: "right" });
    await Bun.sleep(300);
    // The terminal's menu is the page's, and the page swallows the click before the handler runs.
    expect(await page.locator(".terminal-menu").count()).toBe(0);
    await page.close();
  } finally {
    await write(true);
  }
}, budget(60_000));

test.skipIf(!usable)("the copy and paste chords go through the system clipboard", async () => {
  const { page } = await openTerminal(id);
  await typeUntilText(page, "echo CLIP_MARKER", "CLIP_MARKER");
  await page.evaluate(() => {
    const clip = { copied: "", pasted: "PASTED_FROM_CLIP" };
    (window as unknown as { __clip: typeof clip }).__clip = clip;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          clip.copied = text;
        },
        readText: async () => clip.pasted,
      },
    });
  });
  // Select, then copy with the page's chord (the shell keeps Ctrl+C).
  await selectInTerminal(page, "CLIP_MARKER");
  await page.keyboard.press("Control+Shift+C");
  await until(
    async () => await page.evaluate(() => (window as unknown as { __clip: { copied: string } }).__clip.copied),
    "CLIP_MARKER",
    budget(10_000),
  );
  // The platform's command key copies too (Cmd on macOS, Super on Linux).
  await page.evaluate(() => {
    (window as unknown as { __clip: { copied: string } }).__clip.copied = "";
  });
  await page.keyboard.press("Meta+C");
  await until(
    async () => await page.evaluate(() => (window as unknown as { __clip: { copied: string } }).__clip.copied),
    "CLIP_MARKER",
    budget(10_000),
  );
  // Paste with the page's chord: the shell echoes it back onto the screen.
  await page.keyboard.press("Control+Shift+V");
  await until(async () => (await terminalText(page)).includes("PASTED_FROM_CLIP"), true, budget(10_000));
  // And the command key pastes too.
  await page.evaluate(() => {
    (window as unknown as { __clip: { pasted: string } }).__clip.pasted = "META_PASTE";
  });
  await page.keyboard.press("Meta+V");
  await until(async () => (await terminalText(page)).includes("META_PASTE"), true, budget(10_000));
  // The Linux terminal convention — what a compositor's universal clipboard sends a window it
  // treats as a terminal: Ctrl+Insert copies, Shift+Insert pastes.
  await selectInTerminal(page, "CLIP_MARKER");
  await page.evaluate(() => {
    (window as unknown as { __clip: { copied: string } }).__clip.copied = "";
  });
  await page.keyboard.press("Control+Insert");
  await until(
    async () => await page.evaluate(() => (window as unknown as { __clip: { copied: string } }).__clip.copied),
    "CLIP_MARKER",
    budget(10_000),
  );
  await page.evaluate(() => {
    (window as unknown as { __clip: { pasted: string } }).__clip.pasted = "INSERT_PASTE";
  });
  await page.keyboard.press("Shift+Insert");
  await until(async () => (await terminalText(page)).includes("INSERT_PASTE"), true, budget(10_000));
  await page.close();
}, budget(60_000));

test.skipIf(!usable)("middle-click pastes the system clipboard", async () => {
  const { page } = await openTerminal(id);
  await typeUntilText(page, "echo MID_MARKER", "MID_MARKER");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => undefined, readText: async () => "MIDDLE_PASTE" },
    });
  });
  const box = await page.locator(".terminal-screen").boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + 40, box!.y + 40, { button: "middle" });
  await until(async () => (await terminalText(page)).includes("MIDDLE_PASTE"), true, budget(10_000));
  await page.close();
}, budget(60_000));

test.skipIf(!usable)("a multi-line paste is inserted, not executed", async () => {
  const { page, dir } = await openTerminal(id);
  await typeUntilText(page, "echo PASTE-READY", "PASTE-READY");
  const one = join(dir, "paste-one.txt");
  const two = join(dir, "paste-two.txt");
  await pasteText(page, "touch paste-one.txt\ntouch paste-two.txt\n");
  // Both lines sit in the shell's edit buffer — a bracketed paste — so nothing has run yet.
  expect(await until(async () => (await terminalText(page)).includes("paste-two.txt"), true, budget(10_000))).toBe(true);
  await Bun.sleep(500);
  expect(await Bun.file(one).exists()).toBe(false);
  expect(await Bun.file(two).exists()).toBe(false);
  // Submitting runs both.
  await page.keyboard.press("Enter");
  await until(async () => (await Bun.file(one).exists()) && (await Bun.file(two).exists()), true, budget(10_000));
  expect(await Bun.file(one).exists()).toBe(true);
  expect(await Bun.file(two).exists()).toBe(true);
  await page.close();
}, budget(60_000));

test.skipIf(!usable)("a multi-line paste is still inserted after a reload", async () => {
  const { page, dir } = await openTerminal(id);
  await typeUntilText(page, "echo PASTE-RELOAD-READY", "PASTE-RELOAD-READY");
  // Store a snapshot and come back to it: the restored screen must still carry bracketed paste,
  // or the paste that follows would submit every line.
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await Bun.sleep(400);
  await page.reload();
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await page.locator(".terminal-screen").click();
  await typeUntilText(page, "echo PASTE-AFTER-RELOAD", "PASTE-AFTER-RELOAD");
  const one = join(dir, "paste-reload-one.txt");
  const two = join(dir, "paste-reload-two.txt");
  await pasteText(page, "touch paste-reload-one.txt\ntouch paste-reload-two.txt\n");
  expect(await until(async () => (await terminalText(page)).includes("paste-reload-two.txt"), true, budget(10_000))).toBe(true);
  await Bun.sleep(500);
  expect(await Bun.file(one).exists()).toBe(false);
  expect(await Bun.file(two).exists()).toBe(false);
  await page.keyboard.press("Enter");
  await until(async () => (await Bun.file(one).exists()) && (await Bun.file(two).exists()), true, budget(10_000));
  await page.close();
}, budget(90_000));

test.skipIf(!usable)("the cursor is a visible block, and a program that hid it does not keep it hidden", async () => {
  const { page } = await openTerminal(id);
  // Ready first: the attach's control frame shows the cursor, and a late one would undo the hide
  // this test sets up next.
  await typeUntilText(page, "echo CURSOR-READY", "CURSOR-READY");
  const options = await page.evaluate(() => {
    const term = (document.querySelector(".terminal-screen") as (HTMLElement & { corviTerminal?: BrowserTerminal }) | null)?.corviTerminal;
    return {
      style: term?.options.cursorStyle,
      inactive: term?.options.cursorInactiveStyle,
      blink: term?.options.cursorBlink,
      cursor: term?.options.theme?.cursor,
      background: term?.options.theme?.background,
    };
  });
  // A filled block in both focus states, blinking, in a colour that contrasts with the surface.
  expect(options.style).toBe("block");
  expect(options.inactive).toBe("block");
  expect(options.blink).toBe(true);
  expect(options.cursor).toBeTruthy();
  expect(options.cursor?.toLowerCase()).not.toBe("none");
  expect(options.cursor?.toLowerCase()).not.toBe(options.background?.toLowerCase());

  // A full-screen program hides the cursor (DECTCEM). The pane must show it again when the next
  // screen is replaid, or a plain shell after it would have no cursor at all. DECTCEM has no
  // public xterm API, so the probe reads xterm's own hidden flag — and pins that the path exists:
  // if a later xterm moves it, this says so instead of passing vacuously.
  const cursorHidden = async (): Promise<boolean> => {
    const hidden = await page.evaluate(() => {
      type Internals = { _core?: { coreService?: { isCursorHidden?: boolean } } };
      const term = (document.querySelector(".terminal-screen") as (HTMLElement & { corviTerminal?: BrowserTerminal & Internals }) | null)?.corviTerminal;
      return term?._core?.coreService?.isCursorHidden;
    });
    expect(typeof hidden).toBe("boolean");
    return hidden as boolean;
  };
  await page.evaluate(() => {
    const term = (document.querySelector(".terminal-screen") as (HTMLElement & { corviTerminal?: BrowserTerminal }) | null)?.corviTerminal;
    term?.write("\u001b[?25l");
  });
  expect(await until(async () => (await cursorHidden()) === true, true, budget(10_000))).toBe(true);

  // A new window and back: each attach replays through the pane's erase, which shows the cursor.
  const tabs = page.locator(".window-tab:not(.new):not(.overview)");
  const before = await tabs.count();
  await page.locator(".window-tab.new").click();
  expect(await until(() => tabs.count(), before + 1)).toBe(before + 1);
  await tabs.first().click();
  expect(await until(async () => (await cursorHidden()) === false, true, budget(20_000))).toBe(true);
  await page.close();
}, budget(60_000));

test.skipIf(!usable)("the font-size chords change and reset the terminal", async () => {
  const { page } = await openTerminal(id);
  expect(await terminalFontSize(page)).toBe(13);
  await page.locator(".terminal-screen").click();
  await page.keyboard.press("Control+Minus");
  await until(() => terminalFontSize(page), 12, budget(5_000));
  await page.keyboard.press("Control+Equal");
  await until(() => terminalFontSize(page), 13, budget(5_000));
  await page.keyboard.press("Control+Minus");
  await page.keyboard.press("Control+Minus");
  await page.keyboard.press("Control+Digit0");
  await until(() => terminalFontSize(page), 13, budget(5_000));
  await page.close();
}, budget(60_000));

test.skipIf(!usable)("hiding the tab snapshots the screen immediately", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  // Record the control frames the page sends, and neutralise both snapshot timers so the hide is
  // the only thing that can produce a snapshot in the window the test checks: a visible pane
  // snapshots on the output-idle timeout, a hidden one on the periodic interval. That isolates the
  // visibilitychange path from the cadence (which the reload test already covers).
  await page.addInitScript(
    ({ idleMs, intervalMs }) => {
      const snapshots: unknown[] = [];
      (window as unknown as { __snapshots: unknown[] }).__snapshots = snapshots;
      const originalSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function (this: WebSocket, data: Parameters<WebSocket["send"]>[0]): void {
        if (typeof data === "string") {
          try {
            const value = JSON.parse(data) as { type?: string };
            if (value.type === "snapshot") snapshots.push(value);
          } catch {
            // not a control frame
          }
        }
        originalSend.call(this, data);
      };
      const originalSetTimeout = window.setTimeout.bind(window);
      window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]): number => {
        if (timeout === idleMs) return 0;
        return originalSetTimeout(handler, timeout, ...args);
      }) as typeof window.setTimeout;
      const originalSetInterval = window.setInterval.bind(window);
      window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]): number => {
        if (timeout === intervalMs) return 0;
        return originalSetInterval(handler, timeout, ...args);
      }) as typeof window.setInterval;
    },
    { idleMs: SNAPSHOT_IDLE_MS, intervalMs: SNAPSHOT_INTERVAL_MS },
  );
  await page.goto(`${url}/changes/${id}/terminals`);
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await page.locator(".terminal-screen").click();
  // The pane connects once before the window list arrives and reconnects — snapshotting the empty
  // screen — when the change's active window becomes known. That connect is not this test's
  // subject; the window it watches starts once the window is on screen.
  await page.locator(".window-tab:not(.new):not(.overview)").first().waitFor({ timeout: 15_000 });
  await page.evaluate(() => {
    (window as unknown as { __snapshots: unknown[] }).__snapshots.length = 0;
  });
  await typeUntilText(page, "echo HIDE_MARKER", "HIDE_MARKER");
  expect(await page.evaluate(() => (window as unknown as { __snapshots: unknown[] }).__snapshots.length)).toBe(0);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const count = await until(
    async () => await page.evaluate(() => (window as unknown as { __snapshots: unknown[] }).__snapshots.length),
    1,
    budget(10_000),
  );
  expect(count).toBe(1);
  await page.close();
}, budget(60_000));
