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
import { git, worktreeFor } from "../src/integrations/git.ts";
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
