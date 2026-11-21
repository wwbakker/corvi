import { afterAll, beforeAll, expect, test } from "bun:test";
import { lstat, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { changeDir, createChange } from "../apps/server/src/change/server/index.ts";
import { provisionRepositories } from "../apps/server/src/change/provisioning.ts";
import { checkoutsOf, runEffect, runSh, useOwnChangeRoot, commitIn, gitRepo } from "./helpers.ts";
/**
 * The one checkout run, on demand: creation, a repository edit and a row's action all provision
 * through it, and its refresh is what brings a checkout up to a base that moved on. There is no
 * separate "start work" workflow — leaving `Ideation` is an ordinary phase change, and a
 * checkout is brought up to date by this run (or by the Local changes card's **Fast-forward**).
 */
let tmp: string;
beforeAll(async () => {
  tmp = await useOwnChangeRoot("checkout-run");
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});
test("the checkout run provisions a worktree and reports the result", async () => {
  const repo = await gitRepo(tmp, "provision-work", { remote: true });
  const idea = await runEffect(
    createChange({
      id: "PROJ-CHECKOUT",
      state: "Ideation",
      branch: "PROJ-CHECKOUT-x",
      checkouts: checkoutsOf([repo]),
    }),
  );
  const run = await runEffect(provisionRepositories(idea));
  const worktree = join(changeDir(idea), basename(repo));
  expect((await lstat(worktree)).isDirectory()).toBe(true);
  expect(await Bun.file(join(worktree, "README.md")).exists()).toBe(true);
  const branch = (await runSh(["git", "rev-parse", "--abbrev-ref", "HEAD"], worktree)).stdout.trim();
  expect(branch).toBe("PROJ-CHECKOUT-x");
  expect(run.provision.some((result) => result.integration === "git" && result.ok)).toBe(true);
});
test("a failed repository is reported, and the others still provision", async () => {
  const good = await gitRepo(tmp, "provision-good", { remote: true });
  const broken = await gitRepo(tmp, "provision-broken", { remote: true });
  const idea = await runEffect(
    createChange({
      id: "PROJ-CHECKOUTPART",
      state: "Ideation",
      branch: "PROJ-CHECKOUTPART-x",
      checkouts: checkoutsOf([good, broken]),
    }),
  );
  await rm(broken, { recursive: true, force: true });
  const run = await runEffect(provisionRepositories(idea));
  // One repository's trouble is a report, never a stopped run.
  expect(run.provision.some((result) => !result.ok)).toBe(true);
  expect(await Bun.file(join(changeDir(idea), basename(good), "README.md")).exists()).toBe(true);
});
test("the refresh picks up the base commits that landed since creation", async () => {
  const repo = await gitRepo(tmp, "refresh-fresh", { remote: true });
  const idea = await runEffect(
    createChange({
      id: "PROJ-REFRESHFRESH",
      state: "Ideation",
      branch: "PROJ-REFRESHFRESH-x",
      checkouts: checkoutsOf([repo]),
    }),
  );
  await runEffect(provisionRepositories(idea));
  const worktree = join(changeDir(idea), basename(repo));
  // The base moves on while the change sits: this is the "agent looking at an older commit" the
  // refresh exists for.
  await Bun.write(join(repo, "base.txt"), "landed while it sat\n");
  await runSh(["git", "add", "."], repo);
  await commitIn(repo, "the base moves on");
  await runSh(["git", "push", "--quiet", "origin", "main"], repo);
  const run = await runEffect(provisionRepositories(idea));
  expect(run.refresh[0]?.state).toBe("advanced");
  const tip = (await runSh(["git", "rev-parse", "HEAD"], worktree)).stdout.trim();
  const baseTip = (await runSh(["git", "rev-parse", "origin/main"], repo)).stdout.trim();
  expect(tip).toBe(baseTip);
  expect(await Bun.file(join(worktree, "base.txt")).exists()).toBe(true);
});
test("a branch with its own commits is left alone, and says so", async () => {
  const repo = await gitRepo(tmp, "refresh-diverged", { remote: true });
  const idea = await runEffect(
    createChange({
      id: "PROJ-REFRESHDIVERGED",
      state: "Ideation",
      branch: "PROJ-REFRESHDIVERGED-x",
      checkouts: checkoutsOf([repo]),
    }),
  );
  await runEffect(provisionRepositories(idea));
  const worktree = join(changeDir(idea), basename(repo));
  // Work of its own, and the base moved too: reconciling is the user's.
  await Bun.write(join(worktree, "wip.txt"), "my work\n");
  await runSh(["git", "add", "."], worktree);
  await commitIn(worktree, "work in progress");
  const own = (await runSh(["git", "rev-parse", "HEAD"], worktree)).stdout.trim();
  await Bun.write(join(repo, "base.txt"), "landed meanwhile\n");
  await runSh(["git", "add", "."], repo);
  await commitIn(repo, "the base moves on");
  await runSh(["git", "push", "--quiet", "origin", "main"], repo);
  // Never blocked, never rewritten.
  const run = await runEffect(provisionRepositories(idea));
  expect(run.refresh[0]?.state).toBe("left-alone");
  expect(run.refresh[0]?.detail).toBeTruthy();
  expect((await runSh(["git", "rev-parse", "HEAD"], worktree)).stdout.trim()).toBe(own);
});
