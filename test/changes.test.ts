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

test("a completed change is listed once, even when its directory is left behind", async () => {
  const change = await createChange({ id: "PROJ-TWICE", repos: [repo] });
  await archiveChange(change.id);
  // A terminal, or a build, writing into the old path recreates it after the archive moved.
  await Bun.write(join(changeDir(change.id), "terminal.json"), "{}\n");

  const listed = (await listChanges()).filter((c) => c.id === "PROJ-TWICE");
  expect(listed.length).toBe(1);
});

test("directories left by finished changes are found, and only those", async () => {
  const { listLeftovers, removeLeftover } = await import("../src/leftovers.ts");
  const active = await createChange({ id: "PROJ-ALIVE", repos: [repo] });

  // A change that was completed: change.json moved to the archive, the directory stayed.
  const done = await createChange({ id: "PROJ-DONE", repos: [repo] });
  await archiveChange(done.id);
  await Bun.write(join(changeDir(done.id), "target", "build.jar"), "artifact\n");

  const leftovers = await listLeftovers();
  const names = leftovers.map((l) => l.name);
  expect(names).toContain("PROJ-DONE");
  expect(names).not.toContain(active.id); // an active change is not litter
  expect(names).not.toContain("archive"); // nor is the archive itself
  expect(leftovers.find((l) => l.name === "PROJ-DONE")?.entries).toEqual([
    { name: "target", directory: true },
  ]);

  // Deleting one takes the directory with it, and refuses to touch a change that is still live.
  expect(removeLeftover(active.id)).rejects.toThrow(/active change/);
  await removeLeftover("PROJ-DONE");
  expect(await Bun.file(join(changeDir("PROJ-DONE"), "target", "build.jar")).exists()).toBe(false);
  expect((await listLeftovers()).map((l) => l.name)).not.toContain("PROJ-DONE");
  // The archived change itself is untouched: only the leftover directory went.
  expect(await readChange("PROJ-DONE")).toMatchObject({ id: "PROJ-DONE" });
});

test("deleting a leftover with a worktree in it prunes the repository afterwards", async () => {
  const { listLeftovers, removeLeftover } = await import("../src/leftovers.ts");
  const change = await createChange({ id: "PROJ-WT-LEFT", branch: "PROJ-WT-LEFT-x", repos: [repo] });
  await git.provision!(change);
  // Resolved: the temporary directory is a symlink on macOS, and git reports where it lands.
  const worktree = (await worktreeFor(change, repo))!;
  expect(worktree).toBe(await realpath(join(changeDir(change.id), "myrepo")));

  // A change whose record is gone while its worktree is not: an interrupted creation, or a
  // change.json lost by hand. Completing removes worktrees first, so it cannot happen that way.
  await rm(join(changeDir(change.id), "change.json"));
  const listed = (await listLeftovers()).find((l) => l.name === change.id)!;
  // Shown as what it is, so the warning before deleting can say so.
  expect(listed.entries).toContainEqual({ name: "myrepo", directory: true, git: "worktree" });

  await removeLeftover(change.id);
  // git forgets the worktree as well: a stale registration would block reusing the path.
  const registered = await sh(["git", "worktree", "list"], repo);
  expect(registered.stdout).not.toContain(worktree);
});

test("a completion says which steps it will take, and where it stopped", async () => {
  const { progressOf, stepsFor } = await import("../src/complete.ts");
  const { writeSidecar } = await import("../src/changes.ts");
  const change = await createChange({ id: "PROJ-HALF", repos: [repo], jira: "PROJ-9" });

  // Named before anything runs, so the page can show what is still to come.
  const steps = stepsFor(change, {
    ready: true,
    reasons: [],
    toMerge: [{ repo, number: 7 }],
  });
  expect(steps.map((s) => s.id)).toEqual([
    `merge:${repo}`,
    "jira",
    "worktrees",
    "terminal",
    "archive",
  ]);
  expect(steps[0]!.label).toBe("merge myrepo #7");
  expect(steps.every((s) => s.state === "waiting")).toBe(true);

  // A completion that stopped: written to disk, so it is legible from a page opened later.
  expect(await progressOf(change.id)).toBeNull();

  await writeSidecar(
    change.id,
    "completion.json",
    JSON.stringify({
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      error: "could not merge #7: Merge conflict.",
      steps: [{ ...steps[0], state: "failed", detail: "could not merge #7: Merge conflict." }],
    }),
  );
  const stopped = (await progressOf(change.id))!;
  expect(stopped.error).toBe("could not merge #7: Merge conflict.");
  expect(stopped.steps[0]!.state).toBe("failed");

  // And it travels with the change when that is archived.
  await archiveChange(change.id);
  expect((await progressOf(change.id))?.error).toBe("could not merge #7: Merge conflict.");
  expect(await Bun.file(join(archiveDir(change.id), "completion.json")).exists()).toBe(true);
});

