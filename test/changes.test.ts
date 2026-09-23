import { runtimeConfig } from "../apps/server/src/workspace/server/index.ts";
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
} from "../apps/server/src/change/server/index.ts";
import { provisionRepo, gitRun, repoItem, checkoutFor, currentBranch, unsafeToRemove } from "../apps/server/src/vendors/git.ts";
import { Effect } from "effect";
import type { Change } from "../apps/server/src/domain/change.ts";
import type { TmuxWindow } from "../apps/server/src/integrations/types.ts";
import type { PresentedWindow } from "../apps/server/src/terminals/server/index.ts";
import { checkoutsOf, runEffect, runSetRepos, runSh, withRuntimeConfig  } from "./helpers.ts";

let tmp: string;
let repo: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "corvi-"));
  process.env.CORVI_ROOT = join(tmp, "changes");
  process.env.CORVI_ARCHIVE_ROOT = join(tmp, "changes-archive");
  repo = join(tmp, "myrepo");
  await runSh(["git", "init", "-b", "main", repo]);
  await Bun.write(join(repo, "README.md"), "hi\n");
  await runSh(["git", "add", "."], repo);
  await runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], repo);
});

/** A repository with one commit on main, for the in-place tests. */
async function makeRepo(name: string): Promise<string> {
  const path = join(tmp, name);
  await runSh(["git", "init", "-b", "main", path]);
  await Bun.write(join(path, "README.md"), `${name}\n`);
  await runSh(["git", "add", "."], path);
  await runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], path);
  return path;
}

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

test("create change, provision a worktree, report status, remove it", async () => {
  const change = await runEffect(createChange({ id: "PROJ-1", checkouts: checkoutsOf([repo]) }));
  expect(change.branch).toBe("PROJ-1");
  expect(await runEffect(listChanges())).toHaveLength(1);

  const before = await Effect.runPromise(repoItem(change, repo));
  expect(before.state).toBe("none");
  expect(before.actions?.[0]?.id).toBe("add");

  // The worktree lives in the change directory, with the change's own state.
  // realpath on both sides: macOS temp dirs are symlinks into /private.
  // The same checkouts the git extension's change:created hook creates.
  await Effect.runPromise(Effect.forEach(((change).checkouts ?? []).map((spec) => spec.path), (repo) => provisionRepo(change, repo), { concurrency: 1 }));
  const found = await runEffect(checkoutFor(change, repo));
  expect(await realpath(found!)).toBe(await realpath(join(changeDir(change.id), basename(repo))));
  expect(await Bun.file(join(found!, "README.md")).text()).toBe("hi\n");

  const after = await Effect.runPromise(repoItem(change, repo));
  // Clean, but this fixture has no remote, so the branch is still only local.
  expect(after.state).toBe("pending");
  expect(after.detail).toContain("clean, no upstream");

  await Effect.runPromise(gitRun(change, "remove", repo));
  expect((await Effect.runPromise(repoItem(change, repo))).state).toBe("none");
});

test("rejects duplicate ids, unsafe ids and changes without repositories", async () => {
  await runEffect(createChange({ id: "PROJ-2", checkouts: checkoutsOf([repo]) }));
  expect(runEffect(createChange({ id: "PROJ-2", checkouts: checkoutsOf([repo]) }))).rejects.toThrow("already exists");
  expect(runEffect(createChange({ id: "../escape", checkouts: checkoutsOf([repo]) }))).rejects.toThrow("invalid change id");
  expect(runEffect(createChange({ id: "PROJ-3" }))).rejects.toThrow("at least one repository");
});

test("a creation cannot put a new worktree on a checkout's current branch", async () => {
  // The one cell of the location × branch product that cannot exist: the branch a source
  // checkout has checked out is live there, and cannot also live in a worktree.
  await expect(
    runEffect(
      createChange({
        id: "PROJ-IMPOSSIBLE",
        checkouts: [{ path: repo, location: "new", branch: { kind: "current" } }],
      }),
    ),
  ).rejects.toThrow(/cannot use the branch/);
  await expect(
    runEffect(
      createChange({
        id: "PROJ-UNNAMED",
        checkouts: [{ path: repo, location: "new", branch: { kind: "existing", name: "" } }],
      }),
    ),
  ).rejects.toThrow(/must be named/);
});

