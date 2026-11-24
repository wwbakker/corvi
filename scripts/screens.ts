/**
 * Screenshots of every surface the catalog names, from two revisions, in one deterministic
 * environment: the comparison walk, `bun run screens`.
 *
 *   bun run screens                        # against the branch point with main
 *   bun run screens --against <ref>        # any revision: main, origin/main, a sha, HEAD~1
 *   bun run screens --only dashboard       # one surface, while iterating
 *   bun run screens --headed               # watch it happen
 *   bun run screens --keep                 # say where the fixture is instead of removing it
 *   bun run screens --fail-on-diff         # a pre-release check: any difference is non-zero
 *
 * What this file is: the comparison walk. It makes the fixture, starts the server that answers
 * it, builds and serves the base revision's page bundle, captures each surface from both sides,
 * compares the two images and writes the gallery that puts them side by side. What it is not:
 * the capture itself — the browser, the environment, the readiness wait, the setup, the data
 * wait and the no-baseline findings live in `scripts/screen-capture.ts`, shared with
 * `bun run shot` — and not the live walk: a running instance's pages are `bun run shot`'s
 * business, and that command compares nothing. The catalog's `live` entries (the terminal page,
 * the Appearance section) are skipped here and named in the output, because a picture of them
 * would be a picture of the fixture's shell rather than a comparison.
 *
 * Each surface is captured twice — from the current revision and from the page bundle built out
 * of `--against`'s `apps/web/src` — and compared with `pixelmatch`. Both captures talk to the one
 * server this run starts, so the API, the fixture and every rendered path are the same on both
 * sides; the base page is served by a small `Bun.serve` that forwards everything but its own
 * files to that server. Whether a surface is new is the base revision's own route table's answer
 * (`viewOf` in its extracted `apps/web/src/app-root/navigation.ts`), not a readiness timeout: the
 * base may render a page with markup this checkout's selector no longer matches, and a base
 * capture that fails on a surface the base does have is reported as `failed on the base` with its
 * own findings, never as `new`. A surface that does not arrive on the current revision is fatal.
 *
 * The page bundle it serves is built into the run's own temp directory and named with
 * `CORVI_WEB_DIST`, never the shared `apps/web/dist`.
 *
 * ## What this does not see
 *
 * A surface the base revision had and today's catalog no longer lists is not seen at all: the walk
 * is driven by today's catalog, and nothing asks the base what it offered. Seeing one would mean
 * walking the base's own route table and page list (its `navigation.ts` and the `/api/pages` the
 * server this run talks to answers) and reporting a route that exists there and has no entry here
 * — the mirror of the coverage finding below. That is a later entry, not part of this tool yet;
 * until then, a removed page is a gap the gallery cannot show.
 *
 * What a live instance shows is not seen either, by design: the fixture's answers stand in for
 * Azure DevOps, GitHub and the shell. `scripts/shot.ts` is the walk that looks at a real
 * instance.
 *
 * One run at a time: `shots/screens.lock` names the run that holds the fixed fixture and output.
 *
 * ## The fixture
 *
 * A git repository, its commit pinned (dates and identity) so the hash the change shows is the
 * same every time, and two changes created through the API whose dates are then fixed to the
 * instant the page's frozen clock is about. The actions, harnesses and profiles are files written
 * beside that config before the server starts. Azure DevOps's page, the two dashboard cards
 * whose rows need a login and the overview card's server-computed facts row are answered on the
 * page (`stubFixtureServices`), so no picture is a report of this machine's CLI or its `gh`/`az`
 * — those answers belong to this walk, not to the capture, because a live walk must never
 * photograph stub data.
 *
 * Findings: the capture's own are collected per surface and reported here. A surface that never
 * arrived, a page still drawing a placeholder, a console or page error and a page or tab the
 * server offers without an entry all fail the run; clipping is reported and does not fail yet.
 */
import { mkdir, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import type { BrowserContext, Route } from "playwright";
import { testTempBase } from "./test-temp.ts";
import { compareImages, type Comparison } from "./screen-compare.ts";
import { captureSurface, takeActiveBrowser, type Finding } from "./screen-capture.ts";
import { releaseLock, takeLock } from "./screen-lock.ts";
import { cleanupOnce, installSignalCleanup } from "./run-lifecycle.ts";
import { CHANGE, IDEA, SURFACES, changeRoute, fileNameOf, type Surface } from "./screen-catalog.ts";

/** The instant every relative time on the page is measured from: a settled Friday afternoon, so
 * `3h ago` and a progress bar's elapsed time read the same on every run. */
const NOW = new Date("2026-11-20T12:00:00.000Z");

/** The dates the fixture's changes carry, written over the ones the API stamps at creation. */
const ACTIVE_CREATED = "2026-11-20T09:00:00.000Z";
const ACTIVE_STARTED = "2026-11-20T09:05:00.000Z";
const IDEA_CREATED = "2026-11-20T10:30:00.000Z";

/** The fixture's git identity and commit date: a commit's hash is in the change's title row and
 * in its roster of repositories, so a wall-clock timestamp would change the picture. */
const GIT_DATE = "2026-11-20T09:00:00 +0000";
const GIT_NAME = "Corvi fixture";
const GIT_EMAIL = "fixture@corvi.test";

/** The fixture's roots. Fixed on purpose (see the header): a per-run path would be printed by
 * several pages, and the differing path lengths would reflow the cards that print it. Absolute,
 * because the server refuses a relative root and the config file records these paths. */
const FIXTURE = resolve("shots", "fixture");
const FIXTURE_CHANGES = join(FIXTURE, "changes");
const FIXTURE_ARCHIVE = join(FIXTURE, "changes-archive");
const FIXTURE_CONFIG = join(FIXTURE, "config.json");

/** Where the images go, from the repository root. The finished run's directory, replaced as a
 * whole only once its gallery is complete. */
const OUT = join("shots", "screens");

/** Where this run writes while it walks: a staging directory beside the published one, so a run
 * that dies before its gallery leaves the previous `OUT` — gallery and all its pictures — intact.
 * The lock makes one fixed staging path safe. */
const STAGE = join("shots", "screens.next");

/** The run's exclusive lock, beside the fixture it guards. */
const LOCK = resolve("shots", "screens.lock");

const argv = process.argv.slice(2);
const has = (name: string): boolean => argv.includes(`--${name}`);

/** Every flag this command knows. An unknown one is refused rather than ignored: a typo like
 * `--agains main` would otherwise fall through to a full run against the default base, which is a
 * minute of the wrong comparison. */
const KNOWN_FLAGS: ReadonlySet<string> = new Set([
  "--only",
  "--against",
  "--headed",
  "--keep",
  "--fail-on-diff",
]);
const unknownFlag = argv.find((argument) => argument.startsWith("--") && !KNOWN_FLAGS.has(argument));
if (unknownFlag !== undefined) {
  console.error(`screens: unknown flag ${unknownFlag}; known flags are ${[...KNOWN_FLAGS].join(", ")}`);
  process.exit(2);
}

/** A flag's value, refused when it is missing: a bare `--only` would otherwise mean "everything",
 * which is the opposite of what it asks for. */
const valueOf = (name: string, wants: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return undefined;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`--${name} wants ${wants}`);
    process.exit(2);
  }
  return value;
};

