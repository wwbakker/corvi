import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";

import { stateDir } from "@corvi/configuration/node";
import { layer as repositoriesLayer } from "@corvi/repositories/node";
import type { Repositories } from "@corvi/repositories";
import {
  checkUpdate,
  closeInterruptedUpdate,
  commitUrl,
  comparePage,
  startUpdate,
  updateStatus,
  webBase,
  type AppUpdateOptions,
} from "../apps/server/src/app-update/update.ts";
import {
  fakeShell,
  runSh,
  runWithShell,
  testTempDir,
  type FakeShell,
} from "./helpers.ts";

/**
 * The app updating itself: what makes it eligible, what a check finds, and the update's three
 * steps over real git in fixture repositories and a scripted shell for the two Bun commands —
 * never `bun install`, `bun run app:install`, or the installed app itself
 * (docs/guides/testing.md).
 */

type Fixture = { tmp: string; remote: string; seed: string; app: string };

const cleanups: string[] = [];

const git = async (args: readonly string[], cwd?: string): Promise<void> => {
  const result = await runSh(["git", ...args], cwd);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
};

/** A bare remote and the app's own checkout cloned from it — the smallest world the feature
 * believes in. The remote is a local path, so a check is a fetch that needs no network. */
const fixture = async (label: string): Promise<Fixture> => {
  const tmp = await testTempDir(`update-${label}`);
  cleanups.push(tmp);
  const remote = join(tmp, "remote.git");
  const seed = join(tmp, "seed");
  const app = join(tmp, "app");
  await git(["init", "-q", "--bare", "-b", "main", remote]);
  await git(["init", "-q", "-b", "main", seed]);
  await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "one"], seed);
  await git(["remote", "add", "origin", remote], seed);
  await git(["push", "-q", "-u", "origin", "main"], seed);
  await git(["clone", "-q", remote, app]);
  return { tmp, remote, seed, app };
};

/** The remote moves on: a commit the app's checkout does not have yet, and its sha. */
const advance = async (f: Fixture, subject: string): Promise<string> => {
  await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", subject], f.seed);
  await git(["push", "-q", "origin", "main"], f.seed);
  const head = await runSh(["git", "rev-parse", "HEAD"], f.seed);
  return head.stdout.trim();
};

const headOf = async (dir: string): Promise<string> =>
  (await runSh(["git", "rev-parse", "HEAD"], dir)).stdout.trim();

const options = (f: Fixture): AppUpdateOptions => ({ root: f.app, app: true });

const run = <A, E>(shell: FakeShell, effect: Effect.Effect<A, E, Repositories>): Promise<A> =>
  runWithShell(shell, effect.pipe(Effect.provide(repositoriesLayer)));

const journalPath = (): string => join(stateDir(), "app-update.json");

type JournalRecord = {
  startedAt: string;
  finishedAt?: string;
  error?: string;
  steps: { id: string; label: string; state: string; detail?: string }[];
};

const journal = async (): Promise<JournalRecord | null> =>
  Bun.file(journalPath())
    .json()
    .catch(() => null);

const clearJournal = async (): Promise<void> => {
  await rm(journalPath(), { force: true });
};

/** The run is done when the journal says so — condition-driven, never a guessed sleep. The
 * drain after it is narrower than a wait: the fiber's finalizer releases the run guard just
 * after its last write, and a next start racing that release would read "busy". */
const settled = async (): Promise<JournalRecord> => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const record = await journal();
    if (record?.finishedAt !== undefined) {
      await Bun.sleep(50);
      return record;
    }
    if (Date.now() > deadline) throw new Error("the update never settled");
    await Bun.sleep(50);
  }
};

afterAll(async () => {
  for (const tmp of cleanups) await rm(tmp, { recursive: true, force: true });
});

test("link building: every spelling of a GitHub remote, and plain text elsewhere", () => {
  expect(webBase("git@github.com:wwbakker/corvi.git")).toBe("https://github.com/wwbakker/corvi");
  expect(webBase("https://github.com/wwbakker/corvi.git")).toBe("https://github.com/wwbakker/corvi");
  expect(webBase("https://github.com/wwbakker/corvi")).toBe("https://github.com/wwbakker/corvi");
  expect(webBase("ssh://git@github.com/wwbakker/corvi.git")).toBe("https://github.com/wwbakker/corvi");
  expect(webBase("/home/wessel/Repos/corvi")).toBeUndefined();
  expect(webBase("https://gitlab.com/acme/app.git")).toBeUndefined();
  expect(commitUrl("git@github.com:acme/app.git", "abc")).toBe("https://github.com/acme/app/commit/abc");
  expect(commitUrl("/tmp/remote.git", "abc")).toBeUndefined();
  expect(comparePage("https://github.com/acme/app.git", "a1", "b2")).toBe(
    "https://github.com/acme/app/compare/a1...b2",
  );
});

