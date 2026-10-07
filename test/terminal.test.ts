import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { budget, checkoutsOf, closePages, requireFreshWebBundle, runSh, serverEnv, testRun, testTempDir, until, waitFor, waitForUrl } from "./helpers.ts";
import { csiuFor } from "@corvi/terminals/model";
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
  getSelectionPosition(): { start: { x: number; y: number }; end: { x: number; y: number } } | undefined;
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
/** The grid's geometry and the vertical overlay scrollbar, for the full-width fit: how much of the
 * host the grid uses, and whether the scrollbar sits over the grid rather than in a reserved strip. */
type TerminalLayout = {
  readonly cols: number;
  readonly cellWidth: number;
  readonly contentWidth: number;
  readonly gridWidth: number;
  readonly gridRight: number;
  readonly hostRight: number;
  readonly scrollbar: {
    readonly classes: string;
    readonly position: string;
    readonly pointerEvents: string;
    readonly left: number;
    readonly right: number;
  } | null;
};
const terminalLayout = (page: Page): Promise<TerminalLayout | null> =>
  page.evaluate(() => {
    type Internals = {
      cols?: number;
      element?: HTMLElement;
      _core?: {
        screenElement?: HTMLElement;
        _renderService?: { dimensions?: { css?: { cell?: { width?: number } } } };
      };
    };
    const term = (document.querySelector(".terminal-screen") as (HTMLElement & { corviTerminal?: Internals }) | null)?.corviTerminal;
    const element = term?.element;
    const host = element?.parentElement;
    const grid = term?._core?.screenElement;
    if (!term || !element || !host || !grid) return null;
    const hostStyle = getComputedStyle(host);
    const elementStyle = getComputedStyle(element);
    const paddingWidth = (parseFloat(elementStyle.paddingLeft) || 0) + (parseFloat(elementStyle.paddingRight) || 0);
    const cellWidth = term._core?._renderService?.dimensions?.css?.cell?.width ?? 0;
    const hostRect = host.getBoundingClientRect();
    const gridRect = grid.getBoundingClientRect();
    const bar = document.querySelector(".terminal-screen .xterm-scrollable-element > .scrollbar.vertical") as HTMLElement | null;
    const barStyle = bar ? getComputedStyle(bar) : null;
    const barRect = bar?.getBoundingClientRect();
    return {
      cols: term.cols ?? 0,
      cellWidth,
      contentWidth: (parseFloat(hostStyle.width) || 0) - paddingWidth,
      gridWidth: gridRect.width,
      gridRight: gridRect.right,
      hostRight: hostRect.right,
      scrollbar:
        bar && barStyle && barRect
          ? {
              classes: bar.className,
              position: barStyle.position,
              pointerEvents: barStyle.pointerEvents,
              left: barRect.left,
              right: barRect.right,
            }
          : null,
    };
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
/** The raw-mode probe a mouse test types into a shell. */
const mouseProbe = fileURLToPath(new URL("./fixtures/mouse-probe.mjs", import.meta.url));
/** `<tracking>:<encoding>` from the page's xterm. SGR (or SGR_PIXELS) reports travel through
 * `onData`; DEFAULT is the legacy binary path the pane forwards from `onBinary`. `mouseTrackingMode`
 * is public; `activeEncoding` is the private field the server's snapshot fix re-asserts. */
const mouseState = (page: Page): Promise<string> =>
  page.evaluate(() => {
    type Internals = {
      modes?: { mouseTrackingMode?: string };
      _core?: { coreMouseService?: { activeEncoding?: string } };
    };
    const element = document.querySelector(".terminal-screen") as (HTMLElement & { corviTerminal?: Internals }) | null;
    const term = element?.corviTerminal;
    return `${term?.modes?.mouseTrackingMode ?? "none"}:${term?._core?.coreMouseService?.activeEncoding ?? "DEFAULT"}`;
  });
/** The viewport point at the right edge of the rendered grid, once the fit has settled (the grid
 * width matches the terminal's own column count). Wheeling there lands on the last column, whose
 * X10 byte is `32 + col >= 0x80` on any grid wider than 96 columns; a stale or not-yet-fitted grid
 * would put the wheel somewhere else. */
const pointAtGridRight = (page: Page): Promise<{ x: number; y: number } | null> =>
  page.evaluate(() => {
    type Internals = {
      cols?: number;
      _core?: {
        screenElement?: HTMLElement;
        _renderService?: { dimensions?: { css?: { cell?: { width?: number } } } };
      };
    };
    const term = (document.querySelector(".terminal-screen") as (HTMLElement & { corviTerminal?: Internals }) | null)?.corviTerminal;
    const rect = term?._core?.screenElement?.getBoundingClientRect();
    const cellWidth = term?._core?._renderService?.dimensions?.css?.cell?.width;
    if (term?.cols === undefined || rect === undefined || cellWidth === undefined || rect.width === 0) return null;
    if (Math.abs(rect.width - term.cols * cellWidth) > 1) return null; // the fit has not settled
    return { x: rect.left + rect.width - 1, y: rect.top + rect.height / 2 };
  });
/** The viewport point of the first cell of `needle` in the buffer, or null when it is not on screen.
 * The linkifier maps a mousemove to a buffer cell, so hovering that point is what shows a link.
 * The string index is treated as a column (`indexOf`), so this assumes no wide characters before
 * the match — true for the ASCII URLs the tests use. */
const hoverPointFor = (page: Page, needle: string): Promise<{ x: number; y: number } | null> =>
  page.evaluate((text: string) => {
    type Internals = {
      rows?: number;
      buffer?: {
        active: {
          length: number;
          baseY: number;
          getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined;
        };
      };
      _core?: {
        screenElement?: HTMLElement;
        _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } };
      };
    };
    const term = (document.querySelector(".terminal-screen") as (HTMLElement & { corviTerminal?: Internals }) | null)?.corviTerminal;
    const grid = term?._core?.screenElement;
    const cell = term?._core?._renderService?.dimensions?.css?.cell;
    if (!term?.buffer || !grid || !cell || cell.width === undefined || cell.height === undefined) return null;
    const buffer = term.buffer.active;
    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y)?.translateToString(true) ?? "";
      const at = line.indexOf(text);
      if (at === -1) continue;
      const row = y - buffer.baseY;
      if (row < 0 || (term.rows !== undefined && row >= term.rows)) continue; // off the viewport
      const rect = grid.getBoundingClientRect();
      return { x: rect.left + (at + 0.5) * cell.width, y: rect.top + (row + 0.5) * cell.height };
    }
    return null;
  }, needle);