/** Every flag is read and checked here, before anything is written: a run that refuses its
 * arguments must not have cleared the last gallery first. */
const only = valueOf("only", "a surface name or part of one (e.g. --only dashboard)");
const against = valueOf("against", "a revision to compare against (e.g. --against HEAD~1)");
const headed = has("headed");
const keep = has("keep");
const failOnDiff = has("fail-on-diff");

/** The surfaces this walk captures, in catalog order: every entry a fixture can show. A `live`
 * entry needs a running instance (a real shell, the settings tree's own state) and is named in
 * this run's output rather than silently dropped. A name that matches nothing is refused before
 * the output is touched, too. */
const walkable = SURFACES.map((surface, index) => ({ surface, index })).filter(
  ({ surface }) => !surface.live,
);
const selected = walkable.filter(({ surface }) => only === undefined || surface.name.includes(only));
if (selected.length === 0) {
  const live = SURFACES.filter((s) => s.live === true && (only === undefined || s.name.includes(only)));
  if (live.length > 0) {
    const names = live.map((surface) => surface.name).join(", ");
    console.error(
      `${names} ${live.length === 1 ? "is a live surface" : "are live surfaces"}: bun run shot captures ${live.length === 1 ? "it" : "them"} against a running instance`,
    );
    process.exit(2);
  }
  console.error(`no surface name contains "${only ?? ""}": ${SURFACES.map((s) => s.name).join(", ")}`);
  process.exit(2);
}

/** The entries this walk leaves to `bun run shot`, named in a whole run's output so the skip is
 * never silent. A partial run (`--only`) names only the entries it was asked about. */
const liveOnly = SURFACES.map((surface, index) => ({ surface, index })).filter(
  ({ surface }) => surface.live === true && (only === undefined || surface.name.includes(only)),
);

/** The shared spawn-and-wait helpers (`test/helpers.ts`). Imported here rather than at the top of
 * the file, because the module makes its own root from the run token as it loads. */
const { checkoutsOf, startTestServer, stopTestServer, testRun, testTempDir } =
  await import("../test/helpers.ts");

/** The services the Azure DevOps page draws, in the shape its own route answers with: one
 * settled environment and one deploy in flight, so the picture has a table with rows and a
 * progress bar rather than an unconfigured hint. */
const AZURE_SERVICES = {
  services: [
    {
      name: "example-api",
      pipeline: { id: 1, name: "deploy-example-api" },
      build: { id: 2, name: "build-example-api" },
      environments: [
        {
          environment: "accept",
          version: "20261120.7",
          at: "2026-11-20T11:57:00.000Z",
          state: "pending",
          detail: "deploying 20261120.7",
          url: "https://dev.azure.com/example/proj/_build/results?buildId=9",
          expectedMs: 10 * 60_000,
        },
        {
          environment: "production",
          version: "20261119.3",
          at: "2026-11-19T15:20:00.000Z",
          state: "ok",
          detail: "a day ago",
        },
      ],
    },
    {
      name: "example-service",
      pipeline: { id: 3, name: "deploy-example-service" },
      build: { id: 4, name: "build-example-service" },
      environments: [
        {
          environment: "accept",
          version: "20261120.6",
          at: "2026-11-20T08:10:00.000Z",
          state: "ok",
          detail: "3h ago",
          url: "https://dev.azure.com/example/proj/_build/results?buildId=7",
        },
        {
          environment: "production",
          version: "20261120.6",
          at: "2026-11-20T07:40:00.000Z",
          state: "ok",
          detail: "4h ago",
        },
      ],
    },
  ],
};

/** The dashboard's GitHub rows for one repository: a pull request that is green, answered on the
 * page because the card's own read needs `gh` and a login this machine may not have. */
const GITHUB_CARD = {
  items: [
    {
      label: "example-api",
      state: "ok",
      children: [
        {
          label: "#128 Add the media queries",
          detail: "approved · checks 14/14",
          state: "ok",
          url: "https://github.com/example/example-api/pull/128",
          children: [
            { label: "build", detail: "2m10s", state: "ok" },
            { label: "test (linux)", detail: "5m02s", state: "ok" },
            { label: "test (macos)", detail: "4m48s", state: "ok" },
          ],
        },
      ],
    },
  ],
};

/** The dashboard's Azure DevOps rows for one repository, for the same reason: the card reads
 * pipelines through `az`. */
const AZURE_CARD = {
  items: [
    {
      label: "example-api",
      state: "ok",
      children: [
        {
          label: "build-example-api",
          detail: "20261120.7 · 4m 12s",
          state: "ok",
          url: "https://dev.azure.com/example/proj/_build/results?buildId=8",
        },
        {
          label: "deploy-example-api",
          detail: "20261120.7 · 1m 40s",
          state: "ok",
          url: "https://dev.azure.com/example/proj/_build/results?buildId=9",
        },
      ],
    },
  ],
};

/** The overview card's facts row. Its content is computed server-side from this machine's `gh`
 * and `az` (`apps/server/src/dashboard/server/summary.ts`), so without this the row would be a
 * report of the machine and the moment rather than of the branch — the difference a comparison
 * must not show. The fixture answers it like the two dashboard cards: fixed text, both passes. */
const CHANGE_SUMMARY = {
  facts: [
    { id: "terminals", label: "terminals idle", state: "none" },
    { id: "github", label: "1 pull request · checks green", state: "ok" },
    { id: "azure-devops", label: "2 pipelines · 1 deploying", state: "ok" },
  ],
  state: "ok",
};

/** The fixture's answers to the reads that need a login or a tool this machine may not have:
 * Azure DevOps's deployments table, the dashboard's two cards and the overview card's facts row
 * (whose contributors run `gh` and `az` server-side). They are this walk's, given to the capture
 * as its `stub` — a live walk passes nothing, so `bun run shot` shows the instance's own answers
 * rather than these. */
const stubFixtureServices = async (context: BrowserContext): Promise<void> => {
  const answer =
    (json: unknown) =>
    (route: Route): Promise<void> =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
  await context.route("**/api/ext/azure-devops/services*", answer(AZURE_SERVICES));
  await context.route("**/api/changes/*/cards/github/items*", answer(GITHUB_CARD));
  await context.route("**/api/changes/*/cards/azure-devops/items*", answer(AZURE_CARD));
  await context.route("**/api/changes/*/summary*", answer(CHANGE_SUMMARY));
};

/** A file the fixture writes before the server reads it, with its directory made on the way. */
const writeFixtureFile = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};

