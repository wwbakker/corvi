import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { budget, checkoutsOf, closePages, requireFreshWebBundle, runSh, serverEnv, testRun, testTempDir, until, waitForUrl } from "./helpers.ts";
import { csiuFor } from "@corvi/terminals/model";
import { ensureHost } from "../apps/server/src/terminals/host/client.ts";

/**
 * The terminal through a real browser. The pty is owned by the terminal host: the page's xterm
 * is a glass over a host session, the window strip is the server's registry, and the shells
 * outlive the server. The server runs on Node (the host does too).
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

/** The xterm buffer, read through the seam the pane sets on its host element: the WebGL canvas
 * has no DOM text to read, and the buffer is exactly what a snapshot is taken from. */
type BrowserTerminal = {
  buffer: { active: { length: number; getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined } };
  options: { fontSize: number };
  getSelection(): string;
  select(column: number, row: number, length: number): void;
  focus(): void;
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

/** Type one command until its output appears on the screen (not merely echoed). */
const typeUntilText = async (page: Page, command: string, needle: string): Promise<void> => {
  for (let attempt = 0; attempt < 40; attempt++) {
    await page.keyboard.type(`${command}\n`);
    for (let settle = 0; settle < 8; settle++) {
      if ((await terminalText(page)).includes(needle)) return;
      await Bun.sleep(200);
    }
  }
  throw new Error(`the terminal never showed ${needle}`);
};

/** Type one command exactly once and wait for its output. For a command whose effect cannot be
 * repeated (a large stream), a retry would corrupt the test rather than help it; the shell must
 * already be proven ready by a `runCommand` first, or the single line could be lost. */
const typeOnceUntil = async (page: Page, command: string, needle: string, ms = 2000): Promise<void> => {
  await page.keyboard.type(`${command}\n`);
  await until(async () => (await terminalText(page)).includes(needle), true, budget(ms));
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
  // Let the periodic cadence store a snapshot taken *after* the filler (its offset covers the whole
  // stream), then force one too. A snapshot older than the ring would attach into a truncated
  // replay whose reset clears the very marker this test is about.
  await Bun.sleep(2500);
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

  // Selecting the first tab attaches back to its own shell, marker intact.
  const label = (await tabs.first().innerText()).trim();
  await tabs.first().click();
  expect(await until(() => page.locator(".window-tab.current").innerText(), label)).toBe(label);
  await runCommand(page, `echo "\${TAB_MARK:-none}" > ${join(dir, "first-tab.txt")}`, join(dir, "first-tab.txt"), "one\n");
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
  // Record the control frames the page sends, and neutralise the 2s cadence so the hide is the only
  // thing that can produce a snapshot in the window the test checks. That isolates the
  // visibilitychange path from the periodic one (which the reload test already covers).
  await page.addInitScript(() => {
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
    const originalSetInterval = window.setInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]): number => {
      if (timeout === 2000) return 0;
      return originalSetInterval(handler, timeout, ...args);
    }) as typeof window.setInterval;
  });
  await page.goto(`${url}/changes/${id}/terminals`);
  await page.waitForSelector(".terminal-screen .xterm-screen", { timeout: 15_000 });
  await page.locator(".terminal-screen").click();
  await typeUntilText(page, "echo HIDE_MARKER", "HIDE_MARKER");
  expect(await page.evaluate(() => (window as unknown as { __snapshots: unknown[] }).__snapshots.length)).toBe(0);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await until(
    async () => await page.evaluate(() => (window as unknown as { __snapshots: unknown[] }).__snapshots.length),
    1,
    budget(10_000),
  );
  await page.close();
}, budget(60_000));