test("completed changes move to the archive and stay listable", async () => {
  const change = await runEffect(createChange({ id: "PROJ-9", checkouts: checkoutsOf([repo]) }));
  // The record on disk carries the revision the write gave it; the created value is the draft.
  expect(await runEffect(listChanges())).toContainEqual({ ...change, revision: 1 });

  await runEffect(archiveChange(change.id));
  expect(await Bun.file(join(changeDir(change.id), "change.json")).exists()).toBe(false);
  expect(await Bun.file(join(archiveDir(change.id), "change.json")).exists()).toBe(true);

  // Reading, writing and listing all still find it where it now lives.
  expect(await runEffect(readChange(change.id))).toEqual({ ...change, revision: 1 });
  const completed = { ...change, completedAt: new Date().toISOString() };
  await runEffect(writeChange(completed));
  // The write moved the record on again; the revision is why a transition decided on the old
  // one would be refused instead of overwriting this.
  expect(await runEffect(readChange(change.id))).toEqual({ ...completed, revision: 2 });
  expect(await runEffect(listChanges())).toContainEqual({ ...completed, revision: 2 });
  expect(await runEffect(listChanges())).not.toContainEqual({ ...change, revision: 1 });
});

test("a new worktree branches from the remote default, not a stale local main", async () => {
  // A bare origin, a clone whose main is behind it, and a change branching off.
  const origin = join(tmp, "origin.git");
  const clone = join(tmp, "clone");
  await runSh(["git", "init", "-q", "--bare", "-b", "main", origin]);
  await runSh(["git", "clone", "-q", origin, clone]);
  await Bun.write(join(clone, "f.txt"), "one\n");
  await runSh(["git", "add", "."], clone);
  await runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "one"], clone);
  await runSh(["git", "push", "-q", "origin", "main"], clone);

  // Someone else pushes; our clone's local main is now behind by that commit.
  const other = join(tmp, "other");
  await runSh(["git", "clone", "-q", origin, other]);
  await Bun.write(join(other, "f.txt"), "one\ntwo\n");
  await runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "two"], other);
  await runSh(["git", "push", "-q", "origin", "main"], other);

  const change = await runEffect(createChange({ id: "PROJ-REMOTE", checkouts: checkoutsOf([clone]) }));
  // The same checkouts the git extension's change:created hook creates.
  await Effect.runPromise(Effect.forEach(((change).checkouts ?? []).map((spec) => spec.path), (repo) => provisionRepo(change, repo), { concurrency: 1 }));

  const worktree = (await runEffect(checkoutFor(change, clone)))!;
  expect(await Bun.file(join(worktree, "f.txt")).text()).toBe("one\ntwo\n");
});

test("a worktree branch does not track the branch it started from", async () => {
  // Tracking origin/main would make a bare `git push` in the worktree aim at main, which is the
  // one thing this must never do. A fresh branch has no upstream until it is pushed.
  const origin = await makeRepo("track-origin");
  const clone = join(tmp, "track-clone");
  await runSh(["git", "clone", "--quiet", origin, clone]);

  const change = await runEffect(
    createChange({ id: "PROJ-TRACK-WT", branch: "PROJ-TRACK-WT-work", checkouts: checkoutsOf([clone]) }),
  );
  // The same checkouts the git extension's change:created hook creates.
  await Effect.runPromise(Effect.forEach(((change).checkouts ?? []).map((spec) => spec.path), (repo) => provisionRepo(change, repo), { concurrency: 1 }));
  const worktree = (await runEffect(checkoutFor(change, clone)))!;

  const upstream = await runSh(
    ["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    worktree,
  );
  expect(upstream.code).not.toBe(0);
  // And it did start from main, so nothing main has is missing from it.
  const base = await runSh(["git", "rev-list", "--count", `origin/main..${change.branch}`], worktree);
  expect(base.stdout).toBe("0");
});

test("a repository with no remote starts the worktree from its own default branch", async () => {
  // The repository is left on a branch of its own: the worktree must still grow out of main,
  // because that is the default branch a repository without `origin/main` has — and what wt used.
  const local = await makeRepo("local-only");
  await runSh(["git", "switch", "-q", "-c", "side-work"], local);
  await Bun.write(join(local, "side.txt"), "not this\n");
  await runSh(["git", "add", "."], local);
  await runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "side"], local);
  await runSh(["git", "switch", "-q", "main"], local);
  await Bun.write(join(local, "main.txt"), "the default branch\n");
  await runSh(["git", "add", "."], local);
  await runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "main"], local);
  // Back to the side branch, so the checkout's HEAD is not the default branch.
  await runSh(["git", "switch", "-q", "side-work"], local);

  const change = await runEffect(
    createChange({ id: "PROJ-LOCAL", branch: "PROJ-LOCAL-work", checkouts: checkoutsOf([local]) }),
  );
  // The same checkouts the git extension's change:created hook creates.
  await Effect.runPromise(Effect.forEach(((change).checkouts ?? []).map((spec) => spec.path), (repo) => provisionRepo(change, repo), { concurrency: 1 }));

  const worktree = (await runEffect(checkoutFor(change, local)))!;
  expect(await Bun.file(join(worktree, "main.txt")).text()).toBe("the default branch\n");
  expect(await Bun.file(join(worktree, "side.txt")).exists()).toBe(false);
});