/** One git command in the fixture, with the identity and the dates pinned: the same tree and the
 * same commit every run, so the hash the page shows does not move. */
const git = async (args: readonly string[], cwd?: string): Promise<void> => {
  const code = await Bun.spawn(
    ["git", "-c", `user.name=${GIT_NAME}`, "-c", `user.email=${GIT_EMAIL}`, ...args],
    {
      ...(cwd === undefined ? {} : { cwd }),
      env: { ...process.env, GIT_AUTHOR_DATE: GIT_DATE, GIT_COMMITTER_DATE: GIT_DATE },
      stdout: "ignore",
      stderr: "ignore",
    },
  ).exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed with ${code}`);
};

/** The plan text the change's page shows: a document, so the editor is the thing on screen rather
 * than its placeholder. */
const PLAN = `# Screenshot every page

The stylesheet is shared by every surface, and nothing in the suite says which of them moved when
it changes.

## What it does

- one list of surfaces, written down
- a capture with a frozen clock and a fixture
- a comparison of two revisions, read as pictures

## What it is not

A merge gate, and not a baseline: a person reads the gallery and decides.
`;

/** The fixture: a repository with one commit and a GitHub-looking origin, the global actions,
 * harnesses and profiles, a directory no change owns, and the two changes the pages are about. */
const makeFixture = async (url: string): Promise<void> => {
  const repo = join(FIXTURE, "example-api");
  await git(["init", "-b", "main", repo]);
  await writeFixtureFile(join(repo, "README.md"), "example-api\n");
  await writeFixtureFile(join(repo, "src", "server.ts"), "export const start = (): string => 'listening';\n");
  await git(["add", "."], repo);
  await git(["commit", "-m", "init"], repo);

  // The global files the Actions, Harnesses and Subagents pages list. Each is the smallest file
  // that parses, so the page shows rows rather than an empty hint.
  const configDir = dirname(FIXTURE_CONFIG);
  await writeFixtureFile(
    join(configDir, "actions", "sharpen-plan.md"),
    "---\nlabel: Sharpen the plan\nkind: prompt\ntarget: agent\nstart: pi\n---\n" +
      "Read {plan} for {id} and ask the three questions that would change it most.\n",
  );
  await writeFixtureFile(
    join(configDir, "actions", "summarise-changes.md"),
    "---\nlabel: Summarise the local changes\nkind: prompt\ntarget: active\n---\n" +
      "Say in a paragraph what changed in {id}, and what it is for.\n",
  );
  await writeFixtureFile(
    join(configDir, "harnesses", "review.md"),
    "---\nlabel: Review pane\nharness: pi\neffort: high\n---\n" +
      "Read the change's plan before you answer, and name the file you are talking about.\n",
  );
  await writeFixtureFile(
    join(configDir, "harnesses", "quick.md"),
    "---\nlabel: Quick answers\nharness: pi\n---\nShort answers, no preamble.\n",
  );
  await writeFixtureFile(
    join(configDir, "subagents", "reviewer.md"),
    "---\nlabel: Reviewer\nharness: pi\neffort: high\n---\nReview {plan} for {id}: correctness first, then tests.\n",
  );
  await writeFixtureFile(
    join(configDir, "subagents", "explorer.md"),
    "---\nlabel: Explorer\nharness: pi\n---\nFind where {title} is implemented, and say which files matter.\n",
  );

  // A directory in the changes root that no change owns: what the Leftovers page exists for.
  await writeFixtureFile(join(FIXTURE_CHANGES, "example-api-2f4c", "target", "build.log"), "built\n");
  await writeFixtureFile(join(FIXTURE_CHANGES, "example-api-2f4c", "notes.txt"), "a scratch note\n");

  const create = async (body: Record<string, unknown>): Promise<void> => {
    const response = await fetch(`${url}/api/changes`, { method: "POST", body: JSON.stringify(body) });
    if (!response.ok) {
      throw new Error(`creating ${String(body["id"])} failed: ${response.status} ${await response.text()}`);
    }
    const answer = (await response.json()) as {
      provision?: { integration: string; ok: boolean; error?: string }[];
    };
    for (const step of answer.provision ?? []) {
      if (step.ok) continue;
      throw new Error(
        `provisioning ${String(body["id"])} failed in ${step.integration}: ${step.error ?? ""}`,
      );
    }
  };
  await create({
    id: CHANGE,
    title: "Screenshot every page",
    branch: `${CHANGE}-x`,
    checkouts: checkoutsOf([repo]),
  });
  await create({ id: IDEA, title: "A visual check for the whole interface", state: "Ideation" });

  // A GitHub-looking origin, added once the change exists: provisioning would otherwise reach for
  // the network to fetch it, and the fixture has to work offline. The worktrees share it.
  await git(["remote", "add", "origin", "git@github.com:example/example-api.git"], repo);

  // One uncommitted edit in the change's worktree, so its local-changes pane shows a file, a
  // diff and a commit button rather than a clean tree.
  await writeFixtureFile(
    join(FIXTURE_CHANGES, CHANGE, "example-api", "README.md"),
    "example-api\n\nThe screenshot fixture changed this file to have something to review.\n",
  );

  // The plan is a document the change carries, written through its own route.
  const plan = await fetch(`${url}/api/changes/${encodeURIComponent(CHANGE)}/plan`, {
    method: "PUT",
    body: JSON.stringify({ text: PLAN }),
  });
  if (!plan.ok) throw new Error(`writing the plan failed: ${plan.status} ${await plan.text()}`);

  // The API stamps creation with the wall clock; the page renders ages against a frozen one, so
  // the record is given the dates the pictures are about.
  const redate = async (id: string, createdAt: string, startedAt?: string): Promise<void> => {
    const path = join(FIXTURE_CHANGES, id, "change.json");
    const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    record["createdAt"] = createdAt;
    if (startedAt !== undefined) record["startedAt"] = startedAt;
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
  };
  await redate(CHANGE, ACTIVE_CREATED, ACTIVE_STARTED);
  await redate(IDEA, IDEA_CREATED);
};

/** Remove what this run made, except what `--keep` asks to leave. The helper's root and pid file
 * are plumbing rather than the fixture a person wants to inspect, so they go either way. */
const removeRunPaths = async (token: string, tmp: string, kept: boolean): Promise<void> => {
  if (!kept) await rm(tmp, { recursive: true, force: true });
  const base = testTempBase();
  for (const entry of await readdir(base).catch(() => [])) {
    if (entry.startsWith(`corvi-${token}-root-`))
      await rm(join(base, entry), { recursive: true, force: true });
  }
  const pidFile = join(base, `corvi-${token}.pid`);
  const claimed = await readFile(pidFile, "utf8").catch(() => "");
  if (claimed.trim() === String(process.pid)) await unlink(pidFile).catch(() => undefined);
};

/** Kill the host the server started when the graceful shutdown did not take it (a handshake can
 * time out under load, and the host outlives its server by design), so no pty owner is left. */
const killHostByPid = async (tmp: string): Promise<void> => {
  try {
    const pid = Number(await readFile(join(tmp, "state", "corvi", "host.sock.pid"), "utf8"));
    if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
  } catch {
    // no host was started, or it is already gone
  }
};

/** Take away what importing `test/helpers.ts` makes before anything else runs — the process's own
 * root (named for the run, and recorded in `CORVI_ROOT`) and the run's pid-file. A run refused the
 * lock owns neither, and a refusal that left a temp dir behind would be the same leak it exists to
 * prevent. Only this process's own root is removed: it is identified by the environment the import
 * just wrote, not by a pattern that could match another run's. */
const removeUnstartedRun = async (token: string): Promise<void> => {
  const base = resolve(testTempBase());
  const root = process.env.CORVI_ROOT;
  if (root !== undefined) {
    const own = dirname(resolve(root));
    if (dirname(own) === base && basename(own).startsWith(`corvi-${token}-root-`)) {
      await rm(own, { recursive: true, force: true });
    }
  }
  const pidFile = join(base, `corvi-${token}.pid`);
  const claimed = await readFile(pidFile, "utf8").catch(() => "");
  if (claimed.trim() === String(process.pid)) await unlink(pidFile).catch(() => undefined);
};

/** Set by a signal: the walk stops rather than starting a surface whose teardown already ran. */
let interrupted = false;

/** The revision the run compares against, and how it was named. */
type BaseRevision = {
  readonly sha: string;
  readonly ref: string;
};

/** Run git and return its stdout, or the reason it failed. */
const gitOutput = async (args: readonly string[]): Promise<string> => {
  const process_ = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process_.stdout).text(),
    new Response(process_.stderr).text(),
    process_.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${stderr.trim() || `exit ${code}`}`);
  return stdout.trim();
};