test("the feature is absent outside the installed app, without touching git", async () => {
  await clearJournal();
  // A path no repository could be read from: the answer's reason proves the gate fired before
  // any git ran.
  const status = await run(fakeShell(), updateStatus({ root: "/nonexistent-for-sure", app: false }));
  expect(status.eligible).toBe(false);
  expect(status.reason).toBe("not running as the installed app");
  expect(status.behind).toBe(0);
  expect(status.progress).toBeNull();
});

test("a checkout that is not a repository, and one off the default branch, say why", async () => {
  await clearJournal();
  const tmp = await testTempDir("update-nonrepo");
  cleanups.push(tmp);
  const bare = await run(fakeShell(), updateStatus({ root: tmp, app: true }));
  expect(bare.eligible).toBe(false);
  expect(bare.reason).toBe("the app is not running from a git repository");

  const f = await fixture("branch");
  await git(["switch", "-q", "-c", "feature"], f.app);
  const off = await run(fakeShell(), updateStatus(options(f)));
  expect(off.eligible).toBe(false);
  expect(off.reason).toBe("not on the main branch");
});

test("check now: fetches and counts what is new, newest first", async () => {
  await clearJournal();
  const f = await fixture("check");
  await advance(f, "second");
  await advance(f, "third");
  const status = await run(fakeShell(), checkUpdate(options(f)));
  expect(status.eligible).toBe(true);
  expect(status.behind).toBe(2);
  expect(status.commits.map((c) => c.subject)).toEqual(["third", "second"]);
  expect(status.checkedAt).toBeDefined();
  // A local path is not a forge: the rows are plain text.
  expect(status.commits.every((c) => c.url === undefined)).toBe(true);
  expect(status.compareUrl).toBeUndefined();
});

test("the dialog's rows link to GitHub when the remote lives there", async () => {
  await clearJournal();
  const f = await fixture("links");
  const sha = await advance(f, "second");
  // Fetch from the local path first, then say the remote is GitHub's: the status read after it
  // is local-only, which is exactly what the page polls.
  await git(["fetch", "-q", "origin"], f.app);
  await git(["remote", "set-url", "origin", "git@github.com:acme/app.git"], f.app);
  const status = await run(fakeShell(), updateStatus(options(f)));
  expect(status.behind).toBe(1);
  expect(status.commits[0]?.sha).toBe(sha);
  expect(status.commits[0]?.url).toBe(`https://github.com/acme/app/commit/${sha}`);
  expect(status.compareUrl).toBe(
    `https://github.com/acme/app/compare/${(await headOf(f.app))}...${sha}`,
  );
});

test("the update is refused — with the reason — for uncommitted and unpushed work", async () => {
  await clearJournal();
  const f = await fixture("refuse");
  await advance(f, "second");

  await Bun.write(join(f.app, "notes.txt"), "hello");
  const dirty = await run(fakeShell(), checkUpdate(options(f)));
  expect(dirty.behind).toBe(1);
  expect(dirty.refusal).toBe("uncommitted changes in the checkout");

  await rm(join(f.app, "notes.txt"));
  await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "local"], f.app);
  const unpushed = await run(fakeShell(), checkUpdate(options(f)));
  expect(unpushed.refusal).toBe("1 unpushed commit(s) in the checkout");
});

test("a remote that cannot be reached refuses the update rather than guessing", async () => {
  await clearJournal();
  const f = await fixture("offline");
  await advance(f, "second");
  // The last successful check saw "second"; the remote then moved on and went away.
  await git(["fetch", "-q", "origin"], f.app);
  await advance(f, "third");
  await rm(f.remote, { recursive: true, force: true });
  const status = await run(fakeShell(), checkUpdate(options(f)));
  // The remote-tracking refs still know the version that is new; taking it is refused.
  expect(status.behind).toBe(1);
  expect(status.refusal).toBe("could not reach the remote");
});

test("update now: the three steps, in the journal and through the shell", async () => {
  await clearJournal();
  const f = await fixture("run");
  const sha = await advance(f, "second");
  const shell = fakeShell();
  const start = await run(shell, startUpdate(options(f)));
  // The request answers at once with the opening: a run accepted, and the plan journaled. What
  // happens next is the journal's to say.
  expect(start._tag).toBe("Started");
  expect(start.status.progress?.steps.map((s) => s.state)).toEqual(["waiting", "waiting", "waiting"]);
  const record = await settled();
  expect(record.steps.map((s) => [s.id, s.state])).toEqual([
    ["pull", "done"],
    ["install", "done"],
    ["reinstall", "done"],
  ]);
  expect(record.finishedAt).toBeDefined();
  expect(record.error).toBeUndefined();
  expect(shell.calls.map((c) => c.cmd)).toEqual([
    ["bun", "install"],
    ["bun", "run", "app:install"],
  ]);
  expect(await headOf(f.app)).toBe(sha);
  const status = await run(fakeShell(), updateStatus(options(f)));
  expect(status.behind).toBe(0);
  expect(status.restartPending).toBe(true);
});

