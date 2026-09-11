import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChange, changeDir } from "../src/change/server/index.ts";
import {
  setRepos,
  checkoutFor,
  currentBranch,
  unsafeToRemove,
  repoStates,
  isDirect,
} from "../src/core/integrations/git.ts";
import { runEffect, runFileDiff, runLocalChanges, runSetRepos, runSh } from "./helpers.ts";
import type { Result } from "../src/core/platform/capabilities/sh.ts";
import { provision } from "../src/core/host/index.ts";
import type { Change, FileChange } from "../src/core/domain/change.ts";

/**
 * Editing the repositories of a change moves real worktrees around, and the ways it can go wrong
 * all end in lost work: a removal that throws away commits nobody else has, a mode change that
 * silently deletes the branch it was meant to keep. Those paths are worth real repositories.
 */
let tmp: string;

const commit = (repo: string, message: string): Promise<Result> =>
  runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", message], repo);

/** A bare "remote" with one commit on main, and a clone of it: the shape every change assumes. */
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

const changeFor = async (id: string, repos: string[], direct?: string[]): Promise<Change> =>
  runEffect(createChange({ id, branch: `${id}-work`, repos, direct }));

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
  await runEffect(provision(change));
  expect(await runEffect(checkoutFor(change, a))).toBe(join(changeDir(change.id), "add-a"));

  const added = await runSetRepos(change, [a, b]);
  expect("change" in added).toBe(true);
  const withBoth = (added as { change: Change }).change;
  expect(await runEffect(checkoutFor(withBoth, b))).toBe(join(changeDir(change.id), "add-b"));

  // Nothing was committed in b, so dropping it destroys nothing and needs no confirmation.
  const dropped = await runSetRepos(withBoth, [a]);
  expect("change" in dropped).toBe(true);
  expect((dropped as { change: Change }).change.repos).toEqual([a]);
  expect(await runEffect(checkoutFor(withBoth, b))).toBeUndefined();
});

test("a new worktree gets the IDE state the repository had, pointing at itself", async () => {
  const repo = await clonedRepo("ide");
  // Ignored, per-machine, written by IntelliJ: never in the clone, so never in the worktree —
  // and only copied there because the repository does ignore it. One that does not would get an
  // untracked directory it can never remove.
  await Bun.write(join(repo, ".gitignore"), ".idea/\n");
  await runSh(["git", "add", ".gitignore"], repo);
  await commit(repo, "ignore the IDE");
  // Pushed, because the worktree branches from the remote default: an ignore rule that only
  // exists on your local main is not one the new worktree has.
  await runSh(["git", "push", "--quiet", "origin", "main"], repo);
  await Bun.write(join(repo, ".idea", "workspace.xml"), `<p dir="${repo}/target" />`);
  const change = await changeFor("PROJ-IDE", [repo]);
  await runEffect(provision(change));

  const worktree = (await runEffect(checkoutFor(change, repo)))!;
  expect(await Bun.file(join(worktree, ".idea", "workspace.xml")).text()).toBe(
    `<p dir="${worktree}/target" />`,
  );
  // And the worktree is clean: our own copy must never be work you are asked about.
  expect((await runSh(["git", "status", "--porcelain"], worktree)).stdout).toBe("");
});

test("a removal that would lose commits asks first, and loses nothing until it is forced", async () => {
  const repo = await clonedRepo("unpushed");
  const keep = await clonedRepo("unpushed-keep");
  const change = await changeFor("PROJ-UNPUSHED", [repo, keep]);
  await runEffect(provision(change));

  const worktree = (await runEffect(checkoutFor(change, repo)))!;
  await Bun.write(join(worktree, "work.txt"), "never pushed\n");
  await runSh(["git", "add", "."], worktree);
  await commit(worktree, "work nobody else has");
  expect((await runEffect(unsafeToRemove(change, repo)))?.kind).toBe("unpushed");

  // Asked, not done: the worktree and its commit are still there.
  const asked = await runSetRepos(change, [keep]);
  expect(asked).toEqual({ needsForce: ["unpushed"] });
  expect(await runEffect(checkoutFor(change, repo))).toBe(worktree);
  expect(await Bun.file(join(worktree, "work.txt")).exists()).toBe(true);

  const forced = await runSetRepos(change, [keep], true);
  expect("change" in forced).toBe(true);
  expect(await runEffect(checkoutFor(change, repo))).toBeUndefined();
});