/** Wait until the shell's next prompt has enabled bracketed paste. A command that just finished has
 * printed its output but not necessarily redrawn the prompt's DEC mode yet; pasting before that
 * would send the text unbracketed and the shell would run it. */
const awaitBracketedPaste = (page: Page): Promise<void> =>
  waitFor(
    "bracketed paste",
    () =>
      page.evaluate(() => {
        type Internals = { modes?: { bracketedPasteMode?: boolean } };
        const term = (document.querySelector(".terminal-screen") as (HTMLElement & { corviTerminal?: Internals }) | null)?.corviTerminal;
        return term?.modes?.bracketedPasteMode === true;
      }),
    budget(10_000),
  );
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
const live = "PROJ-LIVE";
/** Its own change, so the rapid-switch test's extra window does not shift the shared change's tab
 * counts that later tests assume. */
const rapid = "PROJ-RAPID";
/** Its own change, so the ended-shell test's exit does not remove a window another test expects. */
const exits = "PROJ-EXIT";

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
  const repo3 = join(tmp, "repo3");
  await runSh(["git", "init", "-b", "main", repo3]);
  await fetch(`${url}/api/changes`, { method: "POST", body: JSON.stringify({ id: live, checkouts: checkoutsOf([repo3]) }) });
  const repo4 = join(tmp, "repo4");
  await runSh(["git", "init", "-b", "main", repo4]);
  await fetch(`${url}/api/changes`, { method: "POST", body: JSON.stringify({ id: rapid, checkouts: checkoutsOf([repo4]) }) });
  const repo5 = join(tmp, "repo5");
  await runSh(["git", "init", "-b", "main", repo5]);
  await fetch(`${url}/api/changes`, { method: "POST", body: JSON.stringify({ id: exits, checkouts: checkoutsOf([repo5]) }) });
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

test.skipIf(!usable)("a refused named-pane upgrade does not take the server down", async () => {
  // A raw upgrade naming a pane that is gone: the route answers a refusal, the client resets before
  // that answer is written, and the server must keep serving. Without the raw-socket error handling
  // the Node server dies on the reset (ECONNRESET) and the request below never answers.
  const port = Number(new URL(url).port);
  const path = `/api/changes/${id}/terminal/socket?cols=80&rows=24&session=w-gone-pane`;
  const socket = connect(port, "127.0.0.1", () => {
    socket.write(
      [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "",
        "",
      ].join("\r\n"),
    );
  });
  socket.on("error", () => undefined);
  await Bun.sleep(250);
  socket.resetAndDestroy();
  await Bun.sleep(250);

  const response = await fetch(`${url}/api/workspaces`);
  expect(response.ok).toBe(true);
}, budget(30_000));

