import { afterAll, beforeAll, expect, test } from "bun:test";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  changeDir,
  createChange,
  startChangeWithWorkflow,
} from "../src/change/server/index.ts";
import { provisionChangeRepositories } from "../src/change/provisioning.ts";
import type { Result } from "../src/capabilities/shell.ts";
import { runEffect, runSh } from "./helpers.ts";

/**
 * Starting an idea through the workflow: the browse link goes, the real checkout arrives, and a
 * failed repository leaves the start partially done with the failure reported.
 */
let tmp: string;

const commit = (repo: string, message: string): Promise<Result> =>
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
      repos: [repo],
    }),
  );
  await runEffect(provisionChangeRepositories(idea));

  const started = await runEffect(startChangeWithWorkflow(idea));
  expect(started.change.state).toBe("In Progress");

  const worktree = join(changeDir(idea.id), basename(repo));
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
      repos: [good, broken],
    }),
  );
  await runEffect(provisionChangeRepositories(idea));
  await rm(broken, { recursive: true, force: true });

  const started = await runEffect(startChangeWithWorkflow(idea));
  expect(started.change.state).toBe("In Progress");
  expect(started.provision.some((result) => !result.ok)).toBe(true);
  expect(await Bun.file(join(changeDir(idea.id), basename(good), "README.md")).exists()).toBe(
    true,
  );
});

test("a change that already started cannot start again", async () => {
  const repo = await clonedRepo("start-twice");
  const change = await runEffect(
    createChange({ id: "PROJ-STARTTWICE", branch: "PROJ-STARTTWICE", repos: [repo] }),
  );
  await expect(runEffect(startChangeWithWorkflow(change))).rejects.toThrow(/already started/);
});