test("commits on a repository with no remote still ask before a removal", async () => {
  // No remote means no upstream to be ahead of and no `origin/main` to measure against. The
  // repository's own main is what they are measured against, and commits it does not have exist
  // only on that branch: a removal asks rather than assuming they landed somewhere.
  const local = await makeRepo("no-remote-work");
  const change = await runEffect(
    createChange({ id: "PROJ-NOREMOTE", branch: "PROJ-NOREMOTE-work", checkouts: checkoutsOf([local]) }),
  );
  // The same checkouts the git extension's change:created hook creates.
  await Effect.runPromise(Effect.forEach(((change).checkouts ?? []).map((spec) => spec.path), (repo) => provisionRepo(change, repo), { concurrency: 1 }));
  const worktree = (await runEffect(checkoutFor(change, local)))!;
  await Bun.write(join(worktree, "work.txt"), "only here\n");
  await runSh(["git", "add", "."], worktree);
  await runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "work"], worktree);

  expect((await runEffect(unsafeToRemove(change, local)))?.kind).toBe("unpushed");
  expect(await runSetRepos(change, checkoutsOf([]), false)).toEqual({ needsForce: ["no-remote-work"] });
  // Asked, not done: the worktree and its commit are still there.
  expect(await runEffect(checkoutFor(change, local))).toBe(worktree);
});

test("a change starts in progress and completing it is what sets Completed", async () => {
  const change = await runEffect(createChange({ id: "PROJ-STATE", checkouts: checkoutsOf([repo]) }));
  expect(change.state).toBe("Implementation");

  // Completing writes the state along with the timestamp; here just the shape of that write.
  await runEffect(writeChange({ ...change, state: "Verification" }));
  expect((await runEffect(readChange(change.id)))?.state).toBe("Verification");
});

test("a repository used in place is linked and switched, dirty ones are left alone", async () => {
  const { setRepos, isInPlace } = await import("../apps/server/src/vendors/git.ts");
  const clean = await makeRepo("clean");
  const dirty = await makeRepo("dirty");
  await Bun.write(join(dirty, "scratch.txt"), "half-finished work\n");

  const change = await runEffect(createChange({
    id: "PROJ-DIRECT",
    branch: "PROJ-DIRECT-work",
    checkouts: checkoutsOf([clean, dirty], [clean, dirty]),
  }));
  expect(isInPlace(change, clean)).toBe(true);
  // The same checkouts the git extension's change:created hook creates.
  await Effect.runPromise(Effect.forEach(((change).checkouts ?? []).map((spec) => spec.path), (repo) => provisionRepo(change, repo), { concurrency: 1 }));

  // Both are linked from the change directory, so it still shows everything the change touches.
  for (const repo of [clean, dirty]) {
    expect(await realpath(join(changeDir(change.id), basename(repo)))).toBe(await realpath(repo));
  }
  // The clean one moved to the branch; the dirty one kept its own, uncommitted work intact.
  expect(await runEffect(currentBranch(clean))).toBe("PROJ-DIRECT-work");
  expect(await runEffect(currentBranch(dirty))).toBe("main");
  expect(await Bun.file(join(dirty, "scratch.txt")).text()).toBe("half-finished work\n");

  // Dropping it removes the link only: the checkout and its branch stay.
  const result = await runEffect(setRepos(change, checkoutsOf([dirty], [dirty]), true));
  expect(result._tag).toBe("Done");
  expect(await Bun.file(join(changeDir(change.id), "clean")).exists()).toBe(false);
  expect(await runEffect(currentBranch(clean))).toBe("PROJ-DIRECT-work");
});