test.skipIf(!usable)("the terminal tab runs a shell in the change directory", async () => {
  const { page, dir } = await openTerminal(id);
  await runCommand(page, "pwd > out.txt", join(dir, "out.txt"), `${dir}\n`);
  expect(await fileText(join(dir, "out.txt"))).toBe(`${dir}\n`);
  await page.close();
}, budget(90_000));

test.skipIf(!usable)("a terminal outlives the server that started it, deep scrollback and all", async () => {
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
  // A marker followed by more than the host ring's 256 KiB: by the time the server is killed the
  // ring has evicted the marker, so only the screen the server persisted can bring it back.
  await typeOnceUntil(page, "echo SRV-DEEP-MARKER", "SRV-DEEP-MARKER", 15_000);
  await typeOnceUntil(page, "head -c 320000 /dev/zero | tr '\\0' X; echo SRV-FILLER-DONE", "SRV-FILLER-DONE", 60_000);
  expect(await terminalText(page)).toContain("SRV-DEEP-MARKER");

  server.kill();
  await server.exited;
  await startServer();

  // A fresh page on the restarted server: the deep marker proves the persisted screen was seeded,
  // and the exported variable proves the same shell is underneath it.
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

  // The tab strip and the column name the same window as current: the highlight agrees with the
  // window the server made active, and the command below proves the input follows it.
  const currentTabId = await page.locator(".window-tab.current").getAttribute("data-window-id");
  const currentSidebarId = await page
    .locator(".sidebar .entry.sub.window.current")
    .getAttribute("data-window-id");
  expect(currentTabId).toBeTruthy();
  expect(currentSidebarId).toBe(currentTabId);

  // The new window is active and is its own pty: a fresh shell without the first one's marker.
  await runCommand(page, `echo "\${TAB_MARK:-none}" > ${join(dir, "new-tab.txt")}`, join(dir, "new-tab.txt"), "none\n");

  // Selecting the first tab attaches back to its own shell, marker intact. Both tabs share a label
  // (two shells in the change directory), so the index is what says the switch landed; the pane's
  // own attach follows it, and `runCommand` waits for that before typing.
  await tabs.first().click();
  expect(await until(() => page.locator(".window-tab.current").getAttribute("data-window-index"), "0", budget(20_000))).toBe("0");
  // The column followed the switch to the same window the tab names.
  expect(await page.locator(".sidebar .entry.sub.window.current").getAttribute("data-window-id")).toBe(
    await page.locator(".window-tab.current").getAttribute("data-window-id"),
  );
  await runCommand(page, `echo "\${TAB_MARK:-none}" > ${join(dir, "first-tab.txt")}`, join(dir, "first-tab.txt"), "one\n");
  await page.close();
}, budget(90_000));

test.skipIf(!usable)("rapid window switching keeps the screen the tab names", async () => {
  const { page } = await openTerminal(rapid);
  const tabs = page.locator(".window-tab:not(.new):not(.overview)");
  await tabs.first().waitFor({ timeout: 15_000 });

  // One marker per window's shell, so the rendered buffer says which screen the pane holds.
  await typeUntilText(page, "echo RAPID_A_MARK", "RAPID_A_MARK");
  await page.locator(".window-tab.new").click();
  expect(await until(() => tabs.count(), 2)).toBe(2);
  await typeUntilText(page, "echo RAPID_B_MARK", "RAPID_B_MARK");

  // A -> B -> A back to back: the second click lands as soon as it can, before B's screen has had
  // time to settle. Repeated, because the bug is about arrival order. (The guard itself is pinned
  // deterministically in test/socketTarget.test.ts.)
  for (let round = 0; round < 5; round++) {
    await tabs.nth(1).click();
    await tabs.nth(0).click();
    expect(
      await until(
        () => page.locator(".window-tab.current").getAttribute("data-window-index"),
        "0",
        budget(20_000),
      ),
    ).toBe("0");
    // A's screen came back, and B's is not in it.
    await until(async () => (await terminalText(page)).includes("RAPID_A_MARK"), true, budget(20_000));
    expect(await terminalText(page)).not.toContain("RAPID_B_MARK");
  }
  await page.close();
}, budget(120_000));