test("uncommitted work refuses the removal outright, forced or not", async () => {
  const repo = await clonedRepo("dirty");
  const keep = await clonedRepo("dirty-keep");
  const change = await changeFor("PROJ-DIRTY", [repo, keep]);
  await runEffect(provision(change));

  const worktree = (await runEffect(checkoutFor(change, repo)))!;
  await Bun.write(join(worktree, "half-done.txt"), "not finished\n");
  expect((await runEffect(unsafeToRemove(change, repo)))?.kind).toBe("dirty");

  // Force is for commits that can be recovered from the reflog; this cannot be recovered at all.
  expect(runSetRepos(change, [keep])).rejects.toThrow(/uncommitted changes/);
  expect(runSetRepos(change, [keep], true)).rejects.toThrow(/uncommitted changes/);
  expect(await Bun.file(join(worktree, "half-done.txt")).exists()).toBe(true);
});

test("switching a repository from worktree to in place moves the work, not deletes it", async () => {
  const repo = await clonedRepo("switch");
  const change = await changeFor("PROJ-SWITCH", [repo]);
  await runEffect(provision(change));

  const worktree = (await runEffect(checkoutFor(change, repo)))!;
  await Bun.write(join(worktree, "committed.txt"), "pushed work\n");
  await runSh(["git", "add", "."], worktree);
  await commit(worktree, "work");
  await runSh(["git", "push", "--quiet", "-u", "origin", change.branch], worktree);

  // Pushed, so nothing is at risk and the switch goes through unforced.
  const result = await runSetRepos(change, [repo], false, [repo]);
  expect("change" in result).toBe(true);
  const direct = (result as { change: Change }).change;
  expect(isDirect(direct, repo)).toBe(true);

  // The repository itself is now on the branch, with the commit that was made in the worktree.
  expect(await runEffect(currentBranch(repo))).toBe(change.branch);
  expect(await Bun.file(join(repo, "committed.txt")).text()).toBe("pushed work\n");
  // And the change directory links to it instead of holding a checkout of its own.
  expect(await runEffect(checkoutFor(direct, repo))).toBe(repo);
  expect(await runEffect(repoStates(direct))).toMatchObject([{ direct: true, base: "origin/main" }]);
});

test("a change may be emptied and filled again, which is how a worktree is replaced", async () => {
  // Taking a repository out and putting it back is the way to get a fresh worktree when the one
  // you have is beyond saving, and that has a moment in the middle with nothing in it.
  const repo = await clonedRepo("last-one");
  const change = await changeFor("PROJ-LAST", [repo]);
  await runEffect(provision(change));
  const before = (await runEffect(checkoutFor(change, repo)))!;

  // Emptying is still a removal, and a removal still refuses to throw work away: the way out of
  // a worktree you have made a mess of is to commit or revert first, not to drop it silently.
  await Bun.write(join(before, "junk.txt"), "uncommitted\n");
  expect(runSetRepos(change, [])).rejects.toThrow(/uncommitted changes/);
  await rm(join(before, "junk.txt"));

  const emptied = await runSetRepos(change, []);
  expect("change" in emptied).toBe(true);
  const none = (emptied as { change: Change }).change;
  expect(none.repos).toEqual([]);
  expect(await runEffect(checkoutFor(none, repo))).toBeUndefined();

  const refilled = await runSetRepos(none, [repo]);
  const again = (refilled as { change: Change }).change;
  expect(again.repos).toEqual([repo]);
  // The same place, but a new checkout: this is what re-worktreeing gets you.
  expect(await runEffect(checkoutFor(again, repo))).toBe(before);
  expect(await Bun.file(join(before, "README.md")).exists()).toBe(true);
});

test("switching modes with unpushed commits asks first, and keeps them when forced", async () => {
  const repo = await clonedRepo("switch-unpushed");
  const change = await changeFor("PROJ-SWITCH-UNPUSHED", [repo]);
  await runEffect(provision(change));

  const worktree = (await runEffect(checkoutFor(change, repo)))!;
  await Bun.write(join(worktree, "unpushed.txt"), "only here\n");
  await runSh(["git", "add", "."], worktree);
  await commit(worktree, "work nobody else has");

  // The worktree goes either way, so the question is asked, exactly as for a removal.
  expect(await runSetRepos(change, [repo], false, [repo])).toEqual({ needsForce: ["switch-unpushed"] });

  // Forced, the mode changes and the commit survives: the branch is kept and checked out in the
  // repository itself, which is the whole point of the switch.
  const result = await runSetRepos(change, [repo], true, [repo]);
  expect("change" in result).toBe(true);
  expect(await runEffect(currentBranch(repo))).toBe(change.branch);
  expect(await Bun.file(join(repo, "unpushed.txt")).text()).toBe("only here\n");
});

