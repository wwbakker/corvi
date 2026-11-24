import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { claimRunPidFile, isRunToken } from "../scripts/clean-test.ts";
import { testTempBase } from "../scripts/test-temp.ts";
import { Effect, Layer, Result, Schema } from "effect";
import { TestClock, TestConsole } from "effect/testing";
import type { Workspace } from "../apps/server/src/workspace/server/index.ts";
import {
  configPath,
  reloadConfigSync,
  runtimeConfig,
  type Config,
} from "../apps/server/src/workspace/server/index.ts";
import { capabilitiesLayer } from "../apps/server/src/integrations/services.ts";
import type { Capabilities } from "../apps/server/src/integrations/api/capabilities.ts";
import { setRepos } from "../apps/server/src/change/provisioning.ts";
import { sh, type ShellResult } from "../apps/server/src/capabilities/shell.ts";
import { HOST_DIR, hostBuildId } from "../apps/server/src/terminals/host/identity.ts";
import { env } from "@corvi/configuration/node";
import { Shell } from "@corvi/shell";
import { Workspace as WorkspaceTag } from "@corvi/contracts/workspace";
import {
  CacheLive,
  ChangesLive,
  GitFactsLive,
  SettingsLive,
} from "../apps/server/src/integrations/services.ts";
import type { CliError } from "@corvi/contracts/errors";
import { toResponse } from "../apps/server/src/capabilities/effect/http.ts";
import { swr } from "../apps/server/src/capabilities/cache.ts";
import { workspaceById } from "../apps/server/src/workspace/server/index.ts";
import type { Change } from "@corvi/changes/record";
import { cancelChange, changePairs } from "../apps/server/src/change/server/index.ts";
import { ChangeStore } from "@corvi/changes/store";
import { storeLayer } from "@corvi/changes/node";
import { ChangeId } from "@corvi/contracts/changes";
import { fileDiff, localChanges } from "../apps/server/src/integrations/review/server.ts";
import type { LocalStatus } from "@corvi/contracts/integrations/review";
import { deploy, versionsFor, type Buildable } from "@corvi/azure-devops/server";

/** Whether this process has written the run's pid-file yet. */
let announced = false;

/** The token that names this run. The suite's own script sets `CORVI_TEST_RUN`; a lone
 * `bun test test/foo.test.ts` gets one from its pid and the clock. It is written into every temp
 * dir's name and into `<test temp base>/corvi-<token>.pid`, which is what lets
 * scripts/clean-test.ts tell one run's resources from another's, and a live run from a crashed
 * one. The base is `/tmp` on macOS, `tmpdir()` elsewhere (`scripts/test-temp.ts`: the host's unix
 * socket must fit a `sun_path`). */
export const testRun = (): string => {
  const fromEnv = process.env.CORVI_TEST_RUN;
  // A hand-set token the cleaner cannot read would leave this run's servers and hosts behind as
  // unattributable (`--all`-only). Refuse it here, before anything starts, rather than leak them.
  if (fromEnv !== undefined && fromEnv !== "" && !isRunToken(fromEnv)) {
    throw new Error(
      `CORVI_TEST_RUN=${fromEnv} is not a run token: scripts/clean-test.ts reads tokens as ` +
        "<base36>.<base36> (two lowercase words joined by a dot, what `date +%s.$$` produces). " +
        "Leave it unset for a lone test file, or run the suite with `bun run test`.",
    );
  }
  const token =
    fromEnv !== undefined && fromEnv !== ""
      ? fromEnv
      : `${Date.now().toString(36)}.${process.pid.toString(36)}`;
  process.env.CORVI_TEST_RUN = token;
  // Claimed through the shared helper (scripts/clean-test.ts): the wrapper's pid is left in place
  // while it lives, a file naming a dead pid is taken over, and a symlink planted in the shared
  // temp base is never written through. A lone `bun test` has no wrapper, so its own pid stands in
  // — under `--parallel`, the first *worker's* pid, and that worker is gone before the run is.
  if (!announced) {
    announced = true;
    claimRunPidFile(testTempBase(), token, process.pid);
  }
  return token;
};

/** A temp dir whose name carries the run token, so the cleaner can tell whose it is. */
const tempDirName = (label: string): string => join(testTempBase(), `corvi-${testRun()}-${label}-`);

export const testTempDir = (label: string): Promise<string> => mkdtemp(tempDirName(label));

/** A file's own changes roots: a token-named temp dir with `changes` and `changes-archive` under
 * it, exported through the environment before any test in the file reads the configuration.
 * Product code that deletes a change or an archive mutates exactly these roots, so a file cannot
 * disturb another's state. `realpath` matters: the store compares resolved paths. */
export const useOwnChangeRoot = async (label: string): Promise<string> => {
  const tmp = await realpath(await testTempDir(label));
  process.env.CORVI_ROOT = join(tmp, "changes");
  process.env.CORVI_ARCHIVE_ROOT = join(tmp, "changes-archive");
  return tmp;
};

/** One commit in a test repository, with a fixed identity so git never asks. */
export const commitIn = (repo: string, message: string): Promise<ShellResult> =>
  runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", message], repo);

/** A test repository: one commit on `branch` (main by default). With `remote`, the seed is cloned
 * into a bare origin and the returned clone tracks it, configured with the test identity unless
 * `configure: false`. */