test.skipIf(!usable)("a delayed window list never claims the session is gone", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  // Hold the window list past the old five-second inference while the pane's own URL and socket
  // resolve: an empty list is not evidence that the shells are lost.
  let held = 0;
  await page.route("**/api/terminals", async (route) => {
    held += 1;
    await Bun.sleep(9000);
    await route.continue();
  });
  await page.goto(`${url}/changes/${id}/terminals`);
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await awaitAttached(page);
  // Past the old threshold, with the list still held: no destructive loss message.
  await Bun.sleep(6000);
  expect(await page.locator(".terminal-gone").count()).toBe(0);
  await awaitAttached(page);
  // The list arrives and the strip appears without a reload.
  await page.locator(".window-tab:not(.new):not(.overview)").first().waitFor({ timeout: 20_000 });
  expect(held).toBeGreaterThan(0);
  await page.close();
}, budget(120_000));

test.skipIf(!usable)("rapid selections settle on the last one when an earlier response is slow", async () => {
  const { page } = await openTerminal(rapid);
  const tabs = page.locator(".window-tab:not(.new):not(.overview)");
  await tabs.first().waitFor({ timeout: 15_000 });
  // The shared change may already carry windows from an earlier test in this file.
  if ((await tabs.count()) < 2) {
    await page.locator(".window-tab.new").click();
    await until(async () => (await tabs.count()) >= 2, true, budget(20_000));
  }

  // The first selection request is held; the second must still win. Conflicting operations are
  // serialized per change, so the page does not send the second until the first has answered.
  let posts = 0;
  await page.route("**/api/changes/*/terminal/windows", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts += 1;
    if (posts === 1) await Bun.sleep(1200);
    await route.continue();
  });

  await tabs.nth(0).click();
  await tabs.nth(1).click();
  await until(() => page.locator(".window-tab.current").getAttribute("data-window-index"), "1", budget(20_000));
  // Let the held response arrive: it belongs to the older selection and must not roll it back.
  await Bun.sleep(1500);
  expect(await page.locator(".window-tab.current").getAttribute("data-window-index")).toBe("1");
  expect(posts).toBeGreaterThanOrEqual(2);
  await page.close();
}, budget(120_000));

test.skipIf(!usable)("a failed selection is said, not silently dropped", async () => {
  const { page } = await openTerminal(rapid);
  const tabs = page.locator(".window-tab:not(.new):not(.overview)");
  await tabs.first().waitFor({ timeout: 15_000 });
  // The shared change may already carry windows from an earlier test in this file.
  if ((await tabs.count()) < 2) {
    await page.locator(".window-tab.new").click();
    await until(async () => (await tabs.count()) >= 2, true, budget(20_000));
  }

  // The next selection is refused by the server: the page must say so rather than leave the old
  // selection on screen as if the click had never happened.
  await page.route("**/api/changes/*/terminal/windows", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "the registry refused" }),
    });
  });
  await tabs.nth(0).click();
  await page.locator(".error-banner").waitFor({ timeout: budget(20_000) });
  expect(await page.locator(".error-banner").innerText()).toContain("the registry refused");
  await page.close();
}, budget(90_000));

