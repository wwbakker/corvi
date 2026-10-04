import { afterAll, beforeAll, expect, test } from "bun:test";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  changeDir,
  createChange,
  startChangeWithWorkflow,
} from "../apps/server/src/change/server/index.ts";
import { provisionRepositories } from "../apps/server/src/change/provisioning.ts";
import type { ShellResult } from "../apps/server/src/capabilities/shell.ts";
import { checkoutsOf, runEffect, runSh  } from "./helpers.ts";

/**
 * Starting an idea through the workflow: the browse link goes, the real checkout arrives, and a
 * failed repository leaves the start partially done with the failure reported.
 */
let tmp: string;

const commit = (repo: string, message: string): Promise<ShellResult> =>
  runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", message], repo);

async function clonedRepo(name: string): Promise<string> {
  const origin = join(tmp, `${name}.git`);
  const work = join(tmp, `${name}-seed`);
  await runSh(["git", "init", "-b", "main", work]);
  await Bun.write(join(work, "README.md"), `${name}\n`);
  await runSh(["git", "add", "."], work);
  await commit(work, "init");
  await runSh(["git", "clone", "--bare", "--quiet", work, origin]);

  const clone = join(tmp, name);
  await runSh(["git", "clone", "--quiet", origin, clone]);
  await runSh(["git", "config", "user.email", "t@t"], clone);
  await runSh(["git", "config", "user.name", "t"], clone);
  return clone;
}

beforeAll(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), "corvi-start-wf-")));
  process.env.CORVI_ROOT = join(tmp, "changes");
  process.env.CORVI_ARCHIVE_ROOT = join(tmp, "changes-archive");
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

test("starting an idea provisions its worktree and reports the result", async () => {
  const repo = await clonedRepo("start-work");
  const idea = await runEffect(
    createChange({
      id: "PROJ-STARTWF",
      state: "Ideation",
      branch: "PROJ-STARTWF-x",
      checkouts: checkoutsOf([repo]),
    }),
  );
  await runEffect(provisionRepositories(idea));

  const started = await runEffect(startChangeWithWorkflow(idea));
  expect(started.change.state).toBe("Implementation");

  const worktree = join(changeDir(idea), basename(repo));
  expect((await lstat(worktree)).isDirectory()).toBe(true);
  expect(await Bun.file(join(worktree, "README.md")).exists()).toBe(true);
  const branch = (await runSh(["git", "rev-parse", "--abbrev-ref", "HEAD"], worktree)).stdout.trim();
  expect(branch).toBe("PROJ-STARTWF-x");
  expect(started.provision.some((result) => result.integration === "git" && result.ok)).toBe(true);
});

test("a failed repository leaves the start partially done, and says so", async () => {
  const good = await clonedRepo("start-good");
  const broken = await clonedRepo("start-broken");
  const idea = await runEffect(
    createChange({
      id: "PROJ-STARTPART",
      state: "Ideation",
      branch: "PROJ-STARTPART-x",
      checkouts: checkoutsOf([good, broken]),
    }),
  );
  await runEffect(provisionRepositories(idea));
  await rm(broken, { recursive: true, force: true });

  const started = await runEffect(startChangeWithWorkflow(idea));
  expect(started.change.state).toBe("Implementation");
  expect(started.provision.some((result) => !result.ok)).toBe(true);
  expect(await Bun.file(join(changeDir(idea), basename(good), "README.md")).exists()).toBe(
    true,
  );
});

test("a change that already started cannot start again", async () => {
  const repo = await clonedRepo("start-twice");
  const change = await runEffect(
    createChange({ id: "PROJ-STARTTWICE", branch: "PROJ-STARTTWICE", checkouts: checkoutsOf([repo]) }),
  );
  await expect(runEffect(startChangeWithWorkflow(change))).rejects.toThrow(/already started/);
});

test("starting picks up the base commits that landed during ideation", async () => {
  const repo = await clonedRepo("start-fresh");
  const idea = await runEffect(
    createChange({
      id: "PROJ-STARTFRESH",
      state: "Ideation",
      branch: "PROJ-STARTFRESH-x",
      checkouts: checkoutsOf([repo]),
    }),
  );
  await runEffect(provisionRepositories(idea));
  const worktree = join(changeDir(idea), basename(repo));

  // The base moves on while the idea sits: this is the "agent looking at an older commit" the
  // start's refresh exists for.
  await Bun.write(join(repo, "base.txt"), "landed during ideation\n");
  await runSh(["git", "add", "."], repo);
  await commit(repo, "the base moves on");
  await runSh(["git", "push", "--quiet", "origin", "main"], repo);

  const started = await runEffect(startChangeWithWorkflow(idea));
  expect(started.refresh[0]?.state).toBe("advanced");
  const tip = (await runSh(["git", "rev-parse", "HEAD"], worktree)).stdout.trim();
  const baseTip = (await runSh(["git", "rev-parse", "origin/main"], repo)).stdout.trim();
  expect(tip).toBe(baseTip);
  expect(await Bun.file(join(worktree, "base.txt")).exists()).toBe(true);
});

test("a branch with its own commits is left alone at start, and says so", async () => {
  const repo = await clonedRepo("start-diverged");
  const idea = await runEffect(
    createChange({
      id: "PROJ-STARTDIVERGED",
      state: "Ideation",
      branch: "PROJ-STARTDIVERGED-x",
      checkouts: checkoutsOf([repo]),
    }),
  );
  await runEffect(provisionRepositories(idea));
  const worktree = join(changeDir(idea), basename(repo));

  // Ideation produced work of its own, and the base moved too: reconciling is the user's.
  await Bun.write(join(worktree, "wip.txt"), "my work\n");
  await runSh(["git", "add", "."], worktree);
  await commit(worktree, "ideation work");
  const own = (await runSh(["git", "rev-parse", "HEAD"], worktree)).stdout.trim();
  await Bun.write(join(repo, "base.txt"), "landed meanwhile\n");
  await runSh(["git", "add", "."], repo);
  await commit(repo, "the base moves on");
  await runSh(["git", "push", "--quiet", "origin", "main"], repo);

  // The start goes through — never blocked, never rewritten.
  const started = await runEffect(startChangeWithWorkflow(idea));
  expect(started.change.state).toBe("Implementation");
  expect(started.refresh[0]?.state).toBe("left-alone");
  expect(started.refresh[0]?.detail).toBeTruthy();
  expect((await runSh(["git", "rev-parse", "HEAD"], worktree)).stdout.trim()).toBe(own);
});