export const gitRepo = async (
  tmp: string,
  name: string,
  options: { readonly branch?: string; readonly remote?: boolean; readonly configure?: boolean } = {},
): Promise<string> => {
  const branch = options.branch ?? "main";
  const seed = join(tmp, options.remote ? `${name}-seed` : name);
  await runSh(["git", "init", "-b", branch, seed]);
  await Bun.write(join(seed, "README.md"), `${name}\n`);
  await runSh(["git", "add", "."], seed);
  await commitIn(seed, "init");
  if (!options.remote) return seed;
  const origin = join(tmp, `${name}.git`);
  await runSh(["git", "clone", "--bare", "--quiet", seed, origin]);
  const clone = join(tmp, name);
  await runSh(["git", "clone", "--quiet", origin, clone]);
  if (options.configure !== false) {
    await runSh(["git", "config", "user.email", "t@t"], clone);
    await runSh(["git", "config", "user.name", "t"], clone);
  }
  return clone;
};

/** Remember the named environment values and return the function that puts them back exactly —
 * an unset key deleted again, not written as "undefined". For the files whose environment is set
 * for the whole file (`beforeAll`/module load) rather than one test body. */
export const rememberEnv = (...names: readonly string[]): (() => void) => {
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
};

/** Run `body` with an environment patch, restoring every key exactly as it was — an absent key
 * removed again, not written as the string "undefined". The environment twin of
 * `withRuntimeConfig`. */
export const withEnv = async <T>(
  patch: Readonly<Record<string, string | undefined>>,
  body: () => Promise<T> | T,
): Promise<T> => {
  const saved = new Map(Object.keys(patch).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

/** Write a test configuration file and put it into effect without a restart. */
export const writeTestConfig = (value: unknown): void => {
  writeFileSync(configPath(), JSON.stringify(value));
  reloadConfigSync();
};

/** The common shape: a config holding just these workspaces. */
export const writeTestWorkspaces = (workspaces: unknown[]): void => writeTestConfig({ workspaces });

/** This file's own world, applied before any test in it reads the configuration: `CORVI_ROOT`
 * and its siblings point into a directory no other test file shares. Product code that deletes
 * a change, an archive or a leftover mutates exactly these roots — shared per run, they were a
 * file running beside this one's state; per file, a test can only ever disturb itself.
 * `serverEnv` gives spawned servers the same guarantee; this is it for the tests that run the
 * product in their own process. Named for the run, so scripts/clean-test.ts takes it with the
 * rest of the run's leftovers.
 *
 * Made without a top-level await on purpose: an awaiting module is still initializing when its
 * importers run, and bun's `--isolate` then hands out its exports before they exist — every
 * helper reads as "Cannot access … before initialization" in every test file. */
const ownRoot = mkdtempSync(tempDirName("root"));
process.env.CORVI_ROOT = join(ownRoot, "changes");
process.env.CORVI_ARCHIVE_ROOT = join(ownRoot, "changes-archive");
process.env.CORVI_CONFIG = join(ownRoot, "config.json");
process.env.CORVI_CACHE = join(ownRoot, "cache.json");
process.env.XDG_STATE_HOME = join(ownRoot, "state");
process.env.PI_CODING_AGENT_DIR = join(ownRoot, "pi-agent");
process.env.OPENCODE_DB = join(ownRoot, "opencode", "opencode.db");

/** What a test may state on the config snapshot for a body: any resolved field. */
export type RuntimeConfigPatch = Partial<Config>;

/** Shut down a test server's terminal host, if one was started. The host outlives the server by
 * design, so a test that opened a terminal must end it explicitly or leave a pty owner behind.
 * The socket is the test's own (`serverEnv` put it under `tmp`), so this never touches another
 * run's host. */
export const stopRunHost = async (tmp: string): Promise<void> => {
  const socket = join(tmp, "state", "corvi", "host.sock");
  if (!existsSync(socket)) return;
  const { ensureHost } = await import("../apps/server/src/terminals/host/client.ts");
  const client = await ensureHost({
    socket,
    checkout: process.cwd(),
    buildId: hostBuildId(HOST_DIR),
    runtime: "node",
  })
    .then((result) => result.client)
    .catch(() => undefined);
  await client?.shutdown().catch(() => undefined);
  client?.close();
};

/** Run `body` with `patch` applied to the one config object every module holds by reference,
 * then put each patched key back exactly as it was — own property restored if the object had
 * one, absent key removed if it did not — even when the body throws, so a failed expectation
 * cannot leak a workspace into the next test. One body at a time: a file's tests run in order,
 * so a test that patches wraps its own body rather than a hook. */
export const withRuntimeConfig = async <T>(
  patch: RuntimeConfigPatch,
  body: () => Promise<T> | T,
): Promise<T> => {
  const config = runtimeConfig();
  const saved = (Object.keys(patch) as (keyof RuntimeConfigPatch)[]).map(
    (key) => [key, Object.getOwnPropertyDescriptor(config, key)] as const,
  );
  Object.assign(config, patch);
  try {
    return await body();
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) delete (config as Record<string, unknown>)[key];
      else Object.defineProperty(config, key, descriptor);
    }
  }
};

