import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChange, changeDir } from "../src/changes.ts";
import {
  git,
  setRepos,
  worktreeFor,
  currentBranch,
  unsafeToRemove,
  repoStates,
  isDirect,
} from "../src/integrations/git.ts";
import { sh } from "../src/sh.ts";
import type { Change } from "../src/types.ts";

/**
 * Editing the repositories of a change moves real worktrees around, and the ways it can go wrong
 * all end in lost work: a removal that throws away commits nobody else has, a mode change that
 * silently deletes the branch it was meant to keep. Those paths are worth real repositories.
 */
let tmp: string;

const commit = (repo: string, message: string) =>
  sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", message], repo);

/** A bare "remote" with one commit on main, and a clone of it: the shape every change assumes. */
async function clonedRepo(name: string): Promise<string> {
  const origin = join(tmp, `${name}.git`);
  const work = join(tmp, `${name}-seed`);
  await sh(["git", "init", "-b", "main", work]);
  await Bun.write(join(work, "README.md"), `${name}\n`);
  await sh(["git", "add", "."], work);
  await commit(work, "init");
  await sh(["git", "clone", "--bare", "--quiet", work, origin]);

  const clone = join(tmp, name);
  await sh(["git", "clone", "--quiet", origin, clone]);
  await sh(["git", "config", "user.email", "t@t"], clone);
  await sh(["git", "config", "user.name", "t"], clone);
  return clone;
}

const changeFor = async (id: string, repos: string[], direct?: string[]): Promise<Change> =>
  createChange({ id, branch: `${id}-work`, repos, direct });

beforeAll(async () => {
  // Resolved: on macOS the temporary directory is a symlink, and git reports where it lands.
  tmp = await realpath(await mkdtemp(join(tmpdir(), "iwe-repos-")));
  process.env.IWE_ROOT = join(tmp, "changes");
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

test("adding a repository creates its worktree, removing one takes it away", async () => {
  const a = await clonedRepo("add-a");
  const b = await clonedRepo("add-b");
  const change = await changeFor("PROJ-ADD", [a]);
  await git.provision!(change);
  expect(await worktreeFor(change, a)).toBe(join(changeDir(change.id), "add-a"));

  const added = await setRepos(change, [a, b]);
  expect("change" in added).toBe(true);
  const withBoth = (added as { change: Change }).change;
  expect(await worktreeFor(withBoth, b)).toBe(join(changeDir(change.id), "add-b"));

  // Nothing was committed in b, so dropping it destroys nothing and needs no confirmation.
  const dropped = await setRepos(withBoth, [a]);
  expect("change" in dropped).toBe(true);
  expect((dropped as { change: Change }).change.repos).toEqual([a]);
  expect(await worktreeFor(withBoth, b)).toBeUndefined();
});

test("a removal that would lose commits asks first, and loses nothing until it is forced", async () => {
  const repo = await clonedRepo("unpushed");
  const keep = await clonedRepo("unpushed-keep");
  const change = await changeFor("PROJ-UNPUSHED", [repo, keep]);
  await git.provision!(change);

  const worktree = (await worktreeFor(change, repo))!;
  await Bun.write(join(worktree, "work.txt"), "never pushed\n");
  await sh(["git", "add", "."], worktree);
  await commit(worktree, "work nobody else has");
  expect((await unsafeToRemove(change, repo))?.kind).toBe("unpushed");

  // Asked, not done: the worktree and its commit are still there.
  const asked = await setRepos(change, [keep]);
  expect(asked).toEqual({ needsForce: ["unpushed"] });
  expect(await worktreeFor(change, repo)).toBe(worktree);
  expect(await Bun.file(join(worktree, "work.txt")).exists()).toBe(true);

  const forced = await setRepos(change, [keep], true);
  expect("change" in forced).toBe(true);
  expect(await worktreeFor(change, repo)).toBeUndefined();
});

test("uncommitted work refuses the removal outright, forced or not", async () => {
  const repo = await clonedRepo("dirty");
  const keep = await clonedRepo("dirty-keep");
  const change = await changeFor("PROJ-DIRTY", [repo, keep]);
  await git.provision!(change);

  const worktree = (await worktreeFor(change, repo))!;
  await Bun.write(join(worktree, "half-done.txt"), "not finished\n");
  expect((await unsafeToRemove(change, repo))?.kind).toBe("dirty");

  // Force is for commits that can be recovered from the reflog; this cannot be recovered at all.
  expect(setRepos(change, [keep])).rejects.toThrow(/uncommitted changes/);
  expect(setRepos(change, [keep], true)).rejects.toThrow(/uncommitted changes/);
  expect(await Bun.file(join(worktree, "half-done.txt")).exists()).toBe(true);
});

test("switching a repository from worktree to in place moves the work, not deletes it", async () => {
  const repo = await clonedRepo("switch");
  const change = await changeFor("PROJ-SWITCH", [repo]);
  await git.provision!(change);

  const worktree = (await worktreeFor(change, repo))!;
  await Bun.write(join(worktree, "committed.txt"), "pushed work\n");
  await sh(["git", "add", "."], worktree);
  await commit(worktree, "work");
  await sh(["git", "push", "--quiet", "-u", "origin", change.branch], worktree);

  // Pushed, so nothing is at risk and the switch goes through unforced.
  const result = await setRepos(change, [repo], false, [repo]);
  expect("change" in result).toBe(true);
  const direct = (result as { change: Change }).change;
  expect(isDirect(direct, repo)).toBe(true);

  // The repository itself is now on the branch, with the commit that was made in the worktree.
  expect(await currentBranch(repo)).toBe(change.branch);
  expect(await Bun.file(join(repo, "committed.txt")).text()).toBe("pushed work\n");
  // And the change directory links to it instead of holding a checkout of its own.
  expect(await worktreeFor(direct, repo)).toBe(repo);
  expect(await repoStates(direct)).toMatchObject([{ direct: true, base: "origin/main" }]);
});

test("a change cannot be edited down to nothing", async () => {
  const repo = await clonedRepo("last-one");
  const change = await changeFor("PROJ-LAST", [repo]);
  await git.provision!(change);
  expect(setRepos(change, [])).rejects.toThrow(/at least one repository/);
  expect(await worktreeFor(change, repo)).toBeDefined();
});

test("switching modes with unpushed commits asks first, and keeps them when forced", async () => {
  const repo = await clonedRepo("switch-unpushed");
  const change = await changeFor("PROJ-SWITCH-UNPUSHED", [repo]);
  await git.provision!(change);

  const worktree = (await worktreeFor(change, repo))!;
  await Bun.write(join(worktree, "unpushed.txt"), "only here\n");
  await sh(["git", "add", "."], worktree);
  await commit(worktree, "work nobody else has");

  // The worktree goes either way, so the question is asked, exactly as for a removal.
  expect(await setRepos(change, [repo], false, [repo])).toEqual({ needsForce: ["switch-unpushed"] });

  // Forced, the mode changes and the commit survives: the branch is kept and checked out in the
  // repository itself, which is the whole point of the switch.
  const result = await setRepos(change, [repo], true, [repo]);
  expect("change" in result).toBe(true);
  expect(await currentBranch(repo)).toBe(change.branch);
  expect(await Bun.file(join(repo, "unpushed.txt")).text()).toBe("only here\n");
});