test("a worktree starts from the base branch it was given, not the remote default", async () => {
  // A repository with main, plus a branch ahead of it that another change might be sitting on.
  const origin = await makeRepo("stack-origin");
  await runSh(["git", "switch", "-c", "PROJ-1-first"], origin);
  await Bun.write(join(origin, "first.txt"), "work of the change below\n");
  await runSh(["git", "add", "."], origin);
  await runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "first"], origin);
  await runSh(["git", "switch", "main"], origin);

  const clone = join(tmp, "stacked");
  await runSh(["git", "clone", "--quiet", origin, clone]);

  const change = await runEffect(createChange({
    id: "PROJ-STACK",
    branch: "PROJ-STACK-second",
    checkouts: checkoutsOf([clone], [], { [clone]: "origin/PROJ-1-first" }),
  }));
  // The same checkouts the git extension's change:created hook creates.
  await Effect.runPromise(Effect.forEach(((change).checkouts ?? []).map((spec) => spec.path), (repo) => provisionRepo(change, repo), { concurrency: 1 }));

  // The file only the base branch has must be there: the new branch grew out of it.
  const worktree = (await runEffect(checkoutFor(change, clone)))!;
  expect(await Bun.file(join(worktree, "first.txt")).text()).toBe("work of the change below\n");

  // And a change without a base still starts from the remote default, which has no such file.
  const plain = await runEffect(createChange({ id: "PROJ-PLAIN", branch: "PROJ-PLAIN-x", checkouts: checkoutsOf([clone]) }));
  // The same checkouts the git extension's change:created hook creates.
  await Effect.runPromise(Effect.forEach(((plain).checkouts ?? []).map((spec) => spec.path), (repo) => provisionRepo(plain, repo), { concurrency: 1 }));
  const plainTree = (await runEffect(checkoutFor(plain, clone)))!;
  expect(await Bun.file(join(plainTree, "first.txt")).exists()).toBe(false);
});

test("a completed change is listed once, even when its directory is left behind", async () => {
  const change = await runEffect(createChange({ id: "PROJ-TWICE", checkouts: checkoutsOf([repo]) }));
  await runEffect(archiveChange(change.id));
  // A terminal, or a build, writing into the change's original path recreates it after the
  // archive moved.
  await Bun.write(join(changeDir(change.id), "terminal.json"), "{}\n");

  const listed = (await runEffect(listChanges())).filter((c) => c.id === "PROJ-TWICE");
  expect(listed.length).toBe(1);
});


test("a completion is only journaled once it will run", async () => {
  const { completeChange, progressOf } = await import("../apps/server/src/change/server/index.ts");
  const change = await runEffect(createChange({ id: "PROJ-EARLY", checkouts: checkoutsOf([repo]) }));

  // Nothing yet: a change that was never completed has no record at all.
  expect(await runEffect(progressOf(change.id))).toBeNull();

  // The repository has no remote, so the readiness check refuses. A refusal is a dialog, not a
  // completion that started and stopped: nothing is journaled for it, and the change is untouched.
  const outcome = await runEffect(completeChange(change));
  expect(outcome._tag).toBe("NotReady");
  expect(await runEffect(progressOf(change.id))).toBeNull();
  expect((await runEffect(readChange(change.id)))?.state).toBe("Implementation");
});