/** Environment for a spawned test server: the OS picks the port (`CORVI_PORT=0`), and every
 * path is the file's own tmp dir, so parallel workers share nothing — not the changes, the
 * config, the built page, or the cache file. `ZDOTDIR` points zsh at startup files that do not
 * exist, so the terminals a test drives have the system's plain prompt, not the prompt and
 * plugins of whoever runs the suite — those move the cursor the terminal tests measure. */
export const serverEnv = (
  tmp: string,
  extra: Record<string, string> = {},
): Record<string, string | undefined> => ({
  ...process.env,
  CORVI_ROOT: join(tmp, "changes"),
  CORVI_ARCHIVE_ROOT: join(tmp, "changes-archive"),
  CORVI_CONFIG: join(tmp, "config.json"),
  XDG_STATE_HOME: join(tmp, "state"),
  PI_CODING_AGENT_DIR: join(tmp, "pi-agent"),
  OPENCODE_DB: join(tmp, "opencode", "opencode.db"),
  CORVI_CACHE: join(tmp, "cache.json"),
  CORVI_PORT: "0",
  ZDOTDIR: join(tmp, "zdotdir"),
  ...extra,
});

/** Read a spawned server's stdout until it says where it is listening (`corvi on <url>`,
 * apps/server/src/server.ts), and hand back the URL without its trailing slash. Readiness is the server's
 * own line rather than a poll: a random port picked here once landed on a busy one, and then
 * the test said only "connection refused" (test/node-runtime.test.ts). Rejects if the
 * server exits first, or says nothing within a minute. */
export const waitForUrl = async (proc: ReturnType<typeof Bun.spawn>, timeoutMs = 60_000): Promise<string> => {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const failure = proc.exited.then((): string => {
    throw new Error(`the server exited before it was up:\n${seen}`);
  });
  // The race below observes the outcome; this silences the loser path, which would otherwise
  // reject unhandled when the server is killed at the end of a passing test.
  failure.catch(() => undefined);
  const line = (async (): Promise<string> => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`the server exited before it was up:\n${seen}`);
      seen += decoder.decode(value, { stream: true });
      const found = /corvi on (http:\/\/127\.0\.0\.1:\d+\/)/.exec(seen);
      if (found?.[1]) return found[1].replace(/\/$/, "");
    }
  })();
  const timeout = new Promise<string>((_, reject) =>
    setTimeout(
      () => reject(new Error(`the server did not come up within ${timeoutMs}ms:\n${seen}`)),
      timeoutMs,
    ),
  );
  return await Promise.race([line, failure, timeout]);
};

/** Start a test server on an OS-picked port, with the run's isolated environment, and wait for
 * its readiness line. The caller owns the temp dir and the teardown. */
export const startTestServer = async (
  tmp: string,
  options: {
    readonly env?: Record<string, string>;
    readonly cwd?: string;
    readonly stderr?: "pipe" | "ignore" | "inherit";
  } = {},
): Promise<{ server: ReturnType<typeof Bun.spawn>; url: string }> => {
  const server = Bun.spawn(["node", "apps/server/src/server.ts", `--corvi-test-run=${testRun()}`], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: serverEnv(tmp, options.env),
    stdout: "pipe",
    stderr: options.stderr ?? (process.env.CORVI_TEST_LOUD ? "inherit" : "ignore"),
  });
  return { server, url: await waitForUrl(server) };
};

/** Stop the server and the terminal host it started, in the order a test's teardown needs: the
 * host outlives the server by design, so it is asked to shut down explicitly. */
export const stopTestServer = async (
  server: ReturnType<typeof Bun.spawn> | undefined,
  tmp: string,
): Promise<void> => {
  if (server !== undefined) {
    server.kill();
    await server.exited.catch(() => undefined);
  }
  await stopRunHost(tmp);
};

/** How contended the machine is right now, as a multiplier: 1 on an idle box, up to 4 when it is
 * oversubscribed. The suite runs beside whatever else is on the machine — agents, browsers,
 * editors — and a deadline tuned on an idle box is a cascade waiting to happen. The one-minute
 * load is measured against a quarter of the cores, so a machine busy enough to slow a browser
 * test down scales its deadlines. */
const loadFactor = (): number => {
  const cores = Math.max(1, cpus().length);
  const load = loadavg()[0] ?? 0;
  return Math.min(4, Math.max(1, load / Math.max(1, cores * 0.25)));
};

/** How long the suite is willing to wait, for a wait deadline or a test timeout alike.
 *
 * Waits are condition-driven throughout — a test never sleeps for a duration it guessed — but a
 * wait still needs a deadline, and that deadline is a claim about the machine's speed. `budget`
 * states each one normally (30s for a wait, 60s for a browser test) and scales them all by how
 * busy the machine is, plus `CORVI_TEST_WAIT_SCALE` for CI to state a factor of its own (`3`
 * triples every deadline and every test timeout) — instead of the tests growing deadlier guesses.
 * The scaling is multiplicative on purpose: a wait's deadline must stay inside its test's timeout,
 * and scaling both together keeps that true whatever the factor. */
export const budget = (ms: number): number =>
  Math.round(ms * loadFactor() * (Number(process.env.CORVI_TEST_WAIT_SCALE) || 1));