/** Resolve `--against` (or the branch point with `main`) to a commit. A ref that does not resolve
 * is a usage error, refused before the run owns anything. */
const resolveBase = async (): Promise<BaseRevision> => {
  const ref = against ?? "merge-base HEAD main";
  try {
    const sha =
      against === undefined
        ? await gitOutput(["merge-base", "HEAD", "main"])
        : await gitOutput(["rev-parse", "--verify", `${against}^{commit}`]);
    return { sha, ref };
  } catch (error) {
    console.error(
      against === undefined
        ? `screens: cannot find the branch point (git merge-base HEAD main); pass --against <ref>. ` +
            `${error instanceof Error ? error.message : String(error)}`
        : `--against ${against} does not name a commit: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }
};

/** The base revision's own route table: the module it ships, not this checkout's copy of it. A
 * route that resolves there to a view is a surface the base has, whatever its markup looks like
 * to today's selectors. */
type BaseRoutes = {
  readonly viewOf: (
    location: string,
    pages: readonly { readonly id: string; readonly extension: string }[],
  ) => { readonly name: string };
};

/** Import the extracted base's `navigation.ts` and take its `viewOf`. The module is a pure map from
 * a path to a view (`import type` only), so evaluating it here decides nothing about the page
 * beyond the answer this run must not guess at: whether the base revision has a surface at all. */
const readBaseRoutes = async (root: string): Promise<BaseRoutes> => {
  const path = join(root, "apps", "web", "src", "app-root", "navigation.ts");
  const found = await stat(path)
    .then((entry) => entry.isFile())
    .catch(() => false);
  if (!found) {
    throw new Error(
      "the base revision has no route table (apps/web/src/app-root/navigation.ts), so whether it " +
        "has a surface cannot be decided",
    );
  }
  const module = (await import(pathToFileURL(path).href)) as unknown as {
    readonly viewOf?: BaseRoutes["viewOf"];
  };
  if (typeof module.viewOf !== "function") {
    throw new Error("the base revision's navigation.ts exports no viewOf");
  }
  const rawViewOf = module.viewOf;
  /** The shape every answer must have. Without it a base whose `viewOf` returns something else
   * makes `baseHasView` compare `undefined !== "home"`, which is true for every route: the run
   * would call every surface "not new" on no evidence at all. */
  const checked = (
    location: string,
    pages: readonly { readonly id: string; readonly extension: string }[],
  ): { readonly name: string } => {
    const view = rawViewOf(location, pages) as unknown;
    if (
      view === null ||
      typeof view !== "object" ||
      typeof (view as { readonly name?: unknown }).name !== "string"
    ) {
      throw new Error(
        `the base revision's navigation.ts viewOf(${JSON.stringify(location)}) returned no view ` +
          "with a string name; its route table cannot decide which surfaces it has",
      );
    }
    return view as { readonly name: string };
  };
  // Prove the shape now, while the route table is being read, rather than at the first route that
  // would silently be called "present".
  checked("/", []);
  return { viewOf: checked };
};

/** This checkout's page bundle, built for this run (see the header). */
const buildHead = async (tmp: string): Promise<string> => {
  const checkout = resolve(import.meta.dir, "..");
  const dist = join(tmp, "head-dist");
  const build = Bun.spawn(["bun", join(checkout, "apps", "web", "src", "node", "build.ts"), "--out", dist], {
    cwd: checkout,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited,
  ]);
  if (code !== 0) {
    throw new Error(`the page bundle of this checkout could not be built:\n${(stderr || stdout).trim()}`);
  }
  for (const name of ["index.html", "app.js"]) {
    if (!(await Bun.file(join(dist, name)).exists())) {
      throw new Error(`the build of this checkout wrote no ${name} into ${dist}`);
    }
  }
  return dist;
};

/** The base revision's page bundle: its own `apps/web/src`, its own build code, this checkout's
 * dependencies. A failure stops the run before anything is written; a base bundle that silently
 * stayed the current one would make every picture a lie. */
