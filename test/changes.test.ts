import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import {
  createChange,
  listChanges,
  changeDir,
  archiveDir,
  archiveChange,
  readChange,
  writeChange,
  readNotes,
  writeNotes,
} from "../src/changes.ts";
import { git, worktreeFor, currentBranch } from "../src/integrations/git.ts";
import { sh } from "../src/sh.ts";

let tmp: string;
let repo: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "iwe-"));
  process.env.IWE_ROOT = join(tmp, "changes");
  repo = join(tmp, "myrepo");
  await sh(["git", "init", "-b", "main", repo]);
  await Bun.write(join(repo, "README.md"), "hi\n");
  await sh(["git", "add", "."], repo);
  await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], repo);
});

/** A repository with one commit on main, for the in-place tests. */
async function makeRepo(name: string): Promise<string> {
  const path = join(tmp, name);
  await sh(["git", "init", "-b", "main", path]);
  await Bun.write(join(path, "README.md"), `${name}\n`);
  await sh(["git", "add", "."], path);
  await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], path);
  return path;
}

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

test("create change, provision a worktree, report status, remove it", async () => {
  const change = await createChange({ id: "PROJ-1", repos: [repo] });
  expect(change.branch).toBe("PROJ-1");
  expect(await listChanges()).toHaveLength(1);

  const before = (await git.repoStatus!(change, repo))[0]!;
  expect(before.state).toBe("none");
  expect(before.actions?.[0]?.id).toBe("add");

  // wt is pointed at the change directory, so the worktree lives with the change's own state.
  // realpath on both sides: macOS temp dirs are symlinks into /private.
  await git.provision!(change);
  const found = await worktreeFor(change, repo);
  expect(await realpath(found!)).toBe(await realpath(join(changeDir(change.id), basename(repo))));
  expect(await Bun.file(join(found!, "README.md")).text()).toBe("hi\n");

  const after = (await git.repoStatus!(change, repo))[0]!;
  // Clean, but this fixture has no remote, so the branch is still only local.
  expect(after.state).toBe("pending");
  expect(after.detail).toContain("clean, no upstream");

  await git.run!(change, "remove", repo);
  expect((await git.repoStatus!(change, repo))[0]!.state).toBe("none");
});

test("rejects duplicate ids, unsafe ids and changes without repositories", async () => {
  await createChange({ id: "PROJ-2", repos: [repo] });
  expect(createChange({ id: "PROJ-2", repos: [repo] })).rejects.toThrow("already exists");
  expect(createChange({ id: "../escape", repos: [repo] })).rejects.toThrow("invalid change id");
  expect(createChange({ id: "PROJ-3" })).rejects.toThrow("at least one repository");
});

test("repo browser stays inside the configured root", async () => {
  const { resolveInRoot } = await import("../src/repos.ts");
  const { config } = await import("../src/config.ts");
  expect(resolveInRoot("personal/thing")).toBe(`${config.reposRoot}/personal/thing`);
  expect(resolveInRoot("")).toBe(config.reposRoot);
  // Traversal is rejected rather than silently reinterpreted, however it is spelled.
  expect(() => resolveInRoot("../../etc")).toThrow("outside repos root");
  expect(() => resolveInRoot("ok/../../../etc")).toThrow("outside repos root");
});

test("completed changes move to the archive and stay listable", async () => {
  const change = await createChange({ id: "PROJ-9", repos: [repo] });
  expect(await listChanges()).toContainEqual(change);

  await archiveChange(change.id);
  expect(await Bun.file(join(changeDir(change.id), "change.json")).exists()).toBe(false);
  expect(await Bun.file(join(archiveDir(change.id), "change.json")).exists()).toBe(true);

  // Reading, writing and listing all still find it where it now lives.
  expect(await readChange(change.id)).toEqual(change);
  const completed = { ...change, completedAt: new Date().toISOString() };
  await writeChange(completed);
  expect(await readChange(change.id)).toEqual(completed);
  expect(await listChanges()).toContainEqual(completed);
  expect(await listChanges()).not.toContainEqual(change);
});

