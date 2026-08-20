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
  port = 4300 + Math.floor(Math.random() * 200);
  server = Bun.spawn(["bun", "src/server.ts"], {
    env: { ...process.env, IWE_ROOT: join(tmp, "changes"), IWE_PORT: String(port) },
    stdout: "ignore",
    stderr: "ignore",
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
  await sh(["tmux", "kill-session", "-t", session]);
  await rm(tmp, { recursive: true, force: true });
});

test.skipIf(!usable)("the terminal tab runs a shell in the change directory", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`http://127.0.0.1:${port}/changes/${id}`);
  await page.getByRole("button", { name: "Terminals" }).click();
  await page.waitForSelector(".terminal iframe");

  // ttyd draws into a canvas, so what the shell did has to be read from the shell, not the page.
  const term = page.frameLocator(".terminal iframe").locator("body");
  await term.waitFor({ state: "visible", timeout: 15_000 });
  await term.click();

  // tmux only starts when the browser connects, and the shell only prompts after that.
  const started = async (): Promise<boolean> =>
    (await sh(["tmux", "has-session", "-t", session])).code === 0;
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
  const windows = await sh(["tmux", "list-windows", "-t", session]);
  expect(windows.stdout.split("\n").length).toBe(2);

  // Scrolling should scroll, which is tmux's mouse mode rather than the shell's history.
  const mouse = await sh(["tmux", "show-options", "-t", session, "mouse"]);
  expect(mouse.stdout).toBe("mouse on");

  // The strip lists tmux's windows, and its buttons are tmux's own commands.
  const strip = page.locator(".windows .win").filter({ hasNotText: "+" });
  expect(await until(() => strip.count(), 2)).toBe(2); // the shell, and the ctrl-b c one above
  // Windows are labelled by where they are, so a window that walks into a repository says so.
  expect((await strip.allInnerTexts()).every((l) => l.trim() === id)).toBe(true);
  await page.keyboard.type(`cd ${join(tmp, "repo")}\n`);
  expect(await until(async () => (await strip.allInnerTexts()).join(" "), `${id} repo`)).toBe(
    `${id} repo`,
  );

  await page.locator(".windows .win.add").click();
  expect(await until(() => strip.count(), 3)).toBe(3);

  expect((await sh(["tmux", "list-windows", "-t", session])).stdout.split("\n").length).toBe(3);

  // Selecting one makes it tmux's current window.
  await strip.first().click();
  await Bun.sleep(500);
  const current = await sh([
    "tmux",
    "display-message",
    "-p",
    "-t",
    session,
    "#{window_index}",
  ]);
  expect(current.stdout).toBe("0");

  // Clicking a window must not take the keyboard with it: you click a window to type in it.
  await page.locator(".windows .win.add").click();
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
