import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { sh } from "../src/sh.ts";

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

const have = async (tool: string): Promise<boolean> => (await sh(["which", tool])).code === 0;
const usable = (await have("ttyd")) && (await have("tmux"));

let tmp: string;
let browser: Browser;
let port: number;
let server: ReturnType<typeof Bun.spawn>;
const id = "PROJ-TERM";
const session = `iwe-${id}`;

beforeAll(async () => {
  if (!usable) return;
  tmp = await mkdtemp(join(tmpdir(), "iwe-term-"));
  // A tmux server of our own, so the test can change server options and kill everything
  // afterwards without touching the sessions you are working in.
  process.env.TMUX_TMPDIR = tmp;
  port = 4300 + Math.floor(Math.random() * 200);
  server = Bun.spawn(["bun", "src/server.ts"], {
    env: { ...process.env, IWE_ROOT: join(tmp, "changes"), IWE_PORT: String(port) },
    stdout: "ignore",
    stderr: process.env.IWE_TEST_LOUD ? "inherit" : "ignore",
  });
  // The repository is only needed because a change must have one; the terminal ignores it.
  const repo = join(tmp, "repo");
  await sh(["git", "init", "-b", "main", repo]);
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
  await sh(["pkill", "-f", `new-session -A -s ${session}`]);
  await tmux("kill-server"); // ours alone: TMUX_TMPDIR points at the temporary directory
  await rm(tmp, { recursive: true, force: true });
});

test.skipIf(!usable)("a terminal outlives the server that started it", async () => {
  const before = await (await fetch(`http://127.0.0.1:${port}/api/changes/${id}/terminal`)).json();

  // Restart, as happens constantly while working on IWE itself.
  server.kill();
  await Bun.sleep(500);
  server = Bun.spawn(["bun", "src/server.ts"], {
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

  // ttyd draws into a canvas, so what the shell did has to be read from the shell, not the page.
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
  await page.keyboard.type("tmux set -p @agent working\n");
  expect(
    await until(async () => (await strip.allInnerTexts())[1]?.trim(), "repo - (pi working)"),
  ).toBe("repo - (pi working)");
  await page.keyboard.type("tmux set -p @agent waiting\n");
  expect(
    await until(async () => (await strip.allInnerTexts())[1]?.trim(), "repo - (pi waiting)"),
  ).toBe("repo - (pi waiting)");
  // Unset when the agent leaves, and the window is a shell in a directory again.
  await page.keyboard.type("tmux set -p -u @agent\n");
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
    const press = (init: KeyboardEventInit) =>
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
