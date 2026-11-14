import { test, expect, beforeAll, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit, type Browser, type Locator, type Page } from "playwright";
import { closePages, requireFreshWebBundle, runSh, serverEnv, stopRunHost, testRun, testTempDir, waitForUrl } from "./helpers.ts";

/**
 * What happens to untracked files when a worktree goes, through the page: removing a repository
 * from a change stops at a worktree holding them, names them, and goes ahead only once that is
 * acknowledged; cancelling a change shelves them instead, and reopening it brings them back. The
 * server's rules are pinned in repos.test.ts and cancel.test.ts; this is what the user sees and
 * clicks.
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

// The assertions below read the built bundle: a bundle older than the sources would be
// yesterday's UI, and is refused here (test/helpers.ts, docs/guides/testing.md).
if (usable) requireFreshWebBundle();

let tmp: string;
let url: string;
let server: ReturnType<typeof Bun.spawn>;

/** A repository with a remote, so a fresh branch has somewhere its work could land. */
const clonedRepo = async (name: string): Promise<string> => {
  const seed = join(tmp, `${name}-seed`);
  await runSh(["git", "init", "-b", "main", seed]);
  await Bun.write(join(seed, "README.md"), `${name}\n`);
  await runSh(["git", "add", "."], seed);
  await runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], seed);
  await runSh(["git", "clone", "--bare", "--quiet", seed, join(tmp, `${name}.git`)]);
  const repo = join(tmp, name);
  await runSh(["git", "clone", "--quiet", join(tmp, `${name}.git`), repo]);
  return repo;
};

/** A started change with one worktree, holding an untracked file a local run left behind. */
const changeWithLeftovers = async (id: string, repo: string): Promise<string> => {
  const created = await fetch(`${url}/api/changes`, {
    method: "POST",
    body: JSON.stringify({
      id,
      state: "Ideation",
      checkouts: [{ path: repo, location: "new", branch: { kind: "change" } }],
    }),
  });
  expect(created.status).toBe(201);
  const started = await fetch(`${url}/api/changes/${id}/start`, { method: "POST" });
  expect(started.ok).toBe(true);
  const worktree = join(tmp, "changes", id, "app");
  await Bun.write(join(worktree, "__pycache__", "test.pyc"), "x");
  return worktree;
};

const exists = (path: string): Promise<boolean> => Bun.file(join(path, "README.md")).exists();

beforeAll(async () => {
  if (!usable) return;
  tmp = await testTempDir("discard-question");
  server = Bun.spawn(["node", "apps/server/src/server.ts", `--corvi-test-run=${testRun()}`], {
    // The repository browser opens here, not in the home directory of whoever runs the suite.
    env: serverEnv(tmp, { CORVI_REPOSITORIES_DIRECTORY: tmp }),
    stdout: "pipe",
    stderr: process.env.CORVI_TEST_LOUD ? "inherit" : "ignore",
  });
  url = await waitForUrl(server);
});

afterAll(async () => {
  if (!usable) return;
  // Whatever pages a failed test left open are screenshotted for CI's failure artifacts first.
  await closePages(browser, "discard-question");
  await browser?.close();
  server?.kill();
  await server?.exited;
  await stopRunHost(tmp);
  await rm(tmp, { recursive: true, force: true });
});

/** The open dialog's confirm button, by the name it has there. */
const confirm = (page: Page, name: string): Locator => page.locator("dialog[open]").getByRole("button", { name, exact: true });

test.skipIf(!usable)("removing a repository names its untracked files and asks before they go", async () => {
  const id = "DISCARD-EDIT";
  const worktree = await changeWithLeftovers(id, await clonedRepo("app"));

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${url}/changes/${id}/dashboard`, { waitUntil: "domcontentloaded" });
  await page.locator('button[title="Edit Local changes"]').click();
  await page.locator("dialog[open]").getByRole("button", { name: "Remove" }).click();
  await confirm(page, "OK").click();

  // Asked in the dialog, naming the files; nothing is removed until it is acknowledged.
  const question = page.locator("dialog[open] li", { hasText: "untracked files" });
  await question.waitFor();
  expect(await question.innerText()).toBe("app: untracked files: __pycache__/");
  expect(await confirm(page, "OK").isDisabled()).toBe(true);
  expect(await exists(worktree)).toBe(true);

  await page.locator("dialog[open] label.ack input").check();
  await confirm(page, "OK").click();
  await page.waitForSelector("dialog[open]", { state: "detached" });
  expect(await exists(worktree)).toBe(false);
  await page.close();
}, 60_000);

test.skipIf(!usable)("cancelling shelves the untracked files without asking, and Reopen brings them back", async () => {
  const id = "DISCARD-CANCEL";
  const worktree = await changeWithLeftovers(id, join(tmp, "app"));

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${url}/changes/${id}/plan`, { waitUntil: "domcontentloaded" });
  await page.locator(".change-tabs .menu > button").click();
  await page.getByRole("button", { name: "Cancel change" }).click();
  await confirm(page, "Cancel change").click();

  // Nothing is lost, so nothing is asked: the files go onto a shelf with the change.
  await page.waitForSelector("dialog[open]", { state: "detached" });
  await page.locator(".notice", { hasText: "is shelved" }).waitFor();
  const after = (await (await fetch(`${url}/api/changes/${id}`)).json()) as { state?: string };
  expect(after.state).toBe("Cancelled");
  expect(await exists(worktree)).toBe(false);
  // A finished change offers its kept agent sessions.
  expect(await page.locator(".change-tabs .tab", { hasText: "Transcripts" }).count()).toBe(1);

  // Reopening: the worktree comes back, and so does the shelved file.
  await page.getByRole("button", { name: "Reopen", exact: true }).click();
  await page.locator(".notice", { hasText: "the shelved work is back" }).waitFor();
  const reopened = (await (await fetch(`${url}/api/changes/${id}`)).json()) as { state?: string };
  expect(reopened.state).toBe("Implementation");
  expect(await exists(worktree)).toBe(true);
  expect(await Bun.file(join(worktree, "__pycache__", "test.pyc")).text()).toBe("x");
  await page.close();
}, 60_000);