test("the overview counts windows that are running something, not windows", async () => {
  // Busy is a presented fact now: the merge in terminals/server/presenter.ts says which windows
  // are work.
  const { presentWindow } = await import("../apps/server/src/terminals/server/index.ts");
  const busy = (over: Partial<TmuxWindow>): boolean =>
    presentWindow({
      index: 0,
      id: "@1",
      name: "",
      command: "",
      active: true,
      activity: false,
      directory: "",
      named: false,
      options: {},
      ...over,
    }).busy;
  // A prompt is not work; a build, an editor and a server are.
  expect([
    busy({ command: "zsh" }),
    busy({ command: "-zsh" }),
    busy({ command: "nvim" }),
    busy({ command: "gradle" }),
    busy({}), // no session, or tmux told us nothing
  ]).toEqual([false, false, true, true, false]);

  // An agent says what it is doing, and is believed: an agent at its prompt is `node`, which would
  // otherwise count as work for as long as the window stayed open.
  expect([
    busy({ command: "node", options: { "@agent_status": "working" } }),
    busy({ command: "node", options: { "@agent_status": "waiting" } }),
    busy({ command: "node" }), // no marker: something is running, count it
  ]).toEqual([true, false, true]);
});

test("an agent's own account of itself is read from the @agent_status pane option", async () => {
  // The agents extension answers for the window; what it leaves alone falls through to the
  // core's plain-terminal defaults.
  const { presentWindow } = await import("../apps/server/src/terminals/server/index.ts");
  const presented = (options: Record<string, string>): PresentedWindow =>
    presentWindow({
      index: 0,
      id: "@1",
      name: "",
      command: "node",
      active: true,
      activity: false,
      directory: "example-api",
      named: false,
      options,
    });
  // What an agent's reporter sets with `tmux set -p @agent_status ...`.
  expect(presented({ "@agent_status": "working" })).toMatchObject({ label: "example-api - (agent working)", icon: "agent", state: "ok" });
  expect(presented({ "@agent_status": "waiting" })).toMatchObject({ label: "example-api - (agent waiting)", icon: "agent", state: "idle" });
  // The reporter also says who it is, and the name goes in the label.
  expect(presented({ "@agent_status": "working", "@agent_name": "pi" })).toMatchObject({
    label: "example-api - (pi working)",
  });
  expect(presented({ "@agent_status": "waiting", "@agent_name": "opencode" })).toMatchObject({
    label: "example-api - (opencode waiting)",
  });
  // Unset, or set to something else by something else: no claim is made about the window.
  expect(presented({ "@agent_status": "" })).toMatchObject({ label: "example-api - (node)", icon: "terminal", state: "idle" });
  expect(presented({ "@agent_status": "busy" })).toMatchObject({ label: "example-api - (node)", icon: "terminal", state: "idle" });
});

test("a change may be blocked, which is active but not workable", async () => {
  const { CHANGE_STATES, isFinished } = await import("../apps/server/src/domain/change.ts");
  const { stateClass } = await import("../apps/web/src/app-root/stateClass.ts");

  // The lifecycle, which the select offers in this order and the lists sort by; the overview
  // and the navigation column group `Ideation` into its own block rather than interleaving it.
  expect(CHANGE_STATES).toEqual([
    "Ideation",
    "Implementation",
    "Verification",
    "Blocked",
    "Completed",
    "Cancelled",
  ]);
  expect(stateClass("Blocked")).toBe("state-blocked");

  // The server accepts it, and the overview counts it among the active changes: blocked work is
  // work you still have.
  const change = await runEffect(createChange({ id: "PROJ-BLOCKED", checkouts: checkoutsOf([repo]) }));
  const blocked = { ...change, state: "Blocked" as const };
  await runEffect(writeChange(blocked));
  expect((await runEffect(readChange(change.id)))?.state).toBe("Blocked");
  expect(isFinished(blocked)).toBe(false);
});

test("the icons take the worst of what the repositories say", async () => {
  const { worst } = await import("../apps/server/src/domain/widget.ts");
  // One red build is what you want to know about, so it decides the colour; then one running.
  expect(worst(["ok", "error", "pending"])).toBe("error");
  expect(worst(["ok", "pending", "ok"])).toBe("pending");
  expect(worst(["ok", "warn"])).toBe("warn");
  expect(worst(["ok", "ok"])).toBe("ok");
  // Nothing to say is its own state: a change without pull requests has no builds, not green.
  expect(worst([])).toBe("none");
  expect(worst(["none"])).toBe("none");
});