/** Poll until a value is what it should be. Waiting is condition-driven throughout: a test
 * never sleeps for a duration it guessed — a shell starting, a strip refreshing and a file
 * appearing each happen when they happen, so the tests wait for the fact. The 200ms step between
 * reads is the one timer, shared by every wait rather than repeated in each test; `budgetMs` is
 * a failure deadline (`budget(...)`, scaled for slow machines), never a guess at when the fact
 * arrives. The last value read comes back, so the expect after it can say what it saw. */
export const until = async <T>(
  read: () => Promise<T>,
  want: T,
  budgetMs = budget(30_000),
  stepMs = 200,
): Promise<T> => {
  const deadline = Date.now() + budgetMs;
  let last = await read();
  while (last !== want && Date.now() < deadline) {
    await Bun.sleep(stepMs);
    last = await read();
  }
  return last;
};

/** Wait for a condition that is a gate rather than an assertion: on a timeout it names what
 * never happened and how long it waited for it, where the expect after it could only say "the
 * file was missing". */
export const waitFor = async (
  what: string,
  read: () => Promise<boolean>,
  budgetMs = budget(30_000),
): Promise<void> => {
  if (!(await until(read, true, budgetMs))) {
    throw new Error(`timed out waiting for ${what} (after ${budgetMs}ms)`);
  }
};

/** The console and page errors of each watched page. A failure is often explained by what the
 * page said before the expect, and `page` reads nothing from the past unless it listened. */
const consoleLines = new WeakMap<Page, string[]>();

/** Start recording a page's console errors and page errors for the failure record. Idempotent, so
 * every creation path can call it without knowing whether another already did. */
export const watchPage = (page: Page): Page => {
  if (consoleLines.has(page)) return page;
  const lines: string[] = [];
  consoleLines.set(page, lines);
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      if (lines.length < 200) lines.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    if (lines.length < 200) lines.push(`pageerror: ${error.message}`);
  });
  return page;
};

/** One artifact's file-system stem: the page's path, made safe and recognisable. */
const artifactStem = (label: string, page: Page): string => {
  let path = "";
  try {
    const url = new URL(page.url());
    path = url.protocol === "http:" || url.protocol === "https:" ? url.pathname : "";
  } catch {
    path = "";
  }
  const slug = `${label}-${path}`
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 80);
  return slug === "" ? "page" : slug;
};

/** What a page looked like: the measurements a failing layout expect would otherwise have to
 * restate, and the metrics that say which box is overflowing which. Computed styles are read for
 * the properties the shell's flex chain depends on. */
const pageRecord = async (page: Page): Promise<Record<string, unknown>> => {
  const selectors = [
    ".app",
    ".app-body",
    ".content",
    ".page",
    ".change-chrome",
    ".change-tabs",
    ".window-tabs",
    ".widgets",
    ".column",
    ".widget",
    ".md-editor",
  ];
  const layout = await page
    .evaluate((wanted: string[]) => {
      const boxOf = (element: Element): Record<string, unknown> => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          tag: element.tagName.toLowerCase(),
          class: element.className,
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          scrollWidth: (element as HTMLElement).scrollWidth,
          scrollHeight: (element as HTMLElement).scrollHeight,
          clientWidth: (element as HTMLElement).clientWidth,
          clientHeight: (element as HTMLElement).clientHeight,
          display: style.display,
          position: style.position,
          overflowY: style.overflowY,
          minHeight: style.minHeight,
          heightStyle: style.height,
          flex: style.flex,
        };
      };
      return wanted.map((selector) => {
        const element = document.querySelector(selector);
        return element === null
          ? { selector, present: false }
          : { selector, present: true, ...boxOf(element) };
      });
    }, selectors as string[])
    .catch(() => []);

  return {
    url: page.url(),
    viewport: page.viewportSize(),
    document: await page
      .evaluate(() => ({
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        contentScrollTop: document.querySelector<HTMLElement>(".content")?.scrollTop ?? null,
        activeElement:
          document.activeElement === null
            ? null
            : `${document.activeElement.tagName.toLowerCase()}.${document.activeElement.className}`,
      }))
      .catch(() => null),
    layout,
    console: consoleLines.get(page) ?? [],
  };
};

/** Write the screenshot, the DOM and the measurements under `CORVI_TEST_ARTIFACTS`, where CI
 * uploads them on a failed run. Used both for a page a test threw on and for the pages left open
 * at the end of a file. */
const recordPage = async (page: Page, stem: string): Promise<void> => {
  const directory = process.env.CORVI_TEST_ARTIFACTS;
  if (directory === undefined) return;
  const base = join(directory, stem);
  const record = await pageRecord(page).catch(() => ({
    url: page.url(),
    console: consoleLines.get(page) ?? [],
  }));
  await writeFile(`${base}.json`, JSON.stringify(record, null, 2)).catch(() => undefined);
  await page.screenshot({ path: `${base}.png` }).catch(() => undefined);
  await page
    .content()
    .then((html) => writeFile(`${base}.html`, html))
    .catch(() => undefined);
};