test("a completion records itself before it starts checking anything", async () => {
  const { completeChange, progressOf } = await import("../src/complete.ts");
  const change = await createChange({ id: "PROJ-EARLY", repos: [repo] });

  // Nothing yet: a change that was never completed has no record at all.
  expect(await progressOf(change.id)).toBeNull();

  // The repository has no remote, so the readiness check refuses. That refusal is recorded too:
  // it used to be a message in a dialog, which a page opened later would never see.
  expect(completeChange(change)).rejects.toThrow(/cannot complete/);
  await Bun.sleep(2000);
  const failed = (await progressOf(change.id))!;
  expect(failed.startedAt).toBeTruthy();
  expect(failed.steps[0]).toMatchObject({ id: "check", state: "failed" });
  expect(failed.steps[0]!.detail).toContain("no worktree");
  expect(failed.error).toContain("cannot complete");
  expect(failed.finishedAt).toBeTruthy();
}, 20_000);

test("the overview counts windows that are running something, not windows", async () => {
  const { busyWindows } = await import("../src/summary.ts");
  // A prompt is not work; a build, an editor and a server are.
  expect(
    busyWindows([
      { command: "zsh" },
      { command: "-zsh" },
      { command: "nvim" },
      { command: "gradle" },
      { command: "" }, // no session, or tmux told us nothing
    ]),
  ).toBe(2);

  // An agent says what it is doing, and is believed: pi at its prompt is `node`, which would
  // otherwise count as work for as long as the window stayed open.
  expect(
    busyWindows([
      { command: "node", agent: "working" },
      { command: "node", agent: "waiting" },
      { command: "node" }, // no marker: something is running, count it
    ]),
  ).toBe(2);
});

test("an agent's own account of itself is read from the @agent pane option", async () => {
  const { agentIn } = await import("../src/terminal.ts");
  // What pi's busy-title extension sets with `tmux set -p @agent ...`.
  expect(agentIn("working")).toBe("working");
  expect(agentIn("waiting")).toBe("waiting");
  // Unset, or set to something else by something else: no claim is made about the window.
  expect(agentIn("")).toBeUndefined();
  expect(agentIn("busy")).toBeUndefined();
});

test("a change is named after its ticket, and keeps that name when Jira is not there", async () => {
  const { refreshTitles } = await import("../src/titles.ts");
  const issue = (key: string, summary: string) => [
    key,
    { key, summary, type: "Story", assignee: "", status: "", sprint: "" },
  ];

  const named = await createChange({ id: "PROJ-NAMED", repos: [repo], jira: "PROJ-7" });
  const bare = await createChange({ id: "PROJ-BARE", repos: [repo] });

  // Captured rather than asserted inside: refreshTitles treats a failing lookup as "Jira is
  // not answering", which would swallow the failure and pass the test for the wrong reason.
  let asked: string[] = [];
  const titles = await refreshTitles(async (keys) => {
    asked = keys;
    return new Map(<any>[issue("PROJ-7", "Split the invoice export")]);
  });
  // One query for the whole page, and only for changes that have a ticket at all.
  expect(asked).toContain("PROJ-7");
  expect(asked).not.toContain("PROJ-BARE");
  expect(titles["PROJ-NAMED"]).toBe("Split the invoice export");
  expect(titles["PROJ-BARE"]).toBeUndefined(); // no ticket: the page falls back to the branch

  // Stored, so the list itself carries the name and the page needs no CLI call to draw.
  expect((await readChange(named.id))?.title).toBe("Split the invoice export");
  expect((await readChange(bare.id))?.title).toBeUndefined();

  // A renamed ticket is followed.
  await refreshTitles(async () => new Map(<any>[issue("PROJ-7", "Split the export in two")]));
  expect((await readChange(named.id))?.title).toBe("Split the export in two");

  // A Jira that answers nothing — down, unauthenticated, ticket deleted — keeps the last name
  // rather than falling back to a branch nobody recognises.
  const kept = await refreshTitles(async () => new Map());
  expect(kept["PROJ-NAMED"]).toBe("Split the export in two");
  expect((await readChange(named.id))?.title).toBe("Split the export in two");
});