const buildBase = async (
  base: BaseRevision,
  tmp: string,
): Promise<{ readonly dist: string; readonly routes: BaseRoutes }> => {
  const root = join(tmp, "base");
  await mkdir(join(root, "apps", "web"), { recursive: true });
  // The page sources and the tsconfig that tells esbuild how to compile them — without it the
  // extracted tree has no `jsx: react-jsx`, esbuild falls back to `React.createElement`, and the
  // page dies with "React is not defined". Nothing else of the ref comes out: taking the whole
  // tree would mean a second checkout to keep in sync.
  const archive = Bun.spawn(["git", "archive", "--format=tar", base.sha, "apps/web/src", "tsconfig.json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const extract = Bun.spawn(["tar", "-x", "-C", root], { stdin: archive.stdout, stderr: "pipe" });
  const [archiveError, archiveCode, extractError, extractCode] = await Promise.all([
    new Response(archive.stderr).text(),
    archive.exited,
    new Response(extract.stderr).text(),
    extract.exited,
  ]);
  if (archiveCode !== 0 || extractCode !== 0) {
    throw new Error(
      `could not take apps/web/src out of ${base.sha.slice(0, 7)}: ${(archiveError || extractError).trim()}`,
    );
  }
  // The extracted sources resolve their imports through this checkout's packages, and find their
  // fonts where the base's build expects them. Bun does not resolve through a symlinked
  // `node_modules` directory, so each entry is a symlink in a real one — and a workspace keeps
  // its own (`apps/web/node_modules`), which is where the build's `esbuild` lives.
  const checkout = resolve(import.meta.dir, "..");
  const linkModules = async (from: string, to: string): Promise<void> => {
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from)) await symlink(join(from, entry), join(to, entry), "dir");
  };
  await linkModules(join(checkout, "node_modules"), join(root, "node_modules"));
  await linkModules(join(checkout, "apps", "web", "node_modules"), join(root, "apps", "web", "node_modules"));
  await symlink(join(checkout, "apps", "web", "fonts"), join(root, "apps", "web", "fonts"), "dir");

  const dist = join(tmp, "base-dist");
  const build = Bun.spawn(["bun", join(root, "apps", "web", "src", "node", "build.ts"), "--out", dist], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `the page bundle of ${base.sha.slice(0, 7)} could not be built; a dependency it needs may not ` +
        `be in this checkout:\n${(stderr || stdout).trim()}`,
    );
  }
  for (const name of ["index.html", "app.js"]) {
    if (!(await Bun.file(join(dist, name)).exists())) {
      throw new Error(
        `the build of ${base.sha.slice(0, 7)} wrote no ${name}; its build.ts may not support --out`,
      );
    }
  }
  return { dist, routes: await readBaseRoutes(root) };
};

/** The content types the base bundle's own files need; anything else is served as bytes. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
};

/** The base bundle's file for a request path, or nothing when it is not one of its files. Like
 * the server's own `serveClient`, the file is looked up by basename: the base page's `./app.js`
 * resolves against whatever route the page was loaded on, so `/changes/<id>/app.js` must find the
 * bundle too. */
const baseFileOf = async (dist: string, pathname: string): Promise<Response | undefined> => {
  const name = pathname === "/" ? "index.html" : basename(pathname);
  if (name === "index.html") return undefined;
  const path = join(dist, name);
  const isFile = await stat(path)
    .then((entry) => entry.isFile())
    .catch(() => false);
  if (!isFile) return undefined;
  return new Response(Bun.file(path), {
    headers: { "content-type": CONTENT_TYPES[extname(name)] ?? "application/octet-stream" },
  });
};

/** A browser navigation asks for a document; a script, an image or an API call does not. Only a
 * navigation falls back to the SPA's index — everything else is the server's. */
const isNavigation = (request: Request): boolean =>
  request.headers.get("sec-fetch-mode") === "navigate" ||
  (request.headers.get("accept") ?? "").includes("text/html");

/** Refuse a request the base origin will not answer itself. A refusal is a response the page
 * cannot mistake for data, so a one-sided answer fails visibly instead of being photographed. */
const refusal = (detail: string): Response =>
  new Response(`screens: ${detail}\n`, {
    status: 502,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

/** The request destinations that ask for one of the bundle's own files. A request with any other
 * destination — an API call, a document navigation, a form — must not be answered from the
 * bundle just because its last segment happens to be a file name: `app.js` and `styles.css` are
 * ordinary enough basenames that an API route could carry one, and the current pass would answer
 * it from the API while the base pass answered it from the bundle. */
const BUNDLE_DESTINATIONS: ReadonlySet<string> = new Set([
  "audio",
  "embed",
  "font",
  "image",
  "manifest",
  "object",
  "script",
  "style",
  "track",
  "video",
]);

/** Forward a request to the Corvi server that is already running, as that server's own origin:
 * `Sec-Fetch-Site` already says "same-origin" (the page is on the base origin), and the `Origin`
 * header the guard compares must name the server, not the base, or a write would be refused. */
const proxyToServer = async (request: Request, serverUrl: string): Promise<Response> => {
  const incoming = new URL(request.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, serverUrl);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.set("origin", serverUrl);
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : request.body;
  const upstream = await fetch(target, { method: request.method, headers, body, redirect: "manual" });
  // A redirect forwarded verbatim would be followed by the base page onto the server's origin,
  // and the picture called "before" would be of the current bundle. The base origin answers only
  // what the base has; a redirect is refused rather than followed.
  if (upstream.status >= 300 && upstream.status < 400) {
    return refusal(
      `the Corvi server redirected ${incoming.pathname} to ` +
        `${upstream.headers.get("location") ?? "(no location)"} (${upstream.status}); a redirect ` +
        "off the base origin is not followed",
    );
  }
  const forwarded = new Headers(upstream.headers);
  // The body is streamed as it arrives; a length or encoding from upstream would be a claim about
  // bytes this response may not carry.
  forwarded.delete("content-length");
  forwarded.delete("content-encoding");
  forwarded.delete("transfer-encoding");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: forwarded,
  });
};

/** The base revision's page, on its own origin, beside the server that is already running. */
type BaseOrigin = {
  readonly url: string;
  readonly stop: () => void;
};