test("every change's windows come back from one call, and other sessions are not ours", async () => {
  const { changeOfSession } = await import("../apps/server/src/terminals/server/index.ts");
  // The navigation column lists the terminals of every change at once; asking tmux per change
  // would be a process per change every few seconds.
  expect(changeOfSession("corvi-PROJ-1")).toBe("PROJ-1");
  expect(changeOfSession("corvi-PROJ-1671-2")).toBe("PROJ-1671-2");
  // Sessions you started yourself are left alone, and not shown as terminals of a change.
  expect(changeOfSession("work")).toBeUndefined();
  expect(changeOfSession("")).toBeUndefined();
});

test("a change belongs to the context it was made in, and older ones to the first", async () => {
  const { inWorkspace, workspaceOf, ALL } = await import("../apps/web/src/workspace/client/workspaces.ts");
  const workspaces = [
    { id: "client", name: "Acme" },
    { id: "personal", name: "Personal" },
  ];
  const change = (id: string, workspace?: string): { id: string; workspace?: string } =>
    ({ id, workspace });
  const all = [change("PROJ-1", "client"), change("IWE-1", "personal"), change("OLD-1")];

  // No workspace: it belongs to the first one, the default when there is only one place for
  // the work.
  expect(workspaceOf(change("OLD-1"), workspaces)).toBe("client");
  expect(workspaceOf(change("IWE-1", "personal"), workspaces)).toBe("personal");

  expect(inWorkspace(all, "client", workspaces).map((c) => c.id)).toEqual(["PROJ-1", "OLD-1"]);
  expect(inWorkspace(all, "personal", workspaces).map((c) => c.id)).toEqual(["IWE-1"]);
  // Everything, whichever context it belongs to: a filter rather than a workspace.
  expect(inWorkspace(all, ALL, workspaces).map((c) => c.id)).toEqual(["PROJ-1", "IWE-1", "OLD-1"]);

  // Nothing configured: one context, and it holds everything.
  expect(inWorkspace(all, ALL, []).length).toBe(3);
});

test("a workspace decides which extensions a change has, and whose Jira and Azure they are", async () => {
  const { extensionEnabled, workspaceOf } = await import("../apps/server/src/workspace/server/index.ts");
  const { azureOf } = await import("@corvi/azure-devops/azure");
  const { extensionsFor, loaded } = await import("../apps/server/src/integrations/index.ts");
  const { siteFor } = await import("@corvi/jira/jira");
  // Two contexts: a client with everything, and personal projects with neither. The personal
  // one names its extensions explicitly — enablement is the list, not a vendor flag.
  await withRuntimeConfig(
    {
      workspaces: [
        {
          id: "client",
          name: "Acme",
          extensionSettings: {
            "azure-devops": { organization: "https://dev.azure.com/one", project: "A" },
          },
        },
        {
          id: "personal",
          name: "Personal",
          extensions: loaded.map((e) => e.name).filter((n) => n !== "jira" && n !== "azure-devops"),
        },
      ],
    },
    () => {
      const client = { id: "PROJ-1", workspace: "client" };
      const personal = { id: "IWE-1", workspace: "personal" };
      const old = { id: "OLD-1", workspace: undefined }; // no workspace: it belongs to the first one

      // A personal project has no ticket, and being asked about one is noise and a CLI call: the
      // jira extension is not there at all. The GitHub card stays either way.
      expect(extensionsFor(workspaceOf(client)).some((e) => e.name === "jira")).toBe(true);
      expect(extensionsFor(workspaceOf(personal)).some((e) => e.name === "jira")).toBe(false);
      expect(extensionsFor(workspaceOf(personal)).some((e) => e.name === "github")).toBe(true);
      // Enablement is the list: naming extensions without azure-devops means no pipelines.
      expect(extensionEnabled(workspaceOf(personal), "azure-devops")).toBe(false);
      expect(extensionEnabled(workspaceOf(personal), "github")).toBe(true);
      expect(extensionEnabled(workspaceOf(client), "azure-devops")).toBe(true);

      // Whose Azure DevOps, and whose Jira: what makes two clients possible rather than one. Both
      // come from the extensions' own per-workspace settings; a workspace with none of them uses
      // whatever the CLIs themselves have configured.
      expect(azureOf(workspaceOf(client), runtimeConfig()).organization).toBe("https://dev.azure.com/one");
      expect(siteFor(runtimeConfig(), "personal")).toEqual({});
      expect(siteFor(runtimeConfig(), "client")).toEqual({});

      // A change with no workspace belongs to the first workspace.
      expect(workspaceOf(old).id).toBe("client");
    },
  );
});