/** Leave evidence for a page a test threw on, without replacing that test's own failure. */
export const capturePageFailure = async (page: Page, error: unknown): Promise<void> => {
  const directory = process.env.CORVI_TEST_ARTIFACTS;
  if (directory === undefined) return;
  try {
    await mkdir(directory, { recursive: true });
    const stem = `${artifactStem("failure", page)}-${Date.now()}`;
    await recordPage(page, stem);
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    await writeFile(join(directory, `${stem}-error.txt`), `${message}\n`).catch(() => undefined);
  } catch {
    // Evidence must never replace the failure it is evidence of.
  }
};

/** Close every page the browser still has open — and record each one first when
 * `CORVI_TEST_ARTIFACTS` names a directory (CI uploads it on failure), so a failed test leaves
 * what it saw behind it rather than only what its expects could say. A test that fails mid-way
 * often skips its own `page.close()`: the pages still open at this moment are exactly the ones
 * worth keeping and closing, because a page left open keeps its pty attached and the next
 * test's client-count gates could never be satisfied. */
export const closePages = async (browser: Browser | undefined, label: string): Promise<void> => {
  const directory = process.env.CORVI_TEST_ARTIFACTS;
  const pages = (browser?.contexts() ?? []).flatMap((context) => context.pages());
  if (directory !== undefined && pages.length > 0) {
    await mkdir(directory, { recursive: true });
    for (const [index, page] of pages.entries()) {
      await recordPage(page, `${artifactStem(label, page)}-${Date.now()}-${index}`);
    }
  }
  for (const page of pages) await page.close().catch(() => undefined);
};

/** Wait until the page has stopped laying itself out: fonts are loaded, and the document and the
 * scrollable content keep the same size for a quiet window. A single read after `waitForSelector`
 * can land before a sibling card's first answer or a font's swap, which is what turns a layout
 * assertion into a flaky one. */
export const settleLayout = async (page: Page, budgetMs = budget(5_000)): Promise<void> => {
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await page.waitForFunction(
    (quietMs: number) => {
      const state = window as unknown as { __corviSettle?: { key: string; since: number } };
      const content = document.querySelector<HTMLElement>(".content");
      const key = [
        window.innerWidth,
        window.innerHeight,
        document.documentElement.scrollWidth,
        document.documentElement.scrollHeight,
        content?.scrollWidth ?? -1,
        content?.scrollHeight ?? -1,
        content?.clientWidth ?? -1,
        content?.clientHeight ?? -1,
      ].join(":");
      const now = performance.now();
      const since = state.__corviSettle?.key === key ? state.__corviSettle.since : now;
      state.__corviSettle = { key, since };
      return now - since >= quietMs;
    },
    budget(300),
    { polling: "raf", timeout: budgetMs },
  );
};

/** The newest mtime among the files under a directory; 0 when there is nothing there. */
const newestFile = (dir: string): number => {
  let newest = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir, { recursive: true, encoding: "utf8" });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const stat = statSync(join(dir, entry));
    if (stat.isFile() && stat.mtimeMs > newest) newest = stat.mtimeMs;
  }
  return newest;
};

/** The page tests read their UI in the built bundle (`apps/web/dist`), not in the sources it is
 * built from — and a bare `bun test` after an edit runs whatever the last build left, so every
 * page assertion then reads yesterday's UI with nothing to say so
 * (docs/guides/testing.md). This is the tripwire: before a page is driven, a bundle older than
 * the newest source is refused, and the message names the build that fixes it. `bun run test`
 * builds first and cannot trip it. The web directory is a parameter so a fixture can pin the
 * rule (test/webBundle.test.ts). */
export const requireFreshWebBundle = (webDir: string = join(import.meta.dir, "..", "apps", "web")): void => {
  const sources = newestFile(join(webDir, "src"));
  const built = newestFile(join(webDir, "dist"));
  if (built === 0 || sources > built) {
    throw new Error(
      "apps/web/dist is stale — older than apps/web/src, so the page tests would serve old UI. " +
        "Run `bun run build:web` first (or `bun run test`, which builds).",
    );
  }
};

/** A port nothing listens on yet: bind port 0, take the number, close the probe. */
export const reservePort = async (): Promise<number> => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
};

/** The viewport the page tests drive, and the numbers a layout assertion reads. */
export const VIEWPORT = { width: 1280, height: 900 } as const;

/** Whether the browser is installed on this machine. A missing browser is a skip, not a failure:
 * the rest of Corvi works without one, so a red suite would only report the machine. */
export const browserAvailable = async (): Promise<boolean> => {
  try {
    return await Bun.file(chromium.executablePath()).exists();
  } catch {
    return false;
  }
};

/** The browser a page test drives: Chromium, because the app's window is Electron and Electron is
 * Chromium. It is headless unless `CORVI_HEADED=1` asks to watch it, as `bun run test:e2e:headed`
 * does — CI has no display, so headless is what the suite is judged in. The flags keep a window that
 * other windows cover compositing, so a watched run shows the page the test reads rather than a
 * frame from whenever it last painted. */
export const launchBrowser = (): Promise<Browser> =>
  chromium.launch({
    headless: !process.env[env("HEADED")],
    args: ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
  });

/** Fill the caller's `let browser: Browser` with the engine a page test drives. A bundle older than
 * the web sources is refused before the browser starts — a page test must not read yesterday's UI.
 * Tests guard on `usable` before using the browser; a browser that cannot launch is a skip. */