test.skipIf(!usable)("exiting the shell says the session ended, not that the shell was lost", async () => {
  const { page } = await openTerminal(exits);
  await awaitAttached(page);
  await page.keyboard.type("exit\n");
  await page.locator(".terminal-gone").waitFor({ timeout: budget(20_000) });
  const text = ((await page.locator(".terminal-gone").textContent()) ?? "").replace(/\s+/g, " ").trim();
  // Purely factual and scoped: no claim that the whole change lost its shells, and no action
  // promise (a reload or a tab is transient here and must not be presented as the fix).
  expect(text).toBe("The shell in this terminal has ended. Other terminals in this change are unaffected.");
  expect(text).not.toContain("Reload");
  expect(text).not.toContain("shells in it");
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
  const tabsBefore = await tabs.count();
  await page.locator(".window-tab.new").click();
  // The change's windows accumulate across the tests in this file, so assert the delta, not 2.
  expect(await until(() => tabs.count(), tabsBefore + 1)).toBe(tabsBefore + 1);

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

test.skipIf(!usable)("the grid fills the host and the scrollbar overlays it, hidden until scrolled", async () => {
  const { page, dir } = await openTerminal(id);
  const tabs = page.locator(".window-tab:not(.new):not(.overview)");
  await tabs.first().waitFor({ timeout: 15_000 });
  // A fresh window: a new shell with no scrollback, so the overlay starts hidden.
  const before = await tabs.count();
  await page.locator(".window-tab.new").click();
  expect(await until(() => tabs.count(), before + 1)).toBe(before + 1);
  await until(() => page.locator(".window-tab.current").getAttribute("data-window-index"), String(before), budget(20_000));
  await awaitAttached(page);
  await waitFor(
    "the terminal grid to settle",
    async () => {
      const layout = await terminalLayout(page);
      return layout !== null && layout.cellWidth > 0 && Math.abs(layout.gridWidth - layout.cols * layout.cellWidth) <= 1;
    },
    budget(10_000),
  );

  const layout = await terminalLayout(page);
  expect(layout).not.toBeNull();
  // The grid fills the host's content width: the leftover is under one cell. Before this fit, the
  // scrollbar strip (~14px) was reserved, so the leftover was the strip plus the remainder.
  expect(layout!.cols * layout!.cellWidth).toBeLessThanOrEqual(layout!.contentWidth);
  // Measure the leftover on the rendered rects, not by re-deriving the fit's own arithmetic.
  expect(layout!.hostRight - layout!.gridRight).toBeLessThan(layout!.cellWidth + 1);
  // The scrollbar is an absolute overlay, its left edge over the grid rather than in a strip
  // beside it, and its box inside the host's right edge.
  expect(layout!.scrollbar).not.toBeNull();
  expect(layout!.scrollbar!.position).toBe("absolute");
  expect(layout!.scrollbar!.right).toBeLessThanOrEqual(layout!.hostRight + 1);
  expect(layout!.scrollbar!.left).toBeLessThan(layout!.gridRight);
  // Nothing to scroll yet: the overlay is hidden and takes no pointer events.
  expect(layout!.scrollbar!.classes).toContain("invisible");
  expect(layout!.scrollbar!.pointerEvents).toBe("none");

  // Add scrollback, then scroll: the overlay fades in over the grid.
  await typeUntilText(page, "seq 1 300 | sed 's/^/SCROLL-/'", "SCROLL-300");
  const box = await page.locator(".terminal-screen").boundingBox();
  if (box === null) throw new Error("the terminal has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -120);
  // `"invisible".includes("visible")` is true, so match the class token, not a substring, and fail
  // (not just wait out the budget) if the overlay never appears.
  await waitFor(
    "the scrollbar to fade in",
    async () => (await terminalLayout(page))?.scrollbar?.classes.split(/\s+/).includes("visible") === true,
    budget(10_000),
  );

  // The pty was resized to the wider grid the fit produced.
  const shown = await terminalSize(page);
  const reported = (await runToFile(page, `stty size > ${join(dir, "wide-size.txt")}`, join(dir, "wide-size.txt"))).trim();
  expect(reported).toBe(`${shown.rows} ${shown.cols}`);
  await page.close();
}, budget(90_000));

test.skipIf(!usable)("the font-size chords resize the pty to the new grid", async () => {
  const { page, dir } = await openTerminal(id);
  await typeUntilText(page, "echo FONT-SIZE-READY", "FONT-SIZE-READY");
  // Start from the default so the chord has somewhere to go.
  await page.locator(".terminal-screen").click();
  await page.keyboard.press("Control+Digit0");
  await until(() => terminalFontSize(page), 13, budget(5_000));
  const before = await terminalSize(page);

  // A smaller font is a larger grid; if the grid does not change the check below proves nothing.
  await page.keyboard.press("Control+Minus");
  await until(() => terminalFontSize(page), 12, budget(5_000));
  const changed = await until(async () => {
    const size = await terminalSize(page);
    return size.cols !== before.cols || size.rows !== before.rows;
  }, true, budget(5_000));
  expect(changed).toBe(true);
  await waitFor(
    "the resized grid to settle",
    async () => {
      const layout = await terminalLayout(page);
      return layout !== null && layout.cellWidth > 0 && Math.abs(layout.gridWidth - layout.cols * layout.cellWidth) <= 1;
    },
    budget(10_000),
  );
  const shown = await terminalSize(page);

  // The font change resizes the grid but not the host, so the ResizeObserver cannot tell the pty;
  // the chord path must send the new size itself or the shell keeps wrapping at the old width.
  const file = join(dir, "font-size-size.txt");
  let reported = "";
  for (let attempt = 0; attempt < 40 && reported !== `${shown.rows} ${shown.cols}`; attempt++) {
    await page.keyboard.type(`stty size > ${file}\n`);
    await Bun.sleep(200);
    reported = (await fileText(file)).trim();
  }
  expect(reported).toBe(`${shown.rows} ${shown.cols}`);
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

test.skipIf(!usable)("a terminal open in two windows is taken over, not frozen", async () => {
  const first = await openTerminal(id);
  const second = await openTerminal(id);

  // The second attach supersedes the first: the second is attached, and the first is told the
  // terminal is open elsewhere instead of silently freezing on its last screen.
  await second.page.waitForSelector(".terminal-screen[data-attached]", { timeout: budget(30_000) });
  await first.page.waitForSelector(".terminal-detached", { timeout: budget(30_000) });
  expect(await first.page.locator(".terminal-screen[data-attached]").count()).toBe(0);

  // Take over on the first: it re-attaches, and the second is the one detached now.
  await first.page.getByRole("button", { name: "Take over" }).click();
  await first.page.waitForSelector(".terminal-screen[data-attached]", { timeout: budget(30_000) });
  await second.page.waitForSelector(".terminal-detached", { timeout: budget(30_000) });

  await first.page.close();
  await second.page.close();
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
  // The app log an extension's own errors are filed into, beside the pane's identity.
  expect(env).toContain(`CORVI_LOG=${join(tmp, "state", "corvi", "log")}`);
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

test.skipIf(!usable)("the server's screen survives a reload with its scrollback", async () => {
  const { page } = await openTerminal(id);
  await typeUntilText(page, "seq 1 400 | sed 's/^/ROW-/'", "ROW-400");
  const before = await terminalLength(page);
  expect(before).toBeGreaterThan(100);

  // The screen belongs to the server; a reload asks for it again and gets it whole.
  await page.reload();
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await until(async () => (await terminalText(page)).includes("ROW-400"), true, budget(20_000));
  const restored = await terminalText(page);
  expect(restored).toContain("ROW-400");
  expect(restored).not.toContain("ROW-401");
  // Restored, not doubled.
  const after = await terminalLength(page);
  expect(after).toBeGreaterThan(100);
  expect(after).toBeLessThan(before + 50);
  await page.close();
}, budget(90_000));

test.skipIf(!usable)("a mouse wheel reaches a raw-mode program after a page reload (SGR)", async () => {
  const { page, dir } = await openTerminal(id);
  const log = join(dir, "mouse-sgr.log");
  await page.keyboard.type(`node '${mouseProbe}' sgr '${log}' ${budget(90_000)}\n`);
  await until(async () => (await fileText(log)).includes("READY"), true, budget(20_000));
  await until(() => mouseState(page), "drag:SGR", budget(15_000));

  const screen = page.locator(".terminal-screen");
  const wheel = async (): Promise<void> => {
    const box = await screen.boundingBox();
    if (box === null) throw new Error("the terminal has no box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 120);
  };
  await wheel();
  await until(async () => /1b5b3c/.test(await fileText(log)), true, budget(10_000));

  // The server's snapshot re-emits the tracking mode but the addon omits the encoding, so the
  // replay must put `?1006h` back or this wheel would not arrive SGR-encoded.
  await page.reload();
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await page.locator(".terminal-screen").click();
  await awaitAttached(page);
  await until(() => mouseState(page), "drag:SGR", budget(20_000));

  const before = ((await fileText(log)).match(/1b5b3c/g) ?? []).length;
  await wheel();
  await until(async () => ((await fileText(log)).match(/1b5b3c/g) ?? []).length > before, true, budget(10_000));

  // Force xterm's own selection even while a mouse-aware program has tracking on: the gesture a
  // person uses to copy while pi runs (Shift+drag on Linux, Option+drag on macOS, where the pane
  // sets `macOptionClickForcesSelection`). A drag across the screen includes the command line the
  // snapshot restored, so the selection cannot come back empty by trimming blanks.
  const isMac = await page.evaluate(() => /mac/i.test(navigator.platform));
  const forceSelect = isMac ? "Alt" : "Shift";
  await page.keyboard.down(forceSelect);
  const selBox = await screen.boundingBox();
  if (selBox === null) throw new Error("the terminal has no box");
  await page.mouse.move(selBox.x + 2, selBox.y + 2);
  await page.mouse.down();
  await page.mouse.move(selBox.x + selBox.width - 2, selBox.y + selBox.height - 2, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.up(forceSelect);
  await until(async () => (await terminalSelection(page)).trim().length > 0, true, budget(10_000));

  await page.keyboard.press("q");
  await until(async () => (await fileText(log)).includes("QUIT"), true, budget(10_000));
  await runCommand(page, `echo MOUSE-SGR-DONE > ${join(dir, "mouse-sgr-done.txt")}`, join(dir, "mouse-sgr-done.txt"), "MOUSE-SGR-DONE\n");
  await page.close();
}, budget(90_000));

test.skipIf(!usable)("a legacy DEFAULT-encoded mouse event reaches the pty through onBinary", async () => {
  const { page, dir } = await openTerminal(id);
  const log = join(dir, "mouse-default.log");
  await page.keyboard.type(`node '${mouseProbe}' default '${log}' ${budget(90_000)}\n`);
  await until(async () => (await fileText(log)).includes("READY"), true, budget(20_000));
  await until(() => mouseState(page), "drag:DEFAULT", budget(15_000));

  // A reload restores the tracking mode; with no `?1006h` set the snapshot must not invent one.
  await page.reload();
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await page.locator(".terminal-screen").click();
  await awaitAttached(page);
  await until(() => mouseState(page), "drag:DEFAULT", budget(20_000));

  // Aim at the right edge of the grid: the X10 x byte is `32 + col`, so the last column makes it
  // >= 0x80, the byte the old UTF-8 round-trip replaced with U+FFFD. The middle of the grid would
  // pass even with that corruption. `pointAtGridRight` only answers once the fit has settled, so
  // the wheel cannot land on a grid the page has not finished resizing to.
  await waitFor("the terminal's settled grid", async () => (await pointAtGridRight(page)) !== null, budget(10_000));
  const target = await pointAtGridRight(page);
  if (target === null) throw new Error("the terminal grid never settled");
  await page.mouse.move(target.x, target.y);
  await page.mouse.wheel(0, 120);
  // DEFAULT reports are `ESC [ M` plus the button, column and row bytes: what the pane has to
  // forward from `onBinary`. The reload's click reports too (at the centre), so look for a report
  // whose column byte is >= 0x80 — the wheel at the right edge — rather than the first one, and
  // assert no byte was replaced.
  const hasHighByteReport = (text: string): boolean =>
    [...text.matchAll(/1b5b4d([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/g)].some(
      (match) => parseInt(match[2]!, 16) >= 0x80,
    );
  await until(async () => hasHighByteReport(await fileText(log)), true, budget(10_000));
  expect(await fileText(log)).not.toContain("efbfbd");

  await page.keyboard.press("q");
  await until(async () => (await fileText(log)).includes("QUIT"), true, budget(10_000));
  await runCommand(page, `echo MOUSE-DEFAULT-DONE > ${join(dir, "mouse-default-done.txt")}`, join(dir, "mouse-default-done.txt"), "MOUSE-DEFAULT-DONE\n");
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
  await until(async () => (await terminalSelection(page)).trim() === "example.com", true, budget(10_000));
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

test.skipIf(!usable)("a hovered link shows its URL and the platform's open hint", async () => {
  const { page } = await openTerminal(id);
  const url = "https://example.com/hover-me";
  await typeUntilText(page, `echo ${url}`, "hover-me");
  const point = await hoverPointFor(page, url);
  expect(point).not.toBeNull();
  await page.mouse.move(point!.x, point!.y);

  const tooltip = page.locator(".terminal-link-tooltip");
  await tooltip.waitFor({ timeout: 10_000 });
  const text = await tooltip.innerText();
  expect(text).toContain(url);
  const isMac = await page.evaluate(() => /mac/i.test(navigator.platform));
  expect(text).toContain(isMac ? "Cmd-click to open" : "Ctrl-click to open");

  // Leaving the link hides it.
  await page.mouse.move(5, 5);
  await waitFor("the tooltip to hide", async () => (await page.locator(".terminal-link-tooltip").count()) === 0, budget(10_000));
  await page.close();
}, budget(90_000));

test.skipIf(!usable)("a ctrl/cmd-click on a link opens it", async () => {
  const { page } = await openTerminal(id);
  const url = "https://example.com/ctrl-open";
  await typeUntilText(page, `echo ${url}`, "ctrl-open");
  const point = await hoverPointFor(page, url);
  expect(point).not.toBeNull();
  await page.evaluate(() => {
    (window as unknown as { __opened: string[] }).__opened = [];
    (window as unknown as { open: (u: string) => null }).open = (u: string) => {
      (window as unknown as { __opened: string[] }).__opened.push(u);
      return null;
    };
  });
  // Cmd on macOS (Ctrl+click is a secondary click there), Ctrl elsewhere. This guards the
  // constructor that now also carries the tooltip callbacks.
  const chord = (await page.evaluate(() => /mac/i.test(navigator.platform))) ? "Meta" : "Control";
  await page.keyboard.down(chord);
  await page.mouse.click(point!.x, point!.y);
  await page.keyboard.up(chord);
  expect(
    await until(
      async () => (await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened))[0],
      url,
      budget(10_000),
    ),
  ).toBe(url);
  await page.close();
}, budget(90_000));

test.skipIf(!usable)("opening the context menu clears the link tooltip", async () => {
  const { page } = await openTerminal(id);
  const url = "https://example.com/tooltip-menu";
  await typeUntilText(page, `echo ${url}`, "tooltip-menu");
  const point = await hoverPointFor(page, url);
  expect(point).not.toBeNull();
  await page.mouse.move(point!.x, point!.y);
  await page.locator(".terminal-link-tooltip").waitFor({ timeout: 10_000 });

  // A right click that does not move the pointer: the tooltip is cleared by the menu opening, not
  // by the pointer leaving the link.
  await page.evaluate(() => {
    document.querySelector(".terminal-screen")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }));
  });
  await page.locator(".terminal-menu").waitFor({ timeout: 10_000 });
  await waitFor("the tooltip to clear", async () => (await page.locator(".terminal-link-tooltip").count()) === 0, budget(5_000));
  await page.close();
}, budget(90_000));

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

test.skipIf(!usable)("a selection dragged past the output ends at its last non-empty cell", async () => {
  const { page } = await openTerminal(id);
  await typeUntilText(page, "echo SELECT-ME", "SELECT-ME");
  const selection = await page.evaluate(() => {
    const element = document.querySelector(".terminal-screen") as (HTMLElement & { corviTerminal?: BrowserTerminal }) | null;
    const term = element?.corviTerminal;
    if (!term) return null;
    const buffer = term.buffer.active;
    let row = -1;
    for (let y = 0; y < buffer.length; y++) {
      if ((buffer.getLine(y)?.translateToString(true) ?? "") === "SELECT-ME") row = y;
    }
    if (row === -1) return null;
    // Drag the selection across the whole row, far past the end of the output: the highlight and the
    // copied text must stop at "ME", not carry the blank cells to the right.
    term.select(0, row, term.cols);
    return { row, text: term.getSelection(), end: term.getSelectionPosition()?.end };
  });
  expect(selection?.row).toBeGreaterThanOrEqual(0);
  // The highlight ends at the output's last cell, not in the blank cells after it; the text follows.
  expect(selection?.end).toEqual({ x: "SELECT-ME".length, y: selection!.row });
  expect(selection?.text).toBe("SELECT-ME");
  await page.close();
}, budget(90_000));

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
  await awaitBracketedPaste(page);
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
  await awaitBracketedPaste(page);
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

test.skipIf(!usable)("a static marker in a continuously-updating window survives a switch and a reconnect", async () => {
  const { page } = await openTerminal(live);
  const tabs = page.locator(".window-tab:not(.new):not(.overview)");
  await tabs.first().waitFor({ timeout: 15_000 });

  // A marker drawn once, then a loop that keeps the screen updating at a fixed position forever:
  // the screen never goes idle, so a page-side snapshot cadence would never run. The server's
  // screen is current regardless.
  await typeUntilText(
    page,
    "clear; printf '\\e[1;1HSRV-LIVE-MARKER'; while :; do printf '\\e[2;1HUPDATE-%d ' $RANDOM; sleep 0.02; done",
    "SRV-LIVE-MARKER",
  );
  await until(async () => (await terminalText(page)).includes("UPDATE-"), true, budget(10_000));

  // Switching to a new window and back must not lose the marker: it lives in the server's screen.
  await page.locator(".window-tab.new").click();
  expect(await until(() => tabs.count(), 2)).toBe(2);
  await tabs.first().click();
  expect(await until(async () => (await terminalText(page)).includes("SRV-LIVE-MARKER"), true, budget(20_000))).toBe(true);

  // A reconnecting page gets the same screen.
  await page.reload();
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await page.locator(".terminal-screen").click();
  expect(await until(async () => (await terminalText(page)).includes("SRV-LIVE-MARKER"), true, budget(20_000))).toBe(true);

  // Clean up: the loop is the foreground process of this shell.
  await page.keyboard.press("Control+C");
  await page.close();
}, budget(90_000));