test("a new worktree branches from the remote default, not a stale local main", async () => {
  // A bare origin, a clone whose main is behind it, and a change branching off.
  const origin = join(tmp, "origin.git");
  const clone = join(tmp, "clone");
  await sh(["git", "init", "-q", "--bare", "-b", "main", origin]);
  await sh(["git", "clone", "-q", origin, clone]);
  await Bun.write(join(clone, "f.txt"), "one\n");
  await sh(["git", "add", "."], clone);
  await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "one"], clone);
  await sh(["git", "push", "-q", "origin", "main"], clone);

  // Someone else pushes; our clone's local main is now behind by that commit.
  const other = join(tmp, "other");
  await sh(["git", "clone", "-q", origin, other]);
  await Bun.write(join(other, "f.txt"), "one\ntwo\n");
  await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "two"], other);
  await sh(["git", "push", "-q", "origin", "main"], other);

  const change = await createChange({ id: "PROJ-REMOTE", repos: [clone] });
  await git.provision!(change);

  const worktree = (await worktreeFor(change, clone))!;
  expect(await Bun.file(join(worktree, "f.txt")).text()).toBe("one\ntwo\n");
});

test("a change starts in progress and completing it is what sets Completed", async () => {
  const change = await createChange({ id: "PROJ-STATE", repos: [repo] });
  expect(change.state).toBe("In Progress");

  // Completing writes the state along with the timestamp; here just the shape of that write.
  await writeChange({ ...change, state: "Awaiting Review" });
  expect((await readChange(change.id))?.state).toBe("Awaiting Review");
});

test("notes live beside change.json and survive archiving", async () => {
  const change = await createChange({ id: "PROJ-NOTES", repos: [repo] });
  expect(await readNotes(change.id)).toBe(""); // nothing written yet

  await writeNotes(change.id, "ask about the flag\n");
  expect(await readNotes(change.id)).toBe("ask about the flag\n");

  await archiveChange(change.id);
  expect(await readNotes(change.id)).toBe("ask about the flag\n");
});

test("a repository used in place is linked and switched, dirty ones are left alone", async () => {
  const { setRepos, isDirect } = await import("../src/integrations/git.ts");
  const clean = await makeRepo("clean");
  const dirty = await makeRepo("dirty");
  await Bun.write(join(dirty, "scratch.txt"), "half-finished work\n");

  const change = await createChange({
    id: "PROJ-DIRECT",
    branch: "PROJ-DIRECT-work",
    repos: [clean, dirty],
    direct: [clean, dirty],
  });
  expect(isDirect(change, clean)).toBe(true);
  await git.provision!(change);

  // Both are linked from the change directory, so it still shows everything the change touches.
  for (const repo of [clean, dirty]) {
    expect(await realpath(join(changeDir(change.id), basename(repo)))).toBe(await realpath(repo));
  }
  // The clean one moved to the branch; the dirty one kept its own, uncommitted work intact.
  expect(await currentBranch(clean)).toBe("PROJ-DIRECT-work");
  expect(await currentBranch(dirty)).toBe("main");
  expect(await Bun.file(join(dirty, "scratch.txt")).text()).toBe("half-finished work\n");

  // Dropping it removes the link only: the checkout and its branch stay.
  const result = await setRepos(change, [dirty], true, [dirty]);
  expect("change" in result).toBe(true);
  expect(await Bun.file(join(changeDir(change.id), "clean")).exists()).toBe(false);
  expect(await currentBranch(clean)).toBe("PROJ-DIRECT-work");
});

test("a worktree starts from the base branch it was given, not the remote default", async () => {
  // A repository with main, plus a branch ahead of it that another change might be sitting on.
  const origin = await makeRepo("stack-origin");
  await sh(["git", "switch", "-c", "PROJ-1-first"], origin);
  await Bun.write(join(origin, "first.txt"), "work of the change below\n");
  await sh(["git", "add", "."], origin);
  await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "first"], origin);
  await sh(["git", "switch", "main"], origin);

  const clone = join(tmp, "stacked");
  await sh(["git", "clone", "--quiet", origin, clone]);

  const change = await createChange({
    id: "PROJ-STACK",
    branch: "PROJ-STACK-second",
    repos: [clone],
    base: { [clone]: "origin/PROJ-1-first" },
  });
  await git.provision!(change);

  // The file only the base branch has must be there: the new branch grew out of it.
  const worktree = (await worktreeFor(change, clone))!;
  expect(await Bun.file(join(worktree, "first.txt")).text()).toBe("work of the change below\n");

  // And a change without a base still starts from the remote default, which has no such file.
  const plain = await createChange({ id: "PROJ-PLAIN", branch: "PROJ-PLAIN-x", repos: [clone] });
  await git.provision!(plain);
  const plainTree = (await worktreeFor(plain, clone))!;
  expect(await Bun.file(join(plainTree, "first.txt")).exists()).toBe(false);
});