const serveBase = async (dist: string, serverUrl: string): Promise<BaseOrigin> => {
  const index = await Bun.file(join(dist, "index.html")).text();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request: Request): Promise<Response> {
      const pathname = new URL(request.url).pathname;
      const file = await baseFileOf(dist, pathname);
      if (file !== undefined) {
        if (!BUNDLE_DESTINATIONS.has(request.headers.get("sec-fetch-dest") ?? "")) {
          return refusal(
            `${pathname} has a bundle file's basename (${basename(pathname)}) but is not a request ` +
              "for a bundle asset; the base origin will not answer it from the bundle",
          );
        }
        return file;
      }
      if (isNavigation(request)) {
        return new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return proxyToServer(request, serverUrl);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
};

/** Prove the base origin does its three jobs before any surface trusts it: the SPA fallback
 * serves the base's index from a deep route, a relative asset from that route finds the base's
 * own bundle, and an API call reaches the running server (through the origin guard). */
const checkBase = async (base: BaseOrigin, dist: string): Promise<void> => {
  const index = await readFile(join(dist, "index.html"), "utf8");
  const app = await readFile(join(dist, "app.js"));
  const navigation = await fetch(`${base.url}${changeRoute("dashboard")}`, {
    headers: { accept: "text/html" },
  });
  if (!navigation.ok || (await navigation.text()) !== index) {
    throw new Error(`the base origin did not fall back to its own index.html (${navigation.status})`);
  }
  const asset = await fetch(`${base.url}${changeRoute("dashboard").replace(/[^/]+$/, "app.js")}`, {
    headers: { "sec-fetch-dest": "script" },
  });
  const served = new Uint8Array(await asset.arrayBuffer());
  if (!asset.ok || served.length !== app.length || !served.every((byte, at) => byte === app[at])) {
    throw new Error(`the base origin did not serve its own bundle from a nested route (${asset.status})`);
  }
  // The same basename on a path that is not asking for the bundle must be refused, not served
  // one-sidedly from the base's files.
  const collision = await fetch(`${base.url}/api/pages/app.js`);
  if (collision.status !== 502) {
    throw new Error(
      `the base origin answered a non-asset request with a bundle basename (${collision.status}) ` +
        "instead of refusing it",
    );
  }
  const pages = await fetch(`${base.url}/api/pages`);
  if (!pages.ok) {
    throw new Error(
      `the base origin could not reach the Corvi server (${pages.status}): ${await pages.text()}`,
    );
  }
};

/** What comparing one surface's two captures found. */
type Verdict =
  | { readonly kind: "same" }
  | { readonly kind: "new" }
  | { readonly kind: "base-failed"; readonly findings: readonly Finding[] }
  | { readonly kind: "failed" }
  | { readonly kind: "changed"; readonly pixels: number; readonly percentage: number };

type Row = {
  readonly surface: Surface;
  readonly index: number;
  readonly verdict: Verdict;
};

/** One line for a verdict, as the report prints it. */
const describeVerdict = (verdict: Verdict): string => {
  switch (verdict.kind) {
    case "same":
      return "same";
    case "new":
      return "new";
    case "base-failed":
      return "failed on the base";
    case "failed":
      return "failed";
    case "changed":
      return `changed ${verdict.pixels.toLocaleString("en-US")} px (${verdict.percentage.toFixed(2)}%)`;
  }
};

/** Read two captures, compare them, and write the diff when they differ. */
const compareSurface = async (
  out: string,
  surface: Surface,
  index: number,
  beforePath: string,
  afterPath: string,
): Promise<Verdict> => {
  const before = PNG.sync.read(await readFile(beforePath));
  const after = PNG.sync.read(await readFile(afterPath));
  const comparison: Comparison = compareImages(
    { width: before.width, height: before.height, data: before.data },
    { width: after.width, height: after.height, data: after.data },
  );
  switch (comparison.kind) {
    case "same":
      return { kind: "same" };
    case "changed": {
      const diff = new PNG({ width: before.width, height: before.height });
      diff.data = Buffer.from(comparison.diff);
      await writeFile(join(out, "diff", fileNameOf(index, surface)), PNG.sync.write(diff));
      return { kind: "changed", pixels: comparison.pixels, percentage: comparison.percentage };
    }
  }
};

/** HTML for text the gallery prints: names, details and the ref come from the run, not from a
 * template that expects them to be safe. */
const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });

/** One image cell, or the reason there is none. */
const imageCell = (label: string, src: string | undefined, missing: string): string =>
  src === undefined
    ? `<figure class="missing"><figcaption>${escapeHtml(label)}</figcaption><p>${escapeHtml(missing)}</p></figure>`
    : `<figure><figcaption>${escapeHtml(label)}</figcaption><a href="${escapeHtml(src)}"><img src="${escapeHtml(src)}" alt="${escapeHtml(label)}" loading="lazy"></a></figure>`;

/** The gallery: a static page, relative links, nothing to serve. Changed surfaces first, then the
 * rest in catalog order; the run's findings above them — fatal and not, because both change how
 * the pictures should be read, and a clipping note is often the run's one real product finding.
 * A run with `--only` says so in its header: a three-surface gallery must not read as a whole run. */
const galleryHtml = async (options: {
  readonly out: string;
  readonly base: BaseRevision;
  readonly rows: readonly Row[];
  readonly findings: readonly Finding[];
  readonly selection: { readonly only?: string; readonly captured: number; readonly catalog: number };
}): Promise<string> => {
  const counts = { same: 0, changed: 0, new: 0, failed: 0, "base-failed": 0 };
  for (const row of options.rows) {
    if (
      row.verdict.kind === "same" ||
      row.verdict.kind === "new" ||
      row.verdict.kind === "failed" ||
      row.verdict.kind === "base-failed"
    ) {
      counts[row.verdict.kind] += 1;
    } else {
      counts.changed += 1;
    }
  }
  const changed = options.rows.filter((row) => row.verdict.kind === "changed");
  const rest = options.rows.filter((row) => !changed.includes(row));
  const fatal = options.findings.filter((finding) => finding.fatal);
  const notes = options.findings.filter((finding) => !finding.fatal);
  const findingLine = (finding: Finding): string =>
    `<li><strong>${escapeHtml(finding.surface)}</strong>${finding.pass === "before" ? " <em>(base)</em>" : ""} — ${escapeHtml(finding.kind)}: ${escapeHtml(finding.detail)}</li>`;
  const written = (relative: string): Promise<boolean> => Bun.file(join(options.out, relative)).exists();
  const sections = await Promise.all(
    [...changed, ...rest].map(async (row) => {
      const id = fileNameOf(row.index, row.surface).replace(/\.png$/, "");
      // The base's failure artifact is the evidence for `failed on the base`, not a picture of the
      // surface; it is referenced under the name the capture wrote so it cannot be mistaken for
      // `before/<surface>.png`. The current pass's failure artifact is the same evidence on the
      // other side. A link is only written for a file that exists: a broken image is not evidence.
      const beforeCandidate =
        row.verdict.kind === "base-failed"
          ? `before/${id}-failed.png`
          : row.verdict.kind === "same" || row.verdict.kind === "changed"
            ? `before/${id}.png`
            : undefined;
      const afterCandidate =
        row.verdict.kind === "failed"
          ? `after/${id}-failed.png`
          : row.verdict.kind === "new" ||
              row.verdict.kind === "same" ||
              row.verdict.kind === "changed" ||
              row.verdict.kind === "base-failed"
            ? `after/${id}.png`
            : undefined;
      const diffCandidate = row.verdict.kind === "changed" ? `diff/${id}.png` : undefined;
      const before =
        beforeCandidate !== undefined && (await written(beforeCandidate)) ? beforeCandidate : undefined;
      const after =
        afterCandidate !== undefined && (await written(afterCandidate)) ? afterCandidate : undefined;
      const diff = diffCandidate !== undefined && (await written(diffCandidate)) ? diffCandidate : undefined;
      const missing = (which: "before" | "after" | "diff"): string => {
        if (which === "before") {
          switch (row.verdict.kind) {
            case "new":
              return "no before image — the base revision's route table has no such view";
            case "failed":
              return "no before image — the current capture failed";
            default:
              return "no before image — the base's capture failed";
          }
        }
        if (which === "after") {
          return row.verdict.kind === "failed"
            ? "the capture failed and wrote no picture"
            : "no after image — the current capture wrote none";
        }
        return "no diff";
      };
      const baseNote =
        row.verdict.kind === "base-failed"
          ? `<p class="note">the base revision has this view, but its capture did not arrive; the picture on the left is what it showed. The base's findings are listed above and do not fail this run.</p>`
          : "";
      return `<section class="surface ${row.verdict.kind}">
  <h2><code>${escapeHtml(id)}</code> <span class="verdict">${escapeHtml(describeVerdict(row.verdict))}</span></h2>
  ${baseNote}
  <div class="compare">
    ${imageCell("before", before, missing("before"))}
    ${imageCell("after", after, missing("after"))}
    ${imageCell("diff", diff, row.verdict.kind === "same" ? "identical — no diff" : "no diff")}
  </div>
</section>`;
    }),
  );
  const findingsSection =
    fatal.length === 0
      ? ""
      : `<section class="fatal"><h2>Fatal findings</h2><ul>${fatal.map(findingLine).join("")}</ul></section>`;
  const notesSection =
    notes.length === 0
      ? ""
      : `<section class="notes"><h2>Findings</h2><ul>${notes.map(findingLine).join("")}</ul></section>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Corvi screenshots</title>
<style>
  body { margin: 0; padding: 24px; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; color: #1b1d24; background: #f6f7fa; }
  header { display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 20px; }
  header p { margin: 0; color: #555b6a; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .fatal { margin-top: 20px; padding: 12px 16px; border: 1px solid #d33; border-radius: 8px; background: #fff2f2; }
  .fatal h2 { margin: 0 0 8px; font-size: 15px; color: #a11; }
  .fatal ul { margin: 0; padding-left: 20px; }
  .notes { margin-top: 16px; padding: 12px 16px; border: 1px solid #d8b44a; border-radius: 8px; background: #fffbea; }
  .notes h2 { margin: 0 0 8px; font-size: 15px; color: #7a5a00; }
  .notes ul { margin: 0; padding-left: 20px; }
  .partial { padding: 2px 8px; border-radius: 999px; background: #ffe9c7; color: #7a4a00; font-weight: 600; }
  .note { margin: 0 0 10px; color: #7a4a00; }
  .surface { margin-top: 24px; padding: 16px; border: 1px solid #dcdfe8; border-radius: 10px; background: #fff; }
  .surface h2 { display: flex; gap: 12px; align-items: baseline; margin: 0 0 10px; font-size: 15px; }
  .verdict { font-size: 13px; color: #555b6a; }
  .surface.changed .verdict { color: #a15c00; }
  .surface.failed .verdict, .surface.base-failed .verdict { color: #a11; }
  .surface.new .verdict { color: #0a6; }
  .compare { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; align-items: start; }
  figure { margin: 0; }
  figcaption { margin-bottom: 4px; font-size: 12px; color: #555b6a; }
  img { display: block; width: 100%; height: auto; border: 1px solid #dcdfe8; border-radius: 6px; }
  figure.missing p { margin: 0; padding: 24px 8px; border: 1px dashed #c8ccd8; border-radius: 6px; color: #777d8c; text-align: center; }
</style>
</head>
<body>
<header>
  <h1>Corvi screenshots</h1>
  <p>base <code>${escapeHtml(options.base.sha.slice(0, 7))}</code> (${escapeHtml(options.base.ref)}) · ${options.rows.length} surfaces: ${counts.same} same, ${counts.changed} changed, ${counts.new} new${counts["base-failed"] > 0 ? `, ${counts["base-failed"]} failed on the base` : ""}${counts.failed > 0 ? `, ${counts.failed} failed` : ""}</p>
  ${
    options.selection.only === undefined
      ? ""
      : `<p class="partial">partial run — <code>--only ${escapeHtml(options.selection.only)}</code>: ${options.selection.captured} of ${options.selection.catalog} surfaces</p>`
  }
</header>
${findingsSection}
${notesSection}
<main>
${sections.join("\n")}
</main>
</body>
</html>
`;
};