test("an in-place branch does not track the branch it started from", async () => {
  const repo = await clonedRepo("no-track");
  const change = await changeFor("PROJ-TRACK", [repo], [repo]);
  await runEffect(provision(change));

  // Tracking origin/main would make `git push` aim at main, which is the one thing this must
  // never do. A fresh branch has no upstream until it is pushed.
  const upstream = await runSh(
    ["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    repo,
  );
  expect(upstream.code).not.toBe(0);
  expect(await runEffect(currentBranch(repo))).toBe(change.branch);

  // And it did start from main, so the work below it is there.
  const base = await runSh(["git", "rev-list", "--count", `origin/main..${change.branch}`], repo);
  expect(base.stdout).toBe("0");
});

test("uncommitted work is listed as git sees it, staged and unstaged apart", async () => {
  const { parseStatus } = await import("../src/change/server/index.ts");
  const repo = await clonedRepo("local");
  const change = await changeFor("PROJ-LOCAL", [repo]);
  await runEffect(provision(change));
  const wt = (await runEffect(checkoutFor(change, repo)))!;

  // Nothing yet, which is a state of its own and not an error.
  expect((await runLocalChanges(change, repo)).files).toEqual([]);

  await Bun.write(join(wt, "README.md"), "local\nedited\n");
  await Bun.write(join(wt, "added.txt"), "staged\n");
  await Bun.write(join(wt, "new.txt"), "untracked\n");
  await runSh(["git", "add", "added.txt"], wt);

  const status = await runLocalChanges(change, repo);
  const by = (path: string): FileChange => status.files.find((f) => f.path === path)!;
  // Alphabetical as a reader reads, not as ASCII sorts: `added.txt` before `README.md`.
  expect(status.files.map((f) => f.path)).toEqual(["added.txt", "new.txt", "README.md"]);
  expect(by("added.txt")).toMatchObject({ staged: true, unstaged: false, index: "A" });
  expect(by("README.md")).toMatchObject({ staged: false, unstaged: true, worktree: "M" });
  // The leading space of an entry's unstaged half survives parsing: v1 porcelain starts such a
  // line with a space, and `sh` trims what a CLI prints.
  expect(by("README.md").path).toBe("README.md");
  expect(by("new.txt")).toMatchObject({ untracked: true, staged: false });

  // A file can be in both lists at once, with different contents in each.
  await runSh(["git", "add", "README.md"], wt);
  await Bun.write(join(wt, "README.md"), "local\nedited\nagain\n");
  const both = await runLocalChanges(change, repo);
  expect(both.files.find((f) => f.path === "README.md")).toMatchObject({
    staged: true,
    unstaged: true,
  });

  // And the diff is of one or the other, which is why the staged flag travels with the request.
  expect(await runFileDiff(change, repo, "README.md", true)).toContain("+edited");
  expect(await runFileDiff(change, repo, "README.md", true)).not.toContain("+again");
  expect(await runFileDiff(change, repo, "README.md", false)).toContain("+again");

  // git knows nothing about an untracked file, so it is diffed against nothing.
  expect(await runFileDiff(change, repo, "new.txt", false)).toContain("+untracked");

  // A rename carries where it came from: the new name alone loses the point. A path with a
  // space in it survives, since the path is the last field and everything before it is counted.
  const v2 =
    "2 R. N... 100644 100644 100644 aaa bbb R100 new name\0old name\0" +
    "1 .M N... 100644 100644 100644 aaa bbb other\0";
  expect(parseStatus(v2)).toEqual([
    { path: "new name", index: "R", worktree: ".", staged: true, unstaged: false, untracked: false, from: "old name" },
    { path: "other", index: ".", worktree: "M", staged: false, unstaged: true, untracked: false, from: undefined },
  ]);
});

test("committing takes the files you ticked, in every repository at once", async () => {
  const { commitChange } = await import("../src/change/server/index.ts");
  const a = await clonedRepo("commit-a");
  const b = await clonedRepo("commit-b");
  const change = await changeFor("PROJ-COMMIT", [a, b]);
  await runEffect(provision(change));
  const wtA = (await runEffect(checkoutFor(change, a)))!;
  const wtB = (await runEffect(checkoutFor(change, b)))!;

  await Bun.write(join(wtA, "README.md"), "edited\n");
  await Bun.write(join(wtA, "new.txt"), "untracked\n"); // never seen by git before
  await Bun.write(join(wtA, "later.txt"), "not this time\n");
  await Bun.write(join(wtB, "README.md"), "also edited\n");

  // One message, one commit per repository: a change is one piece of work.
  const results = await runEffect(commitChange(change, {
    message: "PROJ-1 do the thing",
    files: { [a]: ["README.md", "new.txt"], [b]: ["README.md"] },
  }));
  expect(results.every((r) => r.ok)).toBe(true);
  expect(results.map((r) => r.name).sort()).toEqual(["commit-a", "commit-b"]);
  expect(results[0]!.hash).toMatch(/^[0-9a-f]{7,}$/);

  const subject = async (repo: string): Promise<string> =>
    (await runSh(["git", "log", "-1", "--pretty=%s"], repo)).stdout;
  expect(await subject(wtA)).toBe("PROJ-1 do the thing");
  expect(await subject(wtB)).toBe("PROJ-1 do the thing");

  // What was not ticked is still uncommitted, and nothing else was swept in.
  const left = await runLocalChanges(change, a);
  expect(left.files.map((f) => f.path)).toEqual(["later.txt"]);

  // A message is not optional, and neither is a file.
  expect(runEffect(commitChange(change, { message: "  ", files: { [a]: ["later.txt"] } }))).rejects.toThrow(
    /needs a message/,
  );
  expect(runEffect(commitChange(change, { message: "x", files: { [a]: [] } }))).rejects.toThrow(
    /select at least one file/,
  );
});

test("a repository that refuses to commit does not stop the others", async () => {
  const { commitChange } = await import("../src/change/server/index.ts");
  const good = await clonedRepo("commit-good");
  const change = await changeFor("PROJ-PARTIAL", [good]);
  await runEffect(provision(change));
  await Bun.write(join((await runEffect(checkoutFor(change, good)))!, "README.md"), "edited\n");

  // A repository of this change without a worktree: it says so, the other one still commits.
  const results = await runEffect(commitChange(change, {
    message: "PROJ-1 do the thing",
    files: { [good]: ["README.md"], "/nowhere/at/all": ["README.md"] },
  }));
  expect(results.find((r) => r.repo === good)?.ok).toBe(true);
  expect(results.find((r) => r.repo === "/nowhere/at/all")).toMatchObject({
    ok: false,
    error: "no worktree",
  });
});

test("what is committed but only here is counted, and pushing takes it away", async () => {
  const { pushChange } = await import("../src/change/server/index.ts");
  const repo = await clonedRepo("push");
  const change = await changeFor("PROJ-PUSH", [repo]);
  await runEffect(provision(change));
  const wt = (await runEffect(checkoutFor(change, repo)))!;

  // A branch that was never pushed has no upstream, so "ahead" says nothing: everything since
  // it left the base branch is unpushed, and that is what the button has to offer.
  await Bun.write(join(wt, "one.txt"), "1\n");
  await runSh(["git", "add", "."], wt);
  await commit(wt, "first");
  const before = await runLocalChanges(change, repo);
  expect(before).toMatchObject({ tracked: false, unpushed: 1 });

  const pushed = await runEffect(pushChange(change, [repo]));
  expect(pushed.every((r) => r.ok)).toBe(true);
  const after = await runLocalChanges(change, repo);
  // Now it has an upstream, and nothing is ahead of it.
  expect(after).toMatchObject({ tracked: true, unpushed: 0 });

  // A second commit is one ahead, which is the other way of counting the same thing.
  await Bun.write(join(wt, "two.txt"), "2\n");
  await runSh(["git", "add", "."], wt);
  await commit(wt, "second");
  expect(await runLocalChanges(change, repo)).toMatchObject({ tracked: true, unpushed: 1 });
  await runEffect(pushChange(change, [repo]));
  expect((await runLocalChanges(change, repo)).unpushed).toBe(0);

  // And a repository that is not there says so instead of stopping the push.
  const bad = await runEffect(pushChange(change, ["/nowhere/at/all"]));
  expect(bad[0]).toMatchObject({ ok: false, error: "no worktree" });
  expect(runEffect(pushChange(change, []))).rejects.toThrow(/nothing to push/);
});