export const openBrowser = async (assign: (browser: Browser) => void): Promise<boolean> => {
  if (!(await browserAvailable())) return false;
  // A stale bundle is a failure, not a skip: the browser is there and the page would be old.
  requireFreshWebBundle();
  try {
    assign(await launchBrowser());
    return true;
  } catch {
    return false;
  }
};

/** Run `body` on a fresh page at the shared viewport, closing it whatever happens. A page that is
 * not closed keeps its pty attached and the next test's client gates cannot be satisfied. */
export const withPage = async <T>(
  browser: Browser,
  body: (page: Page) => Promise<T>,
  viewport: { readonly width: number; readonly height: number } = VIEWPORT,
): Promise<T> => {
  const page = watchPage(await browser.newPage({ viewport }));
  try {
    return await body(page);
  } catch (error) {
    // The page is closed below; without this the failure leaves only the expect's numbers.
    await capturePageFailure(page, error);
    throw error;
  } finally {
    await page.close().catch(() => undefined);
  }
};

/** Open a change's first terminal window the way a person does: the row's "+" tab, then `1` in
 * the dialog. A window is created only by an explicit open, so a test that expects a shell opens
 * one rather than relying on arriving at the page. The page is a change's page already — the tab
 * row is what carries the "+" — and the dialog's success leaves it on the terminal view, where
 * the pane attaches to the window it just made. */
export const openFirstWindow = async (page: Page): Promise<void> => {
  await page.locator(".change-tabs button.window-tab.new").click();
  await page.waitForSelector(".new-terminal-dialog[open]");
  await page.keyboard.press("1");
  await page.waitForSelector(".new-terminal-dialog[open]", { state: "detached" });
  await page.waitForSelector(".change-tabs [data-window-index]");
};

/**
 * The one seam between the Promise-shaped tests and the Effect API.
 *
 * The server's modules are Effects, and where a call shells out the environment comes from the
 * request's `Workspace` tag (apps/server/src/capabilities/shell.ts). Tests are Promise-shaped by contract, so they run the
 * Effect here rather than through a request: this provides the capability services, the tag
 * included, and hands back a Promise. Nothing else in the test suite needs to know about layers.
 */

/** Run an effect as the default workspace, with the capability services in place. An effect
 * that requires nothing is one that requires fewer capabilities, so the same helper serves both
 * the pure effects and the ones that go through `Changes` or `Shell`. */
export const runEffect = <A, E>(effect: Effect.Effect<A, E, Capabilities>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, capabilitiesLayer(workspaceById(undefined))));

/** The same, as the workspace named: for the tests that exercise per-workspace behaviour. */
export const runEffectWith = <A, E>(workspace: Workspace, effect: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, capabilitiesLayer(workspace)));

/** Run an effect under Effect's `TestClock`, where time moves only when the effect advances it
 * with `TestClock.adjust`. The capabilities are merged in as `runEffect` does, so the same effect
 * that runs in a request also runs here.
 *
 * The test clock starts at the wall clock's `now`: the cache's `ageOf` stays synchronous and on
 * the wall clock by contract, so a freshly produced entry must still read as fresh next to it.
 * Only relative advances matter, so the tests reason in offsets and behave the same at any date. */
export const runEffectWithTestClock = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(
    Effect.andThen(TestClock.setTime(Date.now()), effect).pipe(
      Effect.provide(
        Layer.merge(
          Layer.mergeAll(TestConsole.layer, TestClock.layer()),
          capabilitiesLayer(workspaceById(undefined)),
        ),
      ),
    ),
  );

/** A typed stand-in for a failed vendor in a test: the language service forbids a global
 * `Error` in an Effect failure channel, and the code under test only reads its message. */
export class TestError extends Schema.TaggedError<TestError>()("TestError", {
  message: Schema.String,
}) {}

/** Open the `gh` gate again. The rate limit it learned belongs to the token, so it outlives a
 * test's scripted failures: a test that scripts one starts from an open gate. */
export { forgetRateLimit } from "@corvi/github/rate-limit";

/** A command a fake Shell was asked to run, in the order it was asked. */
export type ShellCall = { cmd: readonly string[]; cwd?: string };

/** A scripted Shell. `responses` maps a command line (`cmd.join(" ")`) to what it answers: a
 * string is stdout with exit 0, and an object may set `code`, `stdout` and `stderr`. The function
 * form is there for a command whose answer differs per call. Commands with no scripted answer
 * exit 0 with empty output, and every call lands in `calls` — the commands asked for, which a
 * test asserts against to prove a core read went through the seam. */
export type FakeShell = {
  calls: ShellCall[];
  run: (
    cmd: readonly string[],
    opts?: { cwd?: string },
  ) => Effect.Effect<ShellResult, CliError, WorkspaceTag>;
};

/** What `az devops configure -l` prints on a machine set up for organisation
 * `https://dev.azure.com/org` and project `proj`. */
export const AZ_CONFIGURED = "organization = https://dev.azure.com/org\nproject = proj\n";

/** The answers an Azure DevOps read of a repository's pipelines takes for granted: `az` configured
 * (`AZ_CONFIGURED`), and a checkout whose `origin` is the GitHub repository `nameWithOwner`.
 * Undefined for any other command line, so a scripted Shell chains it with `??`. */