const main = async (): Promise<void> => {
  // The revision and the surface selection are decided before the run owns anything, so a refusal
  // leaves the last gallery and the temp base untouched.
  const base = await resolveBase();
  // The run token and its pid-file come first: everything this run makes carries them, so
  // scripts/clean-test.ts can tell its resources from another run's.
  const token = testRun();
  const refused = await takeLock(LOCK, "screens", token);
  if (refused !== undefined) {
    console.error(refused);
    await removeUnstartedRun(token);
    process.exit(2);
  }
  const tmp = await testTempDir("screens");
  const findings: Finding[] = [];
  const rows: Row[] = [];
  let server: ReturnType<typeof Bun.spawn> | undefined;
  let baseOrigin: BaseOrigin | undefined;

  /** What this run owns, in the order it is safe to take away: the browser of the capture in
   * flight, the base origin, the server and its terminal host, the fixture and the run's temp
   * dir, and last the lock — which is therefore held until every shared path is gone. Called from
   * the normal path and from a signal, exactly once. */
  const cleanUp = cleanupOnce(async (): Promise<void> => {
    const browser = takeActiveBrowser();
    if (browser !== undefined) await browser.close().catch(() => undefined);
    baseOrigin?.stop();
    await stopTestServer(server, tmp);
    await killHostByPid(tmp);
    if (keep) console.log(`\nfixture kept in ${FIXTURE} and ${tmp}`);
    else await rm(FIXTURE, { recursive: true, force: true });
    // A staged run that never reached its gallery is this run's partial output, not a report.
    await rm(STAGE, { recursive: true, force: true });
    await removeRunPaths(token, tmp, keep);
    await releaseLock(LOCK, token);
  });
  installSignalCleanup(cleanUp, () => {
    interrupted = true;
  });

  try {
    const headDist = await buildHead(tmp);
    const built = await buildBase(base, tmp);
    // This run writes into its own staging directory. The published one, its gallery and all its
    // pictures stay as they are until this run has a complete gallery to replace them with, so a
    // run killed during the walk leaves the previous report readable rather than images with no
    // page.
    await rm(STAGE, { recursive: true, force: true });
    await mkdir(STAGE, { recursive: true });
    for (const pass of ["before", "after", "diff"] as const)
      await mkdir(join(STAGE, pass), { recursive: true });
    await rm(FIXTURE, { recursive: true, force: true });
    await mkdir(FIXTURE_CHANGES, { recursive: true });
    await mkdir(FIXTURE_ARCHIVE, { recursive: true });

    const started = await startTestServer(tmp, {
      env: {
        CORVI_ROOT: FIXTURE_CHANGES,
        CORVI_ARCHIVE_ROOT: FIXTURE_ARCHIVE,
        CORVI_CONFIG: FIXTURE_CONFIG,
        CORVI_REPOSITORIES_DIRECTORY: FIXTURE,
        CORVI_WEB_DIST: headDist,
      },
    });
    server = started.server;
    const url = started.url;
    await makeFixture(url);
    const origin = await serveBase(built.dist, url);
    baseOrigin = origin;
    await checkBase(origin, built.dist);

    // The page list is asked of the server before the walk: the base's route table needs it to
    // tell an extension page (`/leftovers`, `/azure-devops`) from the home fallback, and a run that
    // cannot read it must stop rather than write verdicts that guess.
    const offered = async <T>(path: string, pick: (body: unknown) => T): Promise<T> => {
      const response = await fetch(`${url}${path}`);
      if (!response.ok) throw new Error(`${path} answered ${response.status}`);
      return pick((await response.json()) as unknown);
    };
    const pages = await offered(
      "/api/pages",
      (body) => (body as { pages: { id: string; extension: string }[] }).pages,
    );

    /** Whether the base revision has a view at this route, by its own route table: `home` is a
     * genuine answer only for the overview, and anywhere else it is what a route with no view
     * falls back to. The base bundle may still fail to draw that view for a reason of its own;
     * this answers whether it *has* one, which is what `new` claims. */
    const baseHasView = (route: string): boolean =>
      route === "/" || built.routes.viewOf(route, pages).name !== "home";

    for (const { surface, index } of selected) {
      if (interrupted) break;
      const after = await captureSurface(surface, index, {
        pass: "after",
        out: join(STAGE, "after"),
        origin: url,
        serverUrl: url,
        change: CHANGE,
        now: NOW,
        headed,
        stub: stubFixtureServices,
      });
      findings.push(...after.findings);
      if (after.path === undefined) {
        rows.push({ surface, index, verdict: { kind: "failed" } });
        continue;
      }
      // A surface the base's route table does not have is new. Capturing it would photograph the
      // home fallback, and a comparison of that against this revision's page would be a diff of
      // two unrelated pictures.
      if (!baseHasView(surface.route)) {
        rows.push({ surface, index, verdict: { kind: "new" } });
        continue;
      }
      const before = await captureSurface(surface, index, {
        pass: "before",
        out: join(STAGE, "before"),
        origin: origin.url,
        serverUrl: url,
        change: CHANGE,
        now: NOW,
        headed,
        stub: stubFixtureServices,
      });
      if (before.path === undefined) {
        // The base has this view, but its capture did not arrive — today's readiness selector may
        // not match the base's markup. The surface is not new: the base's findings and its last
        // frame are kept as the evidence, and they do not fail this run.
        rows.push({ surface, index, verdict: { kind: "base-failed", findings: before.findings } });
        findings.push(...before.findings);
        continue;
      }
      findings.push(...before.findings);
      rows.push({
        surface,
        index,
        verdict: await compareSurface(STAGE, surface, index, before.path, after.path),
      });
    }

    // A signal owns the exit from here: the cleanup has run or is running, and a gallery of a
    // walk that stopped halfway would read as a report of the whole catalog.
    if (interrupted) return;

    // Coverage: what the server says it offers, against what the catalog captures. Asked of the
    // server this run started — for both changes, so a tab only an idea offers is seen too — so an
    // extension added without an entry is a failed run, not a silently missing picture. A core
    // view is not in `/api/pages` at all; `test/screenCatalog.test.ts` pins those.
    const routes = new Set(SURFACES.map((surface) => surface.route));
    for (const page of pages) {
      if (routes.has(`/${page.id}`)) continue;
      findings.push({
        surface: page.id,
        kind: "coverage",
        detail: `/api/pages offers "${page.id}" and no catalog entry captures /${page.id}`,
        fatal: true,
        pass: "after",
      });
    }
    try {
      const tabIds = new Set<string>();
      for (const change of [CHANGE, IDEA]) {
        const tabs = await offered(
          `/api/changes/${encodeURIComponent(change)}/tabs`,
          (body) => (body as { tabs: { id: string }[] }).tabs,
        );
        for (const tab of tabs) tabIds.add(tab.id);
      }
      for (const tab of tabIds) {
        if (routes.has(changeRoute(tab))) continue;
        findings.push({
          surface: tab,
          kind: "coverage",
          detail: `a change's /tabs offers "${tab}" and no catalog entry captures ${changeRoute(tab)}`,
          fatal: true,
          pass: "after",
        });
      }
    } catch (error) {
      findings.push({
        surface: "coverage",
        kind: "coverage",
        detail: error instanceof Error ? error.message : String(error),
        fatal: true,
        pass: "after",
      });
    }

    const fatal = findings.filter((finding) => finding.fatal);
    const changedCount = rows.filter((row) => row.verdict.kind === "changed").length;
    const totalPixels = rows.reduce(
      (sum, row) => sum + (row.verdict.kind === "changed" ? row.verdict.pixels : 0),
      0,
    );
    console.log(`\nbase ${base.sha.slice(0, 7)} (${base.ref})`);
    for (const row of rows) {
      const name = fileNameOf(row.index, row.surface).replace(/\.png$/, "");
      console.log(`${name}: ${describeVerdict(row.verdict)}`);
    }
    const same = rows.filter((row) => row.verdict.kind === "same").length;
    const added = rows.filter((row) => row.verdict.kind === "new").length;
    const baseFailed = rows.filter((row) => row.verdict.kind === "base-failed").length;
    const failed = rows.filter((row) => row.verdict.kind === "failed").length;
    console.log(
      `\n${rows.length} surfaces: ${same} same, ${changedCount} changed, ${added} new` +
        (baseFailed > 0 ? `, ${baseFailed} failed on the base` : "") +
        (failed > 0 ? `, ${failed} failed` : "") +
        (totalPixels > 0 ? `; ${totalPixels.toLocaleString("en-US")} px differ` : "") +
        (only === undefined ? "" : ` (--only ${only})`),
    );
    // The entries this walk leaves to the live one, named rather than silently absent: a gallery
    // of nineteen pictures must not read as the whole catalog.
    if (liveOnly.length > 0) {
      const names = liveOnly.map(({ surface, index }) => fileNameOf(index, surface).replace(/\.png$/, ""));
      console.log(
        `\nlive surfaces, not compared here: ${names.join(", ")} — bun run shot captures them against a running instance`,
      );
    }
    if (findings.length === 0) {
      console.log("no findings");
    } else {
      console.log(`${findings.length} finding(s):`);
      for (const finding of findings) {
        console.log(
          `  ${finding.fatal ? "fatal" : "note "}  ${finding.surface}${finding.pass === "before" ? " (base)" : ""}: ${finding.kind}: ${finding.detail}`,
        );
      }
    }
    // The gallery is the run's last artefact and is written before the staging directory is
    // published, so what replaces the previous report is a complete one.
    await writeFile(
      join(STAGE, "index.html"),
      await galleryHtml({
        out: STAGE,
        base,
        rows,
        findings,
        selection: { only, captured: rows.length, catalog: walkable.length },
      }),
    );
    await rm(OUT, { recursive: true, force: true });
    await rename(STAGE, OUT);
    console.log(`\ngallery: ${join(OUT, "index.html")}`);

    if (fatal.length > 0) process.exitCode = 1;
    else if (failOnDiff && rows.some((row) => row.verdict.kind !== "same")) process.exitCode = 1;
  } finally {
    await cleanUp();
  }
};

await main().catch((error: unknown) => {
  console.error(`screens: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
