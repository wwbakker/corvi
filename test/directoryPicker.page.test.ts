import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit, type Browser } from "playwright";
import { closePages, serverEnv, testRun, testTempDir, waitForUrl } from "./helpers.ts";
import type { Listing } from "../apps/web/src/app-root/api.ts";

/**
 * The directory browser's routes and the settings picker that drives them.
 *
 * The routes are the server's own answers: which directory a listing opens on, what a context's
 * own setting contributes, and what `hidden=1` adds. The picker is those answers through the
 * page, because the page is what decides whether the request carries the hidden flag and which
 * path a choice writes — the two things a route test cannot see.
 */
let browser: Browser;
const engineName = process.env.CORVI_ENGINE === "webkit" ? "webkit" : "chromium";
const usable = await (async (): Promise<boolean> => {
  try {
    const engine = engineName === "webkit" ? webkit : chromium;
    if (!(await Bun.file(engine.executablePath()).exists())) return false;
    browser = await engine.launch();
    return true;
  } catch {
    return false;
  }
})();

let tmp: string;
let url: string;
let server: ReturnType<typeof Bun.spawn>;
let globalDir: string;
let clientDir: string;
/** The configured start directory: a subdirectory of the global one, so the two differ. */
let startDir: string;

beforeAll(async () => {
  tmp = await testTempDir("directory-picker");
  globalDir = join(tmp, "global-repos");
  startDir = join(globalDir, "alpha");
  clientDir = join(tmp, "client-repos");
  await mkdir(join(startDir, ".git"), { recursive: true });
  await mkdir(join(startDir, "inner"), { recursive: true });
  await mkdir(join(globalDir, ".secret"), { recursive: true });
  await mkdir(join(clientDir, "beta"), { recursive: true });

  // The configured start is a subdirectory of the global directory, so a test can tell "the
  // field's value" and "the global start" apart; the client workspace names its own.
  await writeFile(
    join(tmp, "config.json"),
    JSON.stringify({
      repositoriesDirectory: startDir,
      workspaces: [
        { id: "default", name: "Default" },
        { id: "client", name: "Client", repositoriesDirectory: clientDir },
      ],
    }),
  );

  server = Bun.spawn(["node", "apps/server/src/server.ts", `--corvi-test-run=${testRun()}`], {
    env: serverEnv(tmp),
    stdout: "pipe",
    stderr: process.env.CORVI_TEST_LOUD ? "inherit" : "ignore",
  });
  url = await waitForUrl(server);
});

afterAll(async () => {
  // Whatever pages a failed test left open are screenshotted for CI's failure artifacts first.
  await closePages(browser, "directory-picker");
  await browser?.close();
  server?.kill();
  await rm(tmp, { recursive: true, force: true });
});

const listing = (query: string): Promise<Listing> =>
  fetch(`${url}/api/repos${query}`).then((r) => r.json() as Promise<Listing>);

test("the route opens on the configured start directory, hidden directories withheld", async () => {
  const at = await listing("");
  expect(at.path).toBe(startDir);
  expect(at.entries.map((e) => e.name)).toEqual(["inner"]);
  expect(at.entries[0]!.path).toBe(join(startDir, "inner"));
});

test("hidden=1 is what brings dot-directories back", async () => {
  expect((await listing("?hidden=1")).entries.map((e) => e.name)).toEqual([".git", "inner"]);
});

test("a context's own repositories directory wins over the global one", async () => {
  const own = await listing("?workspace=client");
  expect(own.path).toBe(clientDir);
  expect(own.entries.map((e) => e.name)).toEqual(["beta"]);
  // A context that names none inherits the global start.
  expect((await listing("?workspace=default")).path).toBe(startDir);
});

test("an explicit path is listed, and a relative one is refused", async () => {
  expect((await listing(`?path=${encodeURIComponent(globalDir)}`)).path).toBe(globalDir);

  const bad = await fetch(`${url}/api/repos?path=relative`);
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { error: string }).error).toContain("not an absolute path");
});

test.skipIf(!usable)("the settings picker walks, reveals hidden directories and writes the choice", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(`${url}/settings`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("nav.tabs");

    const field = page
      .locator(".settings .field")
      .filter({ has: page.getByLabel("Repositories directory") });
    // By its aria-label rather than `field.locator("input")`: the picker's dialog lives inside
    // the same field, and its filter box and checkbox are inputs too once it is open.
    const input = page.getByLabel("Repositories directory");
    // The file's value: the picker has a place of its own to open on.
    expect(await input.inputValue()).toBe(startDir);

    await field.getByRole("button", { name: "Browse" }).click();
    const dialog = page.locator("dialog[open]");
    await dialog.waitFor();
    expect((await dialog.locator("h3").innerText()).trim()).toBe("Choose a directory");
    // Opened on the field's own value — the subdirectory, not the global start. Wait for the
    // first response before counting: the dialog says "loading…" until the listing lands.
    await dialog.locator(".entries button.dir").first().waitFor();
    expect(await dialog.locator(".entries button.dir", { hasText: "inner" }).count()).toBe(1);
    // And the server withheld the dot-directories: the request did not ask for them.
    expect(await dialog.locator(".entries button.dir", { hasText: ".git" }).count()).toBe(0);

    // The filter narrows what arrived, and a miss says so rather than looking empty.
    await dialog.locator("input.filter").fill("nothing");
    await dialog.locator(".entries .hint", { hasText: "nothing matches" }).waitFor();
    await dialog.locator("input.filter").fill("");

    await dialog.locator('input[type="checkbox"]').check();
    await dialog.locator(".entries button.dir", { hasText: ".git" }).first().waitFor();

    // Up to the global directory, hidden still shown: the flag travels with the listing.
    await dialog.getByRole("button", { name: "Up" }).click();
    await dialog.locator(".entries button.dir", { hasText: ".secret" }).first().waitFor();
    await dialog.locator(".entries button.dir", { hasText: "alpha" }).first().waitFor();

    await dialog.getByRole("button", { name: "Use this directory" }).click();
    expect(await input.inputValue()).toBe(globalDir);

    // Save takes effect at once, and survives a reload because the file is what holds it.
    await page.getByRole("button", { name: "Save" }).click();
    await page.waitForSelector(".hint.saved", { timeout: 10_000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("nav.tabs");
    const after = await page.getByLabel("Repositories directory").inputValue();
    expect(after).toBe(globalDir);
  } finally {
    await page.close();
  }
}, 60_000);