test("a write persists the checkout specs as they stand", async () => {
  const change: Change = {
    id: "spec-links",
    branch: "spec-links",
    checkouts: checkoutsOf([join(tmp, "repo-a"), join(tmp, "repo-b")], [join(tmp, "repo-b")]),
    state: "Implementation",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  await Effect.runPromise(writeChange(change));
  const record = (await Bun.file(join(changeDir(change.id), "change.json")).json()) as {
    formatVersion?: number;
    checkouts?: { path: string; location: string; branch: { kind: string } }[];
  };
  expect(record.formatVersion).toBe(2);
  expect(record.checkouts?.map((spec) => spec.path)).toEqual(
    (change.checkouts ?? []).map((spec) => spec.path),
  );
  expect(record.checkouts?.map((spec) => spec.location)).toEqual(["new", "original"]);
});

test("a change is named by its ticket, until you name it yourself", async () => {
  const { refreshTitles } = await import("../apps/server/src/change/server/index.ts");
  const { clearCache } = await import("../apps/server/src/capabilities/cache.ts");
  const originalFetch = globalThis.fetch;
  const originalWorkspaces = runtimeConfig().workspaces;
  const originalToken = process.env.JIRA_API_TOKEN;
  // A Jira that answers one ticket and then cannot answer at all, so both the naming and the
  // stored name standing are exercised through the real title source.
  let failing = false;
  const asked: string[] = [];
  process.env.JIRA_API_TOKEN = "secret";
  runtimeConfig().workspaces = [
    {
      id: "jira-titles",
      name: "Jira titles",
      extensionSettings: {
        jira: {
          server: "https://example.atlassian.net",
          email: "someone@example.com",
          project: "PROJ",
          board: "169",
        },
      },
    },
  ];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(String(input));
    asked.push(url.pathname);
    if (failing) return Promise.resolve(new Response("down", { status: 500 }));
    return Promise.resolve(
      new Response(
        JSON.stringify({
          issues: [
            { key: "PROJ-7", fields: { summary: "Split the invoice export", status: { name: "In Progress" } } },
          ],
        }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  try {
    const change = await runEffect(
      createChange({
        id: "PROJ-NAMED",
        checkouts: checkoutsOf([repo]),
        workspace: "jira-titles",
        extensions: { jira: { key: "PROJ-7" } },
      }),
    );
    await runEffect(refreshTitles());
    expect((await runEffect(readChange(change.id)))?.title).toBe("Split the invoice export");
    expect(asked).toContain("/rest/api/3/search/jql");

    // A vendor that cannot answer leaves the stored name standing, not blanked.
    clearCache();
    failing = true;
    await runEffect(refreshTitles());
    expect((await runEffect(readChange(change.id)))?.title).toBe("Split the invoice export");

    // A name you wrote yourself is yours: the ticket is not asked about any more.
    failing = false;
    const current = (await runEffect(readChange(change.id)))!;
    await runEffect(writeChange({ ...current, title: "What it is really about", titleEdited: true }));
    const before = asked.length;
    await runEffect(refreshTitles());
    expect(asked.length).toBe(before);
    expect((await runEffect(readChange(change.id)))?.title).toBe("What it is really about");
  } finally {
    globalThis.fetch = originalFetch;
    runtimeConfig().workspaces = originalWorkspaces;
    if (originalToken === undefined) delete process.env.JIRA_API_TOKEN;
    else process.env.JIRA_API_TOKEN = originalToken;
  }
});

test("a legacy write moves the record's revision", async () => {
  const change = await runEffect(createChange({ id: "revision-legacy", checkouts: checkoutsOf([repo]) }));
  const readRecord = async (): Promise<{ revision?: number }> =>
    (await Bun.file(join(changeDir("revision-legacy"), "change.json")).json()) as {
      revision?: number;
    };
  expect((await readRecord()).revision).toBe(1);

  await runEffect(writeChange({ ...change, title: "Renamed by hand" }));
  expect((await readRecord()).revision).toBe(2);
  expect((await runEffect(readChange("revision-legacy")))?.title).toBe("Renamed by hand");
});