test("already up to date: nothing runs and no journal is written", async () => {
  await clearJournal();
  const f = await fixture("fresh");
  const shell = fakeShell();
  const start = await run(shell, startUpdate(options(f)));
  expect(start._tag).toBe("AlreadyUpToDate");
  expect(start.status.behind).toBe(0);
  expect(start.status.progress).toBeNull();
  expect(shell.calls).toEqual([]);
  expect(await journal()).toBeNull();
});

test("a failed step stops the run; Try again picks up what is left", async () => {
  await clearJournal();
  const f = await fixture("resume");
  const second = await advance(f, "second");
  const failing = fakeShell((cmd) =>
    cmd.join(" ") === "bun install" ? { code: 1, stderr: "boom" } : undefined,
  );
  const firstStart = await run(failing, startUpdate(options(f)));
  expect(firstStart._tag).toBe("Started");
  let record = await settled();
  expect(record.steps.map((s) => [s.id, s.state])).toEqual([
    ["pull", "done"],
    ["install", "failed"],
    ["reinstall", "waiting"],
  ]);
  expect(record.error).toContain("boom");
  expect(record.finishedAt).toBeDefined();

  // The remote moves on while the run is stopped. The retry finishes the update that was
  // started — the pull its journal records as done is not run again — and the newer version is
  // offered again right after.
  const third = await advance(f, "third");
  const shell = fakeShell();
  const secondStart = await run(shell, startUpdate(options(f)));
  expect(secondStart._tag).toBe("Started");
  record = await settled();
  expect(shell.calls.map((c) => c.cmd)).toEqual([
    ["bun", "install"],
    ["bun", "run", "app:install"],
  ]);
  expect(record.steps.map((s) => [s.id, s.state])).toEqual([
    ["pull", "done"],
    ["install", "done"],
    ["reinstall", "done"],
  ]);
  expect(record.error).toBeUndefined();
  expect(await headOf(f.app)).toBe(second);
  const status = await run(fakeShell(), updateStatus(options(f)));
  expect(status.behind).toBe(1);
  expect(status.commits[0]?.sha).toBe(third);
});

test("a second update while one runs is refused, not raced", async () => {
  await clearJournal();
  const f = await fixture("busy");
  await advance(f, "second");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inner = fakeShell();
  const gated: FakeShell = {
    calls: inner.calls,
    run: (cmd, opts) => Effect.zipRight(Effect.promise(() => gate), inner.run(cmd, opts)),
  };
  // The start answers at once; the background run is held at the first Bun command.
  const started = await run(gated, startUpdate(options(f)));
  expect(started._tag).toBe("Started");
  const deadline = Date.now() + 30_000;
  for (;;) {
    const record = await journal();
    if (record?.steps.some((s) => s.id === "install" && s.state === "running")) break;
    if (Date.now() > deadline) throw new Error("the update never reached the install step");
    await Bun.sleep(50);
  }
  const second = await run(fakeShell(), Effect.either(startUpdate(options(f))));
  expect(second._tag).toBe("Left");
  if (second._tag === "Left") expect(second.left._tag).toBe("UpdateBusy");
  release();
  const record = await settled();
  expect(record.steps.map((s) => s.state)).toEqual(["done", "done", "done"]);
  expect(inner.calls.map((c) => c.cmd)).toEqual([
    ["bun", "install"],
    ["bun", "run", "app:install"],
  ]);
});

test("an interrupted run is closed at startup and says so", async () => {
  await clearJournal();
  await Bun.write(
    journalPath(),
    JSON.stringify({
      startedAt: new Date().toISOString(),
      steps: [
        { id: "pull", label: "pull the latest code", state: "done" },
        { id: "install", label: "install dependencies", state: "running" },
        { id: "reinstall", label: "rebuild and reinstall the app", state: "waiting" },
      ],
    }),
  );
  await Effect.runPromise(closeInterruptedUpdate());
  const record = await journal();
  expect(record?.steps.map((s) => s.state)).toEqual(["done", "failed", "waiting"]);
  expect(record?.steps[1]?.detail).toBe("the update was interrupted");
  expect(record?.error).toBe("the update was interrupted");
  expect(record?.finishedAt).toBeDefined();
});