export const azureCheckoutAnswer =
  (nameWithOwner: string) =>
  (line: string): string | undefined => {
    if (line === "az devops configure -l") return AZ_CONFIGURED;
    if (line === "git remote get-url origin") return `git@github.com:${nameWithOwner}.git\n`;
    return undefined;
  };

/** Build a scripted Shell (see `FakeShell`). */
export const fakeShell = (
  responses:
    | Record<string, string | Partial<ShellResult>>
    | ((cmd: readonly string[]) => string | Partial<ShellResult> | undefined) = {},
): FakeShell => {
  const calls: ShellCall[] = [];
  const answer = (cmd: readonly string[]): ShellResult => {
    const scripted = typeof responses === "function" ? responses(cmd) : responses[cmd.join(" ")];
    if (scripted === undefined) return { code: 0, stdout: "", stderr: "" };
    if (typeof scripted === "string") return { code: 0, stdout: scripted, stderr: "" };
    return {
      code: scripted.code ?? 0,
      stdout: scripted.stdout ?? "",
      stderr: scripted.stderr ?? "",
    };
  };
  return {
    calls,
    run: (cmd, opts) => {
      calls.push({ cmd: [...cmd], cwd: opts?.cwd });
      return Effect.succeed(answer(cmd));
    },
  };
};

/** Run an effect with a fake Shell in place of the real one, as the default workspace. The
 * workspace tag is provided alongside the Shell because the Shell service's `run` requires it,
 * exactly as the host provides both. `sh` reads the Shell from context and delegates, so a core
 * integration function can be driven with no subprocess. Extension effects additionally read
 * `Cache`, `Settings` and `Changes` from context, so those ride along with their live layers. */
export const runWithShell = <A, E, R>(shell: FakeShell, effect: Effect.Effect<A, E, R>): Promise<A> =>
  Effect.runPromise(
    Effect.provide(
      effect as Effect.Effect<A, E, never>,
      Layer.mergeAll(
        Layer.succeed(Shell, shell),
        Layer.succeed(WorkspaceTag, workspaceById(undefined)),
        CacheLive,
        SettingsLive,
        ChangesLive,
        GitFactsLive,
      ),
    ),
  );

/** `runWithShell` with a failure captured as a `Result` instead of rejecting: the shape a test
 * asserts a typed failure's fields from. */
export const runWithShellEither = <A, E, R>(
  shell: FakeShell,
  effect: Effect.Effect<A, E, R>,
): Promise<Result.Result<A, E>> => runWithShell(shell, Effect.result(effect));

/** The same, as the workspace named: for the tests that exercise per-workspace behaviour, such
 * as a budget that belongs to one workspace's token and not another's. */
export const runWithShellAs = <A, E, R>(
  workspace: Workspace,
  shell: FakeShell,
  effect: Effect.Effect<A, E, R>,
): Promise<A> =>
  Effect.runPromise(
    Effect.provide(
      effect as Effect.Effect<A, E, never>,
      Layer.mergeAll(
        Layer.succeed(Shell, shell),
        Layer.succeed(WorkspaceTag, workspace),
        CacheLive,
        SettingsLive,
        ChangesLive,
        GitFactsLive,
      ),
    ),
  );

/** `runWithShell` under Effect's `TestClock`, which starts at the wall clock: a test that waits
 * for a deadline — a gate that reopens at a reset — advances it with `TestClock.adjust` instead
 * of sleeping. */
export const runWithShellWithTestClock = <A, E, R>(
  shell: FakeShell,
  effect: Effect.Effect<A, E, R>,
): Promise<A> =>
  Effect.runPromise(
    Effect.andThen(TestClock.setTime(Date.now()), effect as Effect.Effect<A, E, never>).pipe(
      Effect.provide(
        Layer.mergeAll(
          TestConsole.layer,
          TestClock.layer(),
          Layer.succeed(Shell, shell),
          Layer.succeed(WorkspaceTag, workspaceById(undefined)),
          CacheLive,
          SettingsLive,
          ChangesLive,
          GitFactsLive,
        ),
      ),
    ),
  );

/** A route effect run with a scripted Shell, mapped to a Response exactly as the server maps it
 * (`runRoute`'s error handling), so a route's readiness path can be exercised without the real
 * CLI. Pair with `withChangeEffect` for the request plumbing. */
export const runRouteWithShell = (
  shell: FakeShell,
  effect: Effect.Effect<Response, unknown>,
): Promise<Response> =>
  Effect.runPromise(
    Effect.provide(
      effect.pipe(
        Effect.catch((error) => Effect.succeed(toResponse(error))),
        Effect.catchDefect((defect) => Effect.succeed(toResponse(defect))),
      ),
      Layer.mergeAll(
        Layer.succeed(Shell, shell),
        Layer.succeed(WorkspaceTag, workspaceById(undefined)),
        CacheLive,
        SettingsLive,
        ChangesLive,
        GitFactsLive,
      ),
    ),
  );

type GuardedHandler = (req: Request, server?: unknown) => Promise<Response>;
type GuardedTable = Record<string, Partial<Record<string, GuardedHandler>>>;

