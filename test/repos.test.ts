import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { createChange, changeDir } from "../apps/server/src/change/server/index.ts";
import {
  setRepos,
  checkoutFor,
  currentBranch,
  unsafeToRemove,
  repoStates,
  isInPlace,
} from "../apps/server/src/vendors/git.ts";
import { checkoutsOf, runEffect, runFileDiff, runLocalChanges, runSetRepos, runSh  } from "./helpers.ts";
import type { Result } from "../apps/server/src/capabilities/shell.ts";
import { provisionChangeRepositories } from "../apps/server/src/change/provisioning.ts";
import type { Change } from "../apps/server/src/domain/change.ts";
import type { FileChange } from "@corvi/contracts/integrations/review";

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
  runEffect(createChange({ id, branch: `${id}-work`, checkouts: checkoutsOf(repos, direct) }));

beforeAll(async () => {
  // Resolved: on macOS the temporary directory is a symlink, and git reports where it lands.
  tmp = await realpath(await mkdtemp(join(tmpdir(), "corvi-repos-")));
  process.env.CORVI_ROOT = join(tmp, "changes");
  process.env.CORVI_ARCHIVE_ROOT = join(tmp, "changes-archive");
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

test("adding a repository creates its worktree, removing one takes it away", async () => {
  const a = await clonedRepo("add-a");
  const b = await clonedRepo("add-b");
  const change = await changeFor("PROJ-ADD", [a]);
  await runEffect(provisionChangeRepositories(change));
  expect(await runEffect(checkoutFor(change, a))).toBe(join(changeDir(change), "add-a"));

  const added = await runSetRepos(change, checkoutsOf([a, b]));
  expect("change" in added).toBe(true);
  const withBoth = (added as { change: Change }).change;
  expect(await runEffect(checkoutFor(withBoth, b))).toBe(join(changeDir(change), "add-b"));

  // Nothing was committed in b, so dropping it destroys nothing and needs no confirmation.
  const dropped = await runSetRepos(withBoth, checkoutsOf([a]));
  expect("change" in dropped).toBe(true);
  expect(((dropped as { change: Change }).change.checkouts ?? []).map((spec) => spec.path)).toEqual([a]);
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
  await runEffect(provisionChangeRepositories(change));

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
  await runEffect(provisionChangeRepositories(change));

  const worktree = (await runEffect(checkoutFor(change, repo)))!;
  await Bun.write(join(worktree, "work.txt"), "never pushed\n");
  await runSh(["git", "add", "."], worktree);
  await commit(worktree, "work nobody else has");
  expect((await runEffect(unsafeToRemove(change, repo)))?.kind).toBe("unpushed");

  // Asked, not done: the worktree and its commit are still there.
  const asked = await runSetRepos(change, checkoutsOf([keep]));
  expect(asked).toEqual({ needsForce: ["unpushed"] });
  expect(await runEffect(checkoutFor(change, repo))).toBe(worktree);
  expect(await Bun.file(join(worktree, "work.txt")).exists()).toBe(true);

  const forced = await runSetRepos(change, checkoutsOf([keep]), true);
  expect("change" in forced).toBe(true);
  expect(await runEffect(checkoutFor(change, repo))).toBeUndefined();
});

test("uncommitted work refuses the removal outright, forced or not", async () => {
  const repo = await clonedRepo("dirty");
  const keep = await clonedRepo("dirty-keep");
  const change = await changeFor("PROJ-DIRTY", [repo, keep]);
  await runEffect(provisionChangeRepositories(change));

  const worktree = (await runEffect(checkoutFor(change, repo)))!;
  await Bun.write(join(worktree, "half-done.txt"), "not finished\n");
  expect((await runEffect(unsafeToRemove(change, repo)))?.kind).toBe("dirty");

  // Force is for commits that can be recovered from the reflog; this cannot be recovered at all.
  expect(runSetRepos(change, checkoutsOf([keep]))).rejects.toThrow(/uncommitted changes/);
  expect(runSetRepos(change, checkoutsOf([keep]), true)).rejects.toThrow(/uncommitted changes/);
  expect(await Bun.file(join(worktree, "half-done.txt")).exists()).toBe(true);
});

test("dropping a checkout used in place asks about uncommitted work instead of refusing", async () => {
  const repo = await clonedRepo("ask-in-place");
  const keep = await clonedRepo("ask-keep");
  const change = await changeFor("PROJ-ASK", [repo, keep], [repo]);
  await runEffect(provisionChangeRepositories(change));

  // Uncommitted work in the repository's own checkout: dropping the row destroys nothing — it
  // removes a link — so the work is a question to answer, not a refusal.
  await Bun.write(join(repo, "half-done.txt"), "not finished\n");
  expect(await runSetRepos(change, checkoutsOf([keep]))).toEqual({ needsForce: ["ask-in-place"] });
  expect(await Bun.file(join(repo, "half-done.txt")).exists()).toBe(true);

  // Answered yes, the row goes and the checkout is left exactly as it stands.
  const forced = await runSetRepos(change, checkoutsOf([keep]), true);
  expect("change" in forced).toBe(true);
  expect(await Bun.file(join(repo, "half-done.txt")).exists()).toBe(true);
  expect(await runEffect(currentBranch(repo))).toBe(change.branch);
});

test("switching a repository from worktree to in place moves the work, not deletes it", async () => {
  const repo = await clonedRepo("switch");
  const change = await changeFor("PROJ-SWITCH", [repo]);
  await runEffect(provisionChangeRepositories(change));

  const worktree = (await runEffect(checkoutFor(change, repo)))!;
  await Bun.write(join(worktree, "committed.txt"), "pushed work\n");
  await runSh(["git", "add", "."], worktree);
  await commit(worktree, "work");
  await runSh(["git", "push", "--quiet", "-u", "origin", change.branch], worktree);

  // Pushed, so nothing is at risk and the switch goes through unforced.
  const result = await runSetRepos(change, checkoutsOf([repo], [repo]), false);
  expect("change" in result).toBe(true);
  const direct = (result as { change: Change }).change;
  expect(isInPlace(direct, repo)).toBe(true);

  // The repository itself is now on the branch, with the commit that was made in the worktree.
  expect(await runEffect(currentBranch(repo))).toBe(change.branch);
  expect(await Bun.file(join(repo, "committed.txt")).text()).toBe("pushed work\n");
  // And the change directory links to it instead of holding a checkout of its own.
  expect(await runEffect(checkoutFor(direct, repo))).toBe(repo);
  // The row reads as the spec stands: used where it is, on the change's branch — and the base
  // is what was chosen, not the default the picker would show.
  expect(await runEffect(repoStates(direct))).toMatchObject([
    { location: "original", branch: { kind: "change" } },
  ]);
});

test("a change may be emptied and filled again, which is how a worktree is replaced", async () => {
  // Taking a repository out and putting it back is the way to get a fresh worktree when the one
  // you have is beyond saving, and that has a moment in the middle with nothing in it.
  const repo = await clonedRepo("last-one");
  const change = await changeFor("PROJ-LAST", [repo]);
  await runEffect(provisionChangeRepositories(change));
  const before = (await runEffect(checkoutFor(change, repo)))!;

  // Emptying is still a removal, and a removal still refuses to throw work away: the way out of
  // a worktree you have made a mess of is to commit or revert first, not to drop it silently.
  await Bun.write(join(before, "junk.txt"), "uncommitted\n");
  expect(runSetRepos(change, checkoutsOf([]))).rejects.toThrow(/uncommitted changes/);
  await rm(join(before, "junk.txt"));

  const emptied = await runSetRepos(change, checkoutsOf([]));
  expect("change" in emptied).toBe(true);
  const none = (emptied as { change: Change }).change;
  expect(((none).checkouts ?? []).map((spec) => spec.path)).toEqual([]);
  expect(await runEffect(checkoutFor(none, repo))).toBeUndefined();

  const refilled = await runSetRepos(none, checkoutsOf([repo]));
  const again = (refilled as { change: Change }).change;
  expect(((again).checkouts ?? []).map((spec) => spec.path)).toEqual([repo]);
  // The same place, but a new checkout: this is what re-worktreeing gets you.
  expect(await runEffect(checkoutFor(again, repo))).toBe(before);
  expect(await Bun.file(join(before, "README.md")).exists()).toBe(true);
});

test("switching modes with unpushed commits asks first, and keeps them when forced", async () => {
  const repo = await clonedRepo("switch-unpushed");
  const change = await changeFor("PROJ-SWITCH-UNPUSHED", [repo]);
  await runEffect(provisionChangeRepositories(change));

  const worktree = (await runEffect(checkoutFor(change, repo)))!;
  await Bun.write(join(worktree, "unpushed.txt"), "only here\n");
  await runSh(["git", "add", "."], worktree);
  await commit(worktree, "work nobody else has");

  // The worktree goes either way, so the question is asked, exactly as for a removal.
  expect(await runSetRepos(change, checkoutsOf([repo], [repo]), false)).toEqual({ needsForce: ["switch-unpushed"] });

  // Forced, the mode changes and the commit survives: the branch is kept and checked out in the
  // repository itself, which is the whole point of the switch.
  const result = await runSetRepos(change, checkoutsOf([repo], [repo]), true);
  expect("change" in result).toBe(true);
  expect(await runEffect(currentBranch(repo))).toBe(change.branch);
  expect(await Bun.file(join(repo, "unpushed.txt")).text()).toBe("only here\n");
});

test("an in-place branch does not track the branch it started from", async () => {
  const repo = await clonedRepo("no-track");
  const change = await changeFor("PROJ-TRACK", [repo], [repo]);
  await runEffect(provisionChangeRepositories(change));

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

test("a removal deletes a branch whose content landed and keeps one whose did not", async () => {
  const merged = await clonedRepo("branch-merged");
  const open = await clonedRepo("branch-open");
  const change = await changeFor("PROJ-BRANCH", [merged, open]);
  await runEffect(provisionChangeRepositories(change));

  // Two commits, so no single commit's patch-id matches what a squash merge leaves behind: this
  // is the case that only a simulated merge can prove, and the reason this is Corvi's own rule
  // rather than a plain `git branch -d`.
  const mergedTree = (await runEffect(checkoutFor(change, merged)))!;
  await Bun.write(join(mergedTree, "one.txt"), "1\n");
  await runSh(["git", "add", "."], mergedTree);
  await commit(mergedTree, "first");
  await Bun.write(join(mergedTree, "two.txt"), "2\n");
  await runSh(["git", "add", "."], mergedTree);
  await commit(mergedTree, "second");
  // The remote's main gets the same content in one commit, as `gh pr merge --squash` leaves it.
  await runSh(["git", "merge", "--squash", change.branch], merged);
  await commit(merged, "squash the branch");
  await runSh(["git", "push", "--quiet", "origin", "main"], merged);
  await runSh(["git", "fetch", "--quiet", "origin"], merged);

  // The other branch holds a commit nobody else has: real work, and it stays. It is deliberately
  // never pushed, so pushing-and-losing is not what is under test — the question is.
  const openTree = (await runEffect(checkoutFor(change, open)))!;
  await Bun.write(join(openTree, "open.txt"), "still to land\n");
  await runSh(["git", "add", "."], openTree);
  await commit(openTree, "not merged yet");

  // The squash-merged branch is not a warning: the cheap proofs call it diverged (its commits are
  // neither ancestors nor patch-identical), so the simulated merge is what proves the content
  // landed — and nothing is asked of anyone.
  expect(await runEffect(unsafeToRemove(change, merged))).toBeUndefined();
  const dropped = await runSetRepos(change, checkoutsOf([open]));
  expect("change" in dropped).toBe(true);
  expect(await runEffect(checkoutFor(change, merged))).toBeUndefined();

  // Nothing left to contribute: gone, so a completed change does not leave a branch per repo.
  expect((await runSh(["git", "branch", "--list", change.branch], merged)).stdout).toBe("");

  // The unmerged branch still asks — its commits exist nowhere else — and forcing keeps the
  // branch, which is what the commits are findable by.
  const remaining = (dropped as { change: Change }).change;
  expect(await runSetRepos(remaining, checkoutsOf([]), false)).toEqual({ needsForce: ["branch-open"] });
  const emptied = await runSetRepos(remaining, checkoutsOf([]), true);
  expect("change" in emptied).toBe(true);
  expect(await runEffect(checkoutFor(change, open))).toBeUndefined();
  const kept = await runSh(
    ["git", "branch", "--list", "--format=%(refname:short)", change.branch],
    open,
  );
  expect(kept.stdout.trim()).toBe(change.branch);
});

test("a branch whose merge conflicts with main is kept, not forced away", async () => {
  const repo = await clonedRepo("conflict");
  const change = await changeFor("PROJ-CONFLICT", [repo]);
  await runEffect(provisionChangeRepositories(change));

  // Both sides change the same file, so there is no patch-identical commit to find and no merge
  // that lands on main's tree: the branch cannot be proven to have landed anywhere.
  const worktree = (await runEffect(checkoutFor(change, repo)))!;
  await Bun.write(join(worktree, "README.md"), "branch version\n");
  await runSh(["git", "add", "."], worktree);
  await commit(worktree, "branch version");
  await Bun.write(join(repo, "README.md"), "main version\n");
  await runSh(["git", "add", "."], repo);
  await commit(repo, "main version");
  await runSh(["git", "push", "--quiet", "origin", "main"], repo);
  await runSh(["git", "fetch", "--quiet", "origin"], repo);

  const emptied = await runSetRepos(change, checkoutsOf([]), true);
  expect("change" in emptied).toBe(true);
  expect(await runEffect(checkoutFor(change, repo))).toBeUndefined();
  // Doubt keeps the branch: the commit exists only there, and a removal that guessed would
  // delete the only pointer to it.
  const kept = await runSh(
    ["git", "branch", "--list", "--format=%(refname:short)", change.branch],
    repo,
  );
  expect(kept.stdout.trim()).toBe(change.branch);
});

test("a worktree from before Corvi owned the path is adopted, not migrated", async () => {
  // A change provisioned when wt owned the layout has an ordinary git worktree at exactly the path
  // Corvi computes now, plus a wt.toml beside change.json. Both are left as they are: provisioning
  // finds the checkout that is there, and the old config is neither read nor rewritten.
  const repo = await clonedRepo("legacy");
  const change = await changeFor("PROJ-LEGACY", [repo]);
  const path = join(changeDir(change), basename(repo));
  const config = `worktree-path = "${changeDir(change)}/{{ repo }}"\n`;
  const legacy = join(changeDir(change), "wt.toml");
  await runSh(
    ["git", "-c", "branch.autoSetupMerge=false", "worktree", "add", "-b", change.branch, path, "origin/main"],
    repo,
  );
  await Bun.write(legacy, config);
  await Bun.write(join(path, "made-before-corvi.txt"), "still here\n");

  // The change:created hook, which is what meets a worktree that already exists.
  await runEffect(provisionChangeRepositories(change));
  expect(await runEffect(checkoutFor(change, repo))).toBe(path);
  expect(await Bun.file(join(path, "made-before-corvi.txt")).text()).toBe("still here\n");
  // The repository's own checkout and the change's, and no third one made beside it.
  const listed = await runSh(["git", "worktree", "list", "--porcelain"], repo);
  expect(listed.stdout.match(/^worktree /gm)?.length).toBe(2);
  expect(await Bun.file(legacy).text()).toBe(config);

  // The marker goes before the removal: it is untracked, and a removal refuses a dirty worktree by
  // design, which is not what this test is about.
  await rm(join(path, "made-before-corvi.txt"));

  // And it is removed like any other: the branch had nothing on it, so it goes too.
  const emptied = await runSetRepos(change, checkoutsOf([]));
  expect("change" in emptied).toBe(true);
  expect(await runEffect(checkoutFor(change, repo))).toBeUndefined();
  expect((await runSh(["git", "branch", "--list", change.branch], repo)).stdout).toBe("");
});

test("two repositories with the same name are refused, at creation and at an edit", async () => {
  const first = await clonedRepo("clash");
  await mkdir(join(tmp, "elsewhere"), { recursive: true });
  const second = join(tmp, "elsewhere", "clash");
  await runSh(["git", "clone", "--quiet", first, second]);
  await runSh(["git", "config", "user.email", "t@t"], second);
  await runSh(["git", "config", "user.name", "t"], second);

  // Both would be filed in the change directory as `clash`, one on top of the other, so the list
  // is refused before anything is created or moved.
  expect(
    runEffect(createChange({ id: "PROJ-CLASH", branch: "PROJ-CLASH", checkouts: checkoutsOf([first, second]) })),
  ).rejects.toThrow(/share the name clash/);

  const single = await changeFor("PROJ-CLASH-ONE", [first]);
  await runEffect(provisionChangeRepositories(single));
  expect(runSetRepos(single, checkoutsOf([first, second]), true)).rejects.toThrow(/share the name clash/);
  // Refused before anything moved, so the worktree is still where it was.
  expect(await runEffect(checkoutFor(single, first))).toBe(join(changeDir(single), "clash"));
});

test("uncommitted work is listed as git sees it, staged and unstaged apart", async () => {
  const { parseStatus } = await import("../apps/server/src/integrations/review/server.ts");
  const repo = await clonedRepo("local");
  const change = await changeFor("PROJ-LOCAL", [repo]);
  await runEffect(provisionChangeRepositories(change));
  const worktree = (await runEffect(checkoutFor(change, repo)))!;

  // Nothing yet, which is a state of its own and not an error.
  expect((await runLocalChanges(change, repo)).files).toEqual([]);

  await Bun.write(join(worktree, "README.md"), "local\nedited\n");
  await Bun.write(join(worktree, "added.txt"), "staged\n");
  await Bun.write(join(worktree, "new.txt"), "untracked\n");
  await runSh(["git", "add", "added.txt"], worktree);

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
  await runSh(["git", "add", "README.md"], worktree);
  await Bun.write(join(worktree, "README.md"), "local\nedited\nagain\n");
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
