import { afterAll, beforeAll, expect, test } from "bun:test";
import { lstat, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { changeDir, createChange, startChangeWithWorkflow } from "../apps/server/src/change/server/index.ts";
import { provisionRepositories } from "../apps/server/src/change/provisioning.ts";
import { checkoutsOf, runEffect, runSh, useOwnChangeRoot, commitIn, gitRepo } from "./helpers.ts";
/**
 * Starting an idea through the workflow: the browse link goes, the real checkout arrives, and a
 * failed repository leaves the start partially done with the failure reported.
 */
let tmp: string;
beforeAll(async () => {
  tmp = await useOwnChangeRoot("start-workflow");
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});
test("starting an idea provisions its worktree and reports the result", async () => {
  const repo = await gitRepo(tmp, "start-work", { remote: true });
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
  const good = await gitRepo(tmp, "start-good", { remote: true });
  const broken = await gitRepo(tmp, "start-broken", { remote: true });
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
  expect(await Bun.file(join(changeDir(idea), basename(good), "README.md")).exists()).toBe(true);
});
test("a change that already started cannot start again", async () => {
  const repo = await gitRepo(tmp, "start-twice", { remote: true });
  const change = await runEffect(
    createChange({ id: "PROJ-STARTTWICE", branch: "PROJ-STARTTWICE", checkouts: checkoutsOf([repo]) }),
  );
  await expect(runEffect(startChangeWithWorkflow(change))).rejects.toThrow(/already started/);
});
test("starting picks up the base commits that landed during ideation", async () => {
  const repo = await gitRepo(tmp, "start-fresh", { remote: true });
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
  await commitIn(repo, "the base moves on");
  await runSh(["git", "push", "--quiet", "origin", "main"], repo);
  const started = await runEffect(startChangeWithWorkflow(idea));
  expect(started.refresh[0]?.state).toBe("advanced");
  const tip = (await runSh(["git", "rev-parse", "HEAD"], worktree)).stdout.trim();
  const baseTip = (await runSh(["git", "rev-parse", "origin/main"], repo)).stdout.trim();
  expect(tip).toBe(baseTip);
  expect(await Bun.file(join(worktree, "base.txt")).exists()).toBe(true);
});
test("a branch with its own commits is left alone at start, and says so", async () => {
  const repo = await gitRepo(tmp, "start-diverged", { remote: true });
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
  await commitIn(worktree, "ideation work");
  const own = (await runSh(["git", "rev-parse", "HEAD"], worktree)).stdout.trim();
  await Bun.write(join(repo, "base.txt"), "landed meanwhile\n");
  await runSh(["git", "add", "."], repo);
  await commitIn(repo, "the base moves on");
  await runSh(["git", "push", "--quiet", "origin", "main"], repo);
  // The start goes through — never blocked, never rewritten.
  const started = await runEffect(startChangeWithWorkflow(idea));
  expect(started.change.state).toBe("Implementation");
  expect(started.refresh[0]?.state).toBe("left-alone");
  expect(started.refresh[0]?.detail).toBeTruthy();
  expect((await runSh(["git", "rev-parse", "HEAD"], worktree)).stdout.trim()).toBe(own);
});