/** Call a `guard`ed route table by its method and pattern, with the path parameters Bun's router
 * would have filled in and a same-origin request. The route tables are structural values, so this
 * keeps the one cast here rather than in every test. */
export const callGuarded = (
  routes: unknown,
  method: string,
  path: string,
  options: {
    readonly params?: Record<string, string>;
    readonly body?: unknown;
    readonly headers?: Record<string, string>;
  } = {},
): Promise<Response> => {
  const handler = (routes as GuardedTable)[path]?.[method];
  if (handler === undefined) return Promise.reject(new Error(`no ${method} ${path}`));
  const req = new Request(`http://127.0.0.1:4000${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  Object.assign(req, { params: options.params ?? {} });
  return handler(req);
};

/** A failed `Result`, or a thrown error when the test expected a failure and got a success. The
 * one narrowing for the many `Result.isFailure` blocks. */
export const failureOf = <A, E>(
  result:
    { readonly _tag: "Success"; readonly success: A } | { readonly _tag: "Failure"; readonly failure: E },
): E => {
  if (result._tag === "Success") throw new Error("expected a failed result");
  return result.failure;
};

/** One CLI call, Promise-shaped for the tests: a timed-out CLI is exit code 124, so tests
 * branch on `code` exactly as the server does. */
export const runSh = (cmd: readonly string[], cwd?: string): Promise<ShellResult> =>
  runEffect(
    sh(cmd, cwd).pipe(
      Effect.catch((e) => Effect.succeed({ code: e.exitCode, stdout: "", stderr: e.stderr })),
    ),
  );

/** The stale-while-revalidate cache, around a test's Promise-shaped work. */
export const runSwr = <T>(key: string, ttl: number, work: () => Promise<T>): Promise<T> =>
  runEffect(
    swr(
      key,
      ttl,
      Effect.tryPromise<T, TestError>({
        try: work,
        catch: (e) => new TestError({ message: e instanceof Error ? e.message : String(e) }),
      }),
    ),
  );

/** Editing a change's repositories, in the duck the tests read: the Effect API answers in a
 * tagged union (apps/server/src/vendors/git.ts), and the tests read `{ change }` / `{ needsForce }`. */
export const runSetRepos = async (
  ...args: Parameters<typeof setRepos>
): Promise<{ change: import("@corvi/changes/record").Change } | { needsForce: string[] }> => {
  const result = await runEffect(setRepos(...args));
  return result._tag === "Done" ? { change: result.change } : { needsForce: result.needsForce };
};

/** The checkout specs a list of source paths becomes: worktrees on the change's branch, unless
 * a path is named in place or given a base — the shape `ChangeDraft` and the request bodies
 * carry. `base` becomes both where the branch starts and what a pull request merges into, which
 * is what one field meant before they were split. */
export const checkoutsOf = (
  paths: string[],
  direct: string[] = [],
  base: Record<string, string> = {},
): import("@corvi/contracts/api").CheckoutSpecDto[] =>
  paths.map((path) => ({
    path,
    location: direct.includes(path) ? ("original" as const) : ("new" as const),
    branch: { kind: "change" as const },
    ...(base[path] !== undefined ? { base: base[path], target: base[path] } : {}),
  }));

/** Cancelling a change, in the duck the tests read: the Effect API answers in a tagged union
 * (`{ _tag: "Done" }` / `{ _tag: "NeedsForce" }`), and the tests read `{ change, loose }` /
 * `{ needsForce }`. */
export const runCancel = async (
  ...args: Parameters<typeof cancelChange>
): Promise<
  | { change: Change; loose: string[] }
  | { needsForce: string[]; reasons: { repository: string; text: string }[] }
> => {
  const result = await runEffect(cancelChange(...args));
  return result._tag === "Done"
    ? { change: result.change, loose: result.loose }
    : { needsForce: result.needsForce, reasons: result.reasons };
};

/** What is uncommitted in one repository, Promise-shaped for the tests. */
export const runLocalChanges = (...args: Parameters<typeof localChanges>): Promise<LocalStatus> =>
  runEffect(localChanges(...args));

/** One file's diff, Promise-shaped for the tests. */
export const runFileDiff = (...args: Parameters<typeof fileDiff>): Promise<string> =>
  runEffect(fileDiff(...args));

/** Recent builds of a service, Promise-shaped for the tests. */
export const runVersionsFor = (...args: Parameters<typeof versionsFor>): Promise<Buildable[]> =>
  runEffect(versionsFor(...args));

/** Triggering a deploy, Promise-shaped for the tests. */
export const runDeploy = (...args: Parameters<typeof deploy>): Promise<{ runId: number; url?: string }> =>
  runEffect(deploy(...args));

/** Move a change to the archive the way the lifecycle does: a terminal transition through the
 * capability store, which sets `completedAt` and renames the directory. The store accepts any
 * phase, so a fixture does not need a change that could pass the completion's readiness checks. */
export const archiveViaStore = (id: string): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const store = yield* ChangeStore;
    const current = yield* store.read(ChangeId.make(id));
    if (!current) return;
    yield* store.patch(ChangeId.make(id), {
      phase: "Completed",
      completedAt: new Date().toISOString(),
      expectedRevision: current.revision ?? 0,
    });
  }).pipe(Effect.provide(storeLayer({ roots: changePairs() })), Effect.asVoid);
