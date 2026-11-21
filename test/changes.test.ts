import { runtimeConfig } from "../apps/server/src/workspace/server/index.ts";
import { test, expect, beforeAll, afterAll } from "bun:test";
import { lstat, rm, realpath } from "node:fs/promises";
import { join, basename } from "node:path";
import {
  changePairs,
  createChange,
  listChanges,
  changeDir,
  archiveDir,
  readChange,
  writeChange,
  writeChangeAt,
} from "../apps/server/src/change/server/index.ts";
import { ChangeStore } from "@corvi/changes/store";
import { storeLayer } from "@corvi/changes/node";
import { ChangeId } from "@corvi/contracts/changes";
import {
  repoItem,
  checkoutFor,
  currentBranch,
  entryFor,
  unsafeToRemove,
} from "../apps/server/src/vendors/git.ts";
import { gitRun, provisionRepositories, setRepos } from "../apps/server/src/change/provisioning.ts";
import { Effect, Layer, Result, Schema } from "effect";
import { ProvisionedChangeSchema, type ProvisionedChangeDto } from "@corvi/contracts/api";
import type { Change } from "@corvi/changes/record";
import type { RawWindow } from "../apps/server/src/integrations/types.ts";
import type { PresentedWindow } from "../apps/server/src/terminals/server/index.ts";
import {
  archiveViaStore,
  checkoutsOf,
  runEffect,
  runSetRepos,
  until,
  runSh,
  withRuntimeConfig,
  useOwnChangeRoot,
  gitRepo,
  withEnv,
  callGuarded,
  commitIn,
} from "./helpers.ts";
let tmp: string;
let repo: string;
beforeAll(async () => {
  tmp = await useOwnChangeRoot("changes");
  repo = join(tmp, "myrepo");
  await runSh(["git", "init", "-b", "main", repo]);
  await Bun.write(join(repo, "README.md"), "hi\n");
  await runSh(["git", "add", "."], repo);
  await runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], repo);
});
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
  // The same checkouts a creation makes.
  await Effect.runPromise(provisionRepositories(change));
  const found = await runEffect(checkoutFor(change, repo));
  expect(await realpath(found!)).toBe(await realpath(join(changeDir(change), basename(repo))));
  expect(await Bun.file(join(found!, "README.md")).text()).toBe("hi\n");
  const after = await Effect.runPromise(repoItem(change, repo));
  // Clean, but this fixture has no remote, so the branch is still only local.
  expect(after.state).toBe("pending");
  expect(after.detail).toContain("clean, no upstream");
  await Effect.runPromise(gitRun(change, "remove", repo));
  expect((await Effect.runPromise(repoItem(change, repo))).state).toBe("none");
});
test("the create response names the new change's directory", async () => {
  const { changeRoutes } = await import("../apps/server/src/change/routes.ts");
  const create = async (body: unknown): Promise<ProvisionedChangeDto> => {
    const response = await callGuarded(changeRoutes, "POST", "/api/changes", { body });
    expect(response.status).toBe(201);
    // Decoded as the client does it: the field is only usable if the contract keeps it.
    return Schema.decodeUnknownSync(ProvisionedChangeSchema)(await response.json());
  };
  const provisioned = await create({ id: "PROJ-CHANGEDIR", state: "Ideation" });
  expect(provisioned.change.id).toBe("PROJ-CHANGEDIR");
  // The change's workspace changes root joined with the id: where its PLAN.md goes.
  expect(provisioned.changeDir).toBe(join(process.env.CORVI_ROOT!, "PROJ-CHANGEDIR"));
  // A workspace names a changes root of its own, and a change made in it is filed there rather
  // than in the default root. The env override would win at every scope, so put it aside.
  await withEnv({ CORVI_ROOT: undefined, CORVI_ARCHIVE_ROOT: undefined }, () =>
    withRuntimeConfig(
      {
        changesRoot: join(tmp, "root-changes"),
        archiveRoot: join(tmp, "root-archive"),
        workspaces: [
          {
            id: "client",
            name: "Client",
            settings: {
              changesRoot: join(tmp, "client-changes"),
              archiveRoot: join(tmp, "client-archive"),
            },
          },
        ],
      },
      async () => {
        const workspaceChange = await create({
          id: "PROJ-WORKSPACE",
          state: "Ideation",
          workspace: "client",
        });
        expect(workspaceChange.change.workspace).toBe("client");
        expect(workspaceChange.changeDir).toBe(join(tmp, "client-changes", "PROJ-WORKSPACE"));
      },
    ),
  );
});
test("rejects duplicate ids, unsafe ids and changes without repositories", async () => {
  await runEffect(createChange({ id: "PROJ-2", checkouts: checkoutsOf([repo]) }));
  expect(runEffect(createChange({ id: "PROJ-2", checkouts: checkoutsOf([repo]) }))).rejects.toThrow(
    "already exists",
  );
  expect(runEffect(createChange({ id: "../escape", checkouts: checkoutsOf([repo]) }))).rejects.toThrow(
    "invalid change id",
  );
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
  await runEffect(archiveViaStore(change.id));
  expect(await Bun.file(join(changeDir(change), "change.json")).exists()).toBe(false);
  expect(await Bun.file(join(archiveDir(change), "change.json")).exists()).toBe(true);
  // The lifecycle's terminal write is on the archived record, and reading/listing find it there.
  const completed = (await runEffect(readChange(change.id)))!;
  expect(completed.state).toBe("Completed");
  expect(completed.completedAt).toBeDefined();
  expect(completed.revision).toBe(2);
  expect(await runEffect(listChanges())).toContainEqual(completed);
  // A write lands on the archived copy and moves the revision on again; the revision is why a
  // transition decided on the old one would be refused instead of overwriting this.
  await runEffect(writeChange({ ...completed, title: "renamed in the archive" }));
  const reread = (await runEffect(readChange(change.id)))!;
  expect(reread.title).toBe("renamed in the archive");
  expect(reread.revision).toBe(3);
  expect(await runEffect(listChanges())).toContainEqual(reread);
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
  // The same checkouts a creation makes.
  await Effect.runPromise(provisionRepositories(change));
  const worktree = (await runEffect(checkoutFor(change, clone)))!;
  expect(await Bun.file(join(worktree, "f.txt")).text()).toBe("one\ntwo\n");
});
test("a worktree branch does not track the branch it started from", async () => {
  // Tracking origin/main would make a bare `git push` in the worktree aim at main, which is the
  // one thing this must never do. A fresh branch has no upstream until it is pushed.
  const origin = await gitRepo(tmp, "track-origin");
  const clone = join(tmp, "track-clone");
  await runSh(["git", "clone", "--quiet", origin, clone]);
  const change = await runEffect(
    createChange({ id: "PROJ-TRACK-WT", branch: "PROJ-TRACK-WT-work", checkouts: checkoutsOf([clone]) }),
  );
  // The same checkouts a creation makes.
  await Effect.runPromise(provisionRepositories(change));
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
  const local = await gitRepo(tmp, "local-only");
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
  // The same checkouts a creation makes.
  await Effect.runPromise(provisionRepositories(change));
  const worktree = (await runEffect(checkoutFor(change, local)))!;
  expect(await Bun.file(join(worktree, "main.txt")).text()).toBe("the default branch\n");
  expect(await Bun.file(join(worktree, "side.txt")).exists()).toBe(false);
});
test("commits on a repository with no remote still ask before a removal", async () => {
  // No remote means no upstream to be ahead of and no `origin/main` to measure against. The
  // repository's own main is what they are measured against, and commits it does not have exist
  // only on that branch: a removal asks rather than assuming they landed somewhere.
  const local = await gitRepo(tmp, "no-remote-work");
  const change = await runEffect(
    createChange({ id: "PROJ-NOREMOTE", branch: "PROJ-NOREMOTE-work", checkouts: checkoutsOf([local]) }),
  );
  // The same checkouts a creation makes.
  await Effect.runPromise(provisionRepositories(change));
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
  const { isInPlace } = await import("../apps/server/src/vendors/git.ts");
  const clean = await gitRepo(tmp, "clean");
  const dirty = await gitRepo(tmp, "dirty");
  await Bun.write(join(dirty, "scratch.txt"), "half-finished work\n");
  const change = await runEffect(
    createChange({
      id: "PROJ-DIRECT",
      branch: "PROJ-DIRECT-work",
      checkouts: checkoutsOf([clean, dirty], [clean, dirty]),
    }),
  );
  expect(isInPlace(change, clean)).toBe(true);
  // The same checkouts a creation makes.
  const run = await Effect.runPromise(provisionRepositories(change));
  // The dirty one's refresh says it was left alone, and why.
  const dirtyReport = run.refresh.find((outcome) => outcome.directoryName === basename(dirty));
  expect(dirtyReport?.state).toBe("left-alone");
  expect(dirtyReport?.detail).toMatch(/uncommitted/);
  // Both are linked from the change directory, so it still shows everything the change touches.
  for (const repo of [clean, dirty]) {
    expect(await realpath(join(changeDir(change), basename(repo)))).toBe(await realpath(repo));
  }
  // The clean one moved to the branch; the dirty one kept its own, uncommitted work intact.
  expect(await runEffect(currentBranch(clean))).toBe("PROJ-DIRECT-work");
  expect(await runEffect(currentBranch(dirty))).toBe("main");
  expect(await Bun.file(join(dirty, "scratch.txt")).text()).toBe("half-finished work\n");
  // Dropping it removes the link only: the checkout and its branch stay.
  const result = await runEffect(setRepos(change, checkoutsOf([dirty], [dirty]), true));
  expect(result._tag).toBe("Done");
  expect(await Bun.file(join(changeDir(change), "clean")).exists()).toBe(false);
  expect(await runEffect(currentBranch(clean))).toBe("PROJ-DIRECT-work");
});
test("a worktree starts from the base branch it was given, not the remote default", async () => {
  // A repository with main, plus a branch ahead of it that another change might be sitting on.
  const origin = await gitRepo(tmp, "stack-origin");
  await runSh(["git", "switch", "-c", "PROJ-1-first"], origin);
  await Bun.write(join(origin, "first.txt"), "work of the change below\n");
  await runSh(["git", "add", "."], origin);
  await runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "first"], origin);
  await runSh(["git", "switch", "main"], origin);
  const clone = join(tmp, "stacked");
  await runSh(["git", "clone", "--quiet", origin, clone]);
  const change = await runEffect(
    createChange({
      id: "PROJ-STACK",
      branch: "PROJ-STACK-second",
      checkouts: checkoutsOf([clone], [], { [clone]: "origin/PROJ-1-first" }),
    }),
  );
  // The same checkouts a creation makes.
  await Effect.runPromise(provisionRepositories(change));
  // The file only the base branch has must be there: the new branch grew out of it.
  const worktree = (await runEffect(checkoutFor(change, clone)))!;
  expect(await Bun.file(join(worktree, "first.txt")).text()).toBe("work of the change below\n");
  // And a change without a base still starts from the remote default, which has no such file.
  const plain = await runEffect(
    createChange({ id: "PROJ-PLAIN", branch: "PROJ-PLAIN-x", checkouts: checkoutsOf([clone]) }),
  );
  // The same checkouts a creation makes.
  await Effect.runPromise(provisionRepositories(plain));
  const plainTree = (await runEffect(checkoutFor(plain, clone)))!;
  expect(await Bun.file(join(plainTree, "first.txt")).exists()).toBe(false);
});
test("a completed change is listed once, even when its directory is left behind", async () => {
  const change = await runEffect(createChange({ id: "PROJ-TWICE", checkouts: checkoutsOf([repo]) }));
  await runEffect(archiveViaStore(change.id));
  // A terminal, or a build, writing into the change's original path recreates it after the
  // archive moved.
  await Bun.write(join(changeDir(change), "terminal.json"), "{}\n");
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
  const busy = (over: Partial<RawWindow>): boolean =>
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
      panes: ["@1"],
      activePane: "@1",
      ...over,
    }).busy;
  // A prompt is not work; a build, an editor and a server are.
  expect([
    busy({ command: "zsh" }),
    busy({ command: "-zsh" }),
    busy({ command: "nvim" }),
    busy({ command: "gradle" }),
    busy({}), // no session, or the window told us nothing
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
  const presented = (options: Record<string, string>, subagent = false): PresentedWindow =>
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
      panes: ["@1"],
      activePane: "@1",
      ...(subagent ? { subagent: true } : {}),
    });
  // What an agent's reporter publishes as the `@agent_status` fact.
  expect(presented({ "@agent_status": "working" })).toMatchObject({
    label: "example-api (agent working)",
    icon: "agent",
    state: "ok",
  });
  expect(presented({ "@agent_status": "waiting" })).toMatchObject({
    label: "example-api (agent waiting)",
    icon: "agent",
    state: "idle",
  });
  // The explicit agent pair the quiet rule reads, separate from `busy`: a working agent is
  // agent+working, a waiting one is agent but not working, and a subagent's host window leaves
  // both to the subagent's own view.
  expect(presented({ "@agent_status": "working" })).toMatchObject({ agent: true, working: true });
  expect(presented({ "@agent_status": "waiting" })).toMatchObject({ agent: true, working: false });
  expect(presented({ "@agent_status": "working" }, true)).toMatchObject({ agent: false, working: false });
  // The reporter also says who it is, and the name goes in the label.
  expect(presented({ "@agent_status": "working", "@agent_name": "pi" })).toMatchObject({
    label: "example-api (pi working)",
  });
  expect(presented({ "@agent_status": "waiting", "@agent_name": "opencode" })).toMatchObject({
    label: "example-api (opencode waiting)",
  });
  // Unset, or set to something else by something else: no claim is made about the window.
  expect(presented({ "@agent_status": "" })).toMatchObject({
    label: "example-api (node)",
    icon: "terminal",
    state: "idle",
  });
  expect(presented({ "@agent_status": "busy" })).toMatchObject({
    label: "example-api (node)",
    icon: "terminal",
    state: "idle",
  });
});
test("a name you gave replaces every label the presenters compose, and the presenter still says the rest", async () => {
  const { presentWindow } = await import("../apps/server/src/terminals/server/index.ts");
  const raw = (over: Partial<RawWindow>): RawWindow => ({
    index: 0,
    id: "@1",
    name: "example-api",
    command: "node",
    active: true,
    activity: false,
    directory: "example-api",
    named: true,
    options: {},
    panes: ["@1"],
    activePane: "@1",
    title: "Build logs",
    ...over,
  });
  // The name wins over everything the presentation would otherwise compose — an agent's own
  // session name included — and is not extended with what is running.
  const agent = presentWindow(
    raw({
      panes: ["@1", "@2"],
      options: {
        "@agent_status": "working",
        "@agent_name": "pi",
        "@agent_session_name": "fix the failing test",
      },
    }),
  );
  // The pane count is a structural fact about the window, not part of the name, so it stays.
  expect(agent.label).toBe("Build logs (2 panes)");
  // The presenters still answer the icon, the state and the facts the overview counts, and
  // `detail` still says what runs and where.
  expect(agent).toMatchObject({ icon: "agent", state: "ok", busy: true, agent: true, working: true });
  expect(agent.detail).toBe("example-api (node) in example-api");
  // A named plain shell stays an idle shell: a name is not an action label.
  expect(presentWindow(raw({ command: "zsh" }))).toMatchObject({
    label: "Build logs",
    state: "idle",
    busy: false,
    icon: "terminal",
  });
  // The note beside the name is still the agent's own words.
  expect(
    presentWindow(raw({ options: { "@agent_status": "waiting", "@agent_last_message": "All green." } })).note,
  ).toBe("All green.");
});
test("a window is named where its shell is, with what runs there in brackets", async () => {
  const { presentWindow } = await import("../apps/server/src/terminals/server/index.ts");
  const raw = (over: Partial<RawWindow>): RawWindow => ({
    index: 0,
    id: "@1",
    name: "PROJ-TITLE",
    command: "zsh",
    active: true,
    activity: false,
    directory: "PROJ-TITLE",
    named: true,
    options: {},
    panes: ["@1"],
    activePane: "@1",
    ...over,
  });
  // A prompt that says where it is names the window, and what runs in it follows in brackets —
  // including the shell at a prompt, as a terminal shows it. The change's own id is only the
  // fallback, for a window that says nothing about itself.
  expect(presentWindow(raw({ place: "corvi" }))).toMatchObject({ label: "corvi (zsh)", busy: false });
  expect(presentWindow(raw({ place: "corvi", command: "gradle" }))).toMatchObject({
    label: "corvi (gradle)",
    busy: true,
  });
  // The place outlives a command that takes the title over: a title that is the job is not shown
  // instead of the place.
  expect(presentWindow(raw({ place: "corvi", terminalTitle: "gradle", command: "gradle" })).label).toBe(
    "corvi (gradle)",
  );
  // No announcement: the terminal's own title says where it is, then the directory it was opened
  // in. A title that already says the job is not repeated.
  expect(presentWindow(raw({ terminalTitle: "..-naming/corvi" })).label).toBe("..-naming/corvi (zsh)");
  expect(presentWindow(raw({ terminalTitle: "gradle", command: "gradle" })).label).toBe("gradle");
  expect(presentWindow(raw({})).label).toBe("PROJ-TITLE (zsh)");
  // A name you gave still wins over all of it, and so does an agent's own session name; a split
  // window's count still follows whatever the name is.
  expect(presentWindow(raw({ place: "corvi", title: "Build logs" })).label).toBe("Build logs");
  expect(
    presentWindow(
      raw({
        place: "corvi",
        options: { "@agent_status": "working", "@agent_session_name": "fix the failing test" },
      }),
    ).label,
  ).toBe("fix the failing test");
  expect(presentWindow(raw({ place: "corvi", panes: ["@1", "@2"] })).label).toBe("corvi (zsh) (2 panes)");
  // The tooltip says what runs and where the shell is, not where the window was opened.
  expect(presentWindow(raw({ place: "corvi", command: "gradle" })).detail).toBe(
    "PROJ-TITLE (gradle) in corvi",
  );
});
test("a repository whose removal fails is reported, and the rest of the edit still runs", async () => {
  const { changeRoutes } = await import("../apps/server/src/change/routes.ts");
  const locked = await gitRepo(tmp, "repos-locked", { remote: true });
  const dropped = await gitRepo(tmp, "repos-dropped", { remote: true });
  const added = await gitRepo(tmp, "repos-added", { remote: true });
  const change = await runEffect(
    createChange({
      id: "PROJ-REPOSLEFT",
      branch: "PROJ-REPOSLEFT-x",
      checkouts: checkoutsOf([locked, dropped]),
    }),
  );
  await Effect.runPromise(provisionRepositories(change));
  const lockedWorktree = (await runEffect(checkoutFor(change, locked)))!;
  const droppedWorktree = (await runEffect(checkoutFor(change, dropped)))!;
  // A locked worktree cannot be removed with git's single force.
  await runSh(["git", "worktree", "lock", lockedWorktree, "--reason", "held for the test"], locked);

  const response = await callGuarded(changeRoutes, "POST", "/api/changes/:id/repos", {
    params: { id: change.id },
    body: { checkouts: checkoutsOf([added]) },
  });
  // The write already won, so this is a 200 carrying the record the page must render — plus what
  // was left behind. A 400 here would keep the editor showing a list the record no longer has.
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    change: Change;
    provision: { integration: string; ok: boolean; error?: string }[];
  };
  expect(body.change.checkouts?.map((spec) => spec.path)).toEqual([added]);
  const failure = body.provision.find((entry) => !entry.ok);
  expect(failure?.error).toContain(basename(locked));
  expect(failure?.error).toContain("left behind");

  // The other removal and the setup ran: only the locked checkout is still there.
  expect(await Bun.file(join(droppedWorktree, "README.md")).exists()).toBe(false);
  expect(await Bun.file(join(changeDir(change), basename(added), "README.md")).exists()).toBe(true);
  expect(await Bun.file(join(lockedWorktree, "README.md")).exists()).toBe(true);
  // And the record on disk is the one the response carried.
  expect((await runEffect(readChange(change.id)))?.checkouts?.map((spec) => spec.path)).toEqual([added]);
});

test("a change may be blocked, which is active but not workable", async () => {
  const { CHANGE_STATES, isFinished } = await import("@corvi/changes/record");
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
  const { worst } = await import("@corvi/contracts/display");
  // One red build is what you want to know about, so it decides the colour; then one running.
  expect(worst(["ok", "error", "pending"])).toBe("error");
  expect(worst(["ok", "pending", "ok"])).toBe("pending");
  expect(worst(["ok", "warn"])).toBe("warn");
  expect(worst(["ok", "ok"])).toBe("ok");
  // Nothing to say is its own state: a change without pull requests has no builds, not green.
  expect(worst([])).toBe("none");
  expect(worst(["none"])).toBe("none");
});
test("a change belongs to the context it was made in, and older ones to the first", async () => {
  const { inWorkspace, workspaceOf, ALL } = await import("../apps/web/src/workspace/client/workspaces.ts");
  const workspaces = [
    { id: "client", name: "Acme" },
    { id: "personal", name: "Personal" },
  ];
  const change = (id: string, workspace?: string): { id: string; workspace?: string } => ({ id, workspace });
  const all = [change("PROJ-1", "client"), change("CORVI-1", "personal"), change("OLD-1")];
  // No workspace: it belongs to the first one, the default when there is only one place for
  // the work.
  expect(workspaceOf(change("OLD-1"), workspaces)).toBe("client");
  expect(workspaceOf(change("CORVI-1", "personal"), workspaces)).toBe("personal");
  expect(inWorkspace(all, "client", workspaces).map((c) => c.id)).toEqual(["PROJ-1", "OLD-1"]);
  expect(inWorkspace(all, "personal", workspaces).map((c) => c.id)).toEqual(["CORVI-1"]);
  // Everything, whichever context it belongs to: a filter rather than a workspace.
  expect(inWorkspace(all, ALL, workspaces).map((c) => c.id)).toEqual(["PROJ-1", "CORVI-1", "OLD-1"]);
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
          settings: {
            extensionSettings: {
              "azure-devops": { organization: "https://dev.azure.com/one", project: "A" },
            },
          },
        },
        {
          id: "personal",
          name: "Personal",
          settings: {
            extensions: loaded.map((e) => e.name).filter((n) => n !== "jira" && n !== "azure-devops"),
          },
        },
      ],
    },
    () => {
      const client = { id: "PROJ-1", workspace: "client" };
      const personal = { id: "CORVI-1", workspace: "personal" };
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
  const record = (await Bun.file(join(changeDir(change), "change.json")).json()) as {
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
      settings: {
        extensionSettings: {
          jira: {
            server: "https://example.atlassian.net",
            email: "someone@example.com",
            project: "PROJ",
            board: "169",
          },
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
            {
              key: "PROJ-7",
              fields: { summary: "Split the invoice export", status: { name: "In Progress" } },
            },
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
test("a title refresh that loses the write keeps the winner and reports nothing", async () => {
  const { refreshTitles } = await import("../apps/server/src/change/server/index.ts");
  const { clearCache } = await import("../apps/server/src/capabilities/cache.ts");
  const originalFetch = globalThis.fetch;
  const originalWorkspaces = runtimeConfig().workspaces;
  const originalToken = process.env.JIRA_API_TOKEN;
  process.env.JIRA_API_TOKEN = "secret";
  runtimeConfig().workspaces = [
    {
      id: "jira-titles",
      name: "Jira titles",
      settings: {
        extensionSettings: {
          jira: { server: "https://example.atlassian.net", email: "someone@example.com", project: "PROJ" },
        },
      },
    },
  ];
  // The title lookup is held open so a phase write can land in the window between the list read
  // and the conditional write.
  let asked!: () => void;
  const askedOnce = new Promise<void>((resolve) => {
    asked = resolve;
  });
  let release!: (summary: string) => void;
  const held = new Promise<string>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/api/3/search/jql") {
      asked();
      return held.then(
        (summary) =>
          new Response(
            JSON.stringify({ issues: [{ key: "PROJ-8", fields: { summary, status: { name: "To Do" } } }] }),
            { status: 200 },
          ),
      );
    }
    return Promise.resolve(new Response("unexpected", { status: 404 }));
  }) as typeof fetch;
  try {
    clearCache();
    const change = await runEffect(
      createChange({
        id: "PROJ-LOSTTITLE",
        checkouts: checkoutsOf([repo]),
        workspace: "jira-titles",
        extensions: { jira: { key: "PROJ-8" } },
      }),
    );
    const pending = runEffect(refreshTitles());
    await askedOnce;
    // The record moves on while the lookup is in flight; its title refresh is now decided on a
    // revision that no longer exists.
    const observed = (await runEffect(readChange(change.id)))!;
    await runEffect(writeChange({ ...observed, state: "Blocked" }));
    release("A name that lost the race");
    const titles = await pending;
    expect(titles[change.id]).toBeUndefined();
    const after = (await runEffect(readChange(change.id)))!;
    expect(after.state).toBe("Blocked");
    expect(after.title).not.toBe("A name that lost the race");
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
    (await Bun.file(join(changeDir({ id: "revision-legacy" }), "change.json")).json()) as {
      revision?: number;
    };
  expect((await readRecord()).revision).toBe(1);
  await runEffect(writeChange({ ...change, title: "Renamed by hand" }));
  expect((await readRecord()).revision).toBe(2);
  expect((await runEffect(readChange("revision-legacy")))?.title).toBe("Renamed by hand");
});
test("an unstamped record reads as the current shape and is not rewritten", async () => {
  const path = join(changeDir({ id: "unstamped" }), "change.json");
  const stored =
    JSON.stringify({
      id: "unstamped",
      branch: "unstamped",
      state: "Ideation",
      createdAt: "2026-01-01T00:00:00.000Z",
      checkouts: [{ path: "/sources/one", location: "new", branch: { kind: "change" } }],
    }) + "\n";
  await Bun.write(path, stored);
  const read = await runEffect(readChange("unstamped"));
  // Read as the current shape, not migrated and not rejected: the missing stamp is not a fault.
  expect(read?.state).toBe("Ideation");
  expect(read?.formatVersion).toBeUndefined();
  // Nothing was written back, so the record on disk is exactly as it was left.
  expect(await Bun.file(path).text()).toBe(stored);
});

/** A second clone that pushes a commit to `main` on the shared origin: how the base moves on
 * while the change's checkout stands still. The content changes on every call, so the same file
 * can be committed again. */
const pushToBase = async (origin: string, otherDirectory: string, file: string): Promise<void> => {
  const fresh = await Bun.file(join(otherDirectory, file)).exists();
  if (!fresh) await runSh(["git", "clone", "-q", origin, otherDirectory]);
  await Bun.write(join(otherDirectory, file), `${file} ${Date.now()}\n`);
  await runSh(["git", "add", "."], otherDirectory);
  await runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", file], otherDirectory);
  await runSh(["git", "push", "-q", "origin", "main"], otherDirectory);
};

test("the Local changes card offers Fast-forward only for a clean checkout with no work of its own", async () => {
  const repo = await gitRepo(tmp, "ff-card", { remote: true });
  const change = await runEffect(
    createChange({ id: "PROJ-FFCARD", branch: "PROJ-FFCARD-work", checkouts: checkoutsOf([repo]) }),
  );
  await Effect.runPromise(provisionRepositories(change));
  const worktree = (await runEffect(checkoutFor(change, repo)))!;

  // Current against the base: nothing to offer.
  expect((await Effect.runPromise(repoItem(change, repo))).actions ?? []).toEqual([]);

  // The base moves on and the checkout has fetched it: behind, with nothing of its own, so the
  // row offers the one action that closes the gap.
  await pushToBase(join(tmp, "ff-card.git"), join(tmp, "ff-card-other"), "later.txt");
  await runSh(["git", "fetch", "-q", "origin"], repo);
  const offered = await Effect.runPromise(repoItem(change, repo));
  expect(offered.actions?.map((action) => action.id)).toEqual(["fast-forward"]);
  expect(offered.detail).toContain("1 behind base origin/main");

  // Uncommitted work: a fast-forward could clobber it, so no action.
  await Bun.write(join(worktree, "scratch.txt"), "half a thought\n");
  expect((await Effect.runPromise(repoItem(change, repo))).actions ?? []).toEqual([]);
  await runSh(["git", "clean", "-q", "-f", "scratch.txt"]);

  // A commit of its own: the branch diverged, and reconciling that is the user's.
  await Bun.write(join(worktree, "wip.txt"), "my work\n");
  await runSh(["git", "add", "."], worktree);
  await runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "mine"], worktree);
  expect((await Effect.runPromise(repoItem(change, repo))).actions ?? []).toEqual([]);
});

test("Fast-forward advances the checkout, and refuses when it cannot", async () => {
  const repo = await gitRepo(tmp, "ff-run", { remote: true });
  const change = await runEffect(
    createChange({ id: "PROJ-FFRUN", branch: "PROJ-FFRUN-work", checkouts: checkoutsOf([repo]) }),
  );
  await Effect.runPromise(provisionRepositories(change));
  const worktree = (await runEffect(checkoutFor(change, repo)))!;
  await pushToBase(join(tmp, "ff-run.git"), join(tmp, "ff-run-other"), "later.txt");

  // The action fetches first, so a click advances to the latest remote base even though the
  // card's read was behind on local refs alone.
  await Effect.runPromise(gitRun(change, "fast-forward", repo));
  const tip = (await runSh(["git", "rev-parse", "HEAD"], worktree)).stdout.trim();
  const baseTip = (await runSh(["git", "rev-parse", "origin/main"], repo)).stdout.trim();
  expect(tip).toBe(baseTip);
  expect(await Bun.file(join(worktree, "later.txt")).exists()).toBe(true);
  // Nothing left to fast-forward, so the row stops offering it.
  expect((await Effect.runPromise(repoItem(change, repo))).actions ?? []).toEqual([]);

  // A stale click on an already current branch is idempotent: nothing moves, nothing fails.
  await Effect.runPromise(gitRun(change, "fast-forward", repo));
  expect((await runSh(["git", "rev-parse", "HEAD"], worktree)).stdout.trim()).toBe(tip);

  // Uncommitted work on a file the base changed is a refusal, never a rewrite: git would have to
  // overwrite it to advance.
  await pushToBase(join(tmp, "ff-run.git"), join(tmp, "ff-run-other"), "later.txt");
  await Bun.write(join(worktree, "later.txt"), "my unsaved edit\n");
  await expect(Effect.runPromise(gitRun(change, "fast-forward", repo))).rejects.toThrow(/could not/);
  expect(await Bun.file(join(worktree, "later.txt")).text()).toBe("my unsaved edit\n");
});

test("Fast-forward refuses a repository that is not the change's, and creates no missing checkout", async () => {
  const repo = await gitRepo(tmp, "ff-scope", { remote: true });
  const other = await gitRepo(tmp, "ff-scope-other", { remote: true });
  const change = await runEffect(
    createChange({ id: "PROJ-FFSCOPE", branch: "PROJ-FFSCOPE-work", checkouts: checkoutsOf([repo]) }),
  );
  // A repository this change does not own is not silently a 200: there is nothing to advance.
  await expect(Effect.runPromise(gitRun(change, "fast-forward", other))).rejects.toThrow(
    /is not one of this change's repositories/,
  );

  await Effect.runPromise(provisionRepositories(change));
  const worktree = join(changeDir(change), basename(repo));
  // The worktree goes (the row's own remove action), and a stale Fast-forward click must fail
  // rather than quietly provisioning a new one.
  await Effect.runPromise(gitRun(change, "remove", repo));
  expect(await Bun.file(join(worktree, "README.md")).exists()).toBe(false);
  await expect(Effect.runPromise(gitRun(change, "fast-forward", repo))).rejects.toThrow(/could not/);
  expect(await Bun.file(join(worktree, "README.md")).exists()).toBe(false);
});

/** A commit pushed to one branch of the shared origin from a second clone. Reuses the clone
 * directory, so a second call on the same branch adds a commit. */
const pushToBranch = async (
  origin: string,
  otherDirectory: string,
  branch: string,
  file: string,
): Promise<void> => {
  const cloned = await Bun.file(join(otherDirectory, ".git", "HEAD")).exists();
  if (!cloned) await runSh(["git", "clone", "-q", origin, otherDirectory]);
  await runSh(["git", "checkout", "-q", branch], otherDirectory);
  await Bun.write(join(otherDirectory, file), `${file} ${Date.now()}\n`);
  await runSh(["git", "add", "."], otherDirectory);
  await runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", file], otherDirectory);
  await runSh(["git", "push", "-q", "origin", branch], otherDirectory);
};

test("an existing branch is measured against its own remote counterpart, not the default branch", async () => {
  const repo = await gitRepo(tmp, "ff-existing", { remote: true });
  // The branch the user keeps, made and pushed here; the change's worktree attaches to it.
  await runSh(["git", "checkout", "-q", "-b", "feature"], repo);
  await Bun.write(join(repo, "feature.txt"), "feature\n");
  await runSh(["git", "add", "."], repo);
  await commitIn(repo, "feature work");
  await runSh(["git", "push", "-q", "-u", "origin", "feature"], repo);
  await runSh(["git", "checkout", "-q", "main"], repo);
  const change = await runEffect(
    createChange({
      id: "PROJ-FFEXISTING",
      checkouts: [{ path: repo, location: "new", branch: { kind: "existing", name: "feature" } }],
    }),
  );
  await Effect.runPromise(provisionRepositories(change));
  const worktree = (await runEffect(checkoutFor(change, repo)))!;

  // The default branch moves while the selected branch does not: the policy advances to
  // origin/feature, so there is nothing to offer and nothing to report as behind.
  await pushToBase(join(tmp, "ff-existing.git"), join(tmp, "ff-existing-main"), "later.txt");
  await runSh(["git", "fetch", "-q", "origin"], repo);
  const unchanged = await Effect.runPromise(repoItem(change, repo));
  expect(unchanged.actions ?? []).toEqual([]);
  expect(unchanged.detail).not.toContain("behind");

  // The selected branch moves: now it is behind its own counterpart, with nothing of its own.
  await pushToBranch(join(tmp, "ff-existing.git"), join(tmp, "ff-existing-feature"), "feature", "more.txt");
  await runSh(["git", "fetch", "-q", "origin"], repo);
  const offered = await Effect.runPromise(repoItem(change, repo));
  expect(offered.actions?.map((action) => action.id)).toEqual(["fast-forward"]);
  expect(offered.detail).toContain("1 behind base origin/feature");

  // The click advances to origin/feature — not to origin/main, which also moved.
  await Effect.runPromise(gitRun(change, "fast-forward", repo));
  const tip = (await runSh(["git", "rev-parse", "HEAD"], worktree)).stdout.trim();
  const featureTip = (await runSh(["git", "rev-parse", "origin/feature"], repo)).stdout.trim();
  expect(tip).toBe(featureTip);
  expect(await Bun.file(join(worktree, "more.txt")).exists()).toBe(true);
  expect(await Bun.file(join(worktree, "later.txt")).exists()).toBe(false);
  expect((await Effect.runPromise(repoItem(change, repo))).actions ?? []).toEqual([]);

  // Its own commit on top of the counterpart: diverged, so no fast-forward is offered.
  await Bun.write(join(worktree, "mine.txt"), "mine\n");
  await runSh(["git", "add", "."], worktree);
  await commitIn(worktree, "mine");
  await pushToBranch(join(tmp, "ff-existing.git"), join(tmp, "ff-existing-feature"), "feature", "theirs.txt");
  await runSh(["git", "fetch", "-q", "origin"], repo);
  expect((await Effect.runPromise(repoItem(change, repo))).actions ?? []).toEqual([]);
});

test("a Fast-forward whose fetch fails is refused, and moves nothing", async () => {
  const repo = await gitRepo(tmp, "ff-fetchfail", { remote: true });
  const change = await runEffect(
    createChange({
      id: "PROJ-FFFETCH",
      branch: "PROJ-FFFETCH-work",
      checkouts: checkoutsOf([repo]),
    }),
  );
  await Effect.runPromise(provisionRepositories(change));
  const worktree = (await runEffect(checkoutFor(change, repo)))!;
  const before = (await runSh(["git", "rev-parse", "HEAD"], worktree)).stdout.trim();
  // The remote stops answering after the checkout exists: the action fetches first, so it must
  // report the fetch rather than advance against refs that may be stale.
  await runSh(["git", "remote", "set-url", "origin", join(tmp, "gone.git")], repo);
  await expect(Effect.runPromise(gitRun(change, "fast-forward", repo))).rejects.toThrow(/fetch failed/);
  expect((await runSh(["git", "rev-parse", "HEAD"], worktree)).stdout.trim()).toBe(before);
  expect((await runSh(["git", "rev-parse", "--abbrev-ref", "HEAD"], worktree)).stdout.trim()).toBe(
    "PROJ-FFFETCH-work",
  );
});

test("the card fetches in the background so Fast-forward is reachable, at most once per window", async () => {
  const git = (await import("../apps/server/src/integrations/git/index.ts")).default;
  const repo = await gitRepo(tmp, "ff-reachable", { remote: true });
  const origin = join(tmp, "ff-reachable.git");
  const other = join(tmp, "ff-reachable-other");
  const change = await runEffect(
    createChange({
      id: "PROJ-FFREACH",
      branch: "PROJ-FFREACH-work",
      checkouts: checkoutsOf([repo]),
    }),
  );
  await Effect.runPromise(provisionRepositories(change));
  await pushToBase(origin, other, "later.txt");
  const pushedTip = (await runSh(["git", "rev-parse", "main"], other)).stdout.trim();

  // Before the card has fetched, the local measurement is honest — clean, no action — which is
  // what the card read paints first (it never waits for the network).
  expect((await Effect.runPromise(repoItem(change, repo))).actions ?? []).toEqual([]);

  const card = (): Promise<{ actions?: { id: string }[]; detail?: string }[]> =>
    runEffect(git.cards[0]!.repoStatus!(change, repo));
  // The read kicks a background fetch; once it lands, the next poll offers the action.
  await card();
  expect(
    await until(
      () => runSh(["git", "rev-parse", "origin/main"], repo).then((result) => result.stdout.trim()),
      pushedTip,
    ),
  ).toBe(pushedTip);
  const offered = (await card())[0];
  expect(offered?.actions?.map((action) => action.id)).toEqual(["fast-forward"]);
  expect(offered?.detail).toContain("1 behind base origin/main");

  // A second base commit within the window is not fetched: one fetch per repository per window,
  // not one per poll. (Turnover below is driven by the override, not by waiting out the clock.)
  await pushToBase(origin, other, "later.txt");
  const secondTip = (await runSh(["git", "rev-parse", "main"], other)).stdout.trim();
  expect((await card())[0]?.detail).toContain("1 behind base origin/main");
  expect((await runSh(["git", "rev-parse", "origin/main"], repo)).stdout.trim()).toBe(pushedTip);

  await withEnv({ CORVI_CARD_FETCH_MS: "1" }, async () => {
    // The window is a millisecond now; let it pass so the next read fetches again.
    await Bun.sleep(5);
    await card();
    expect(
      await until(
        () => runSh(["git", "rev-parse", "origin/main"], repo).then((result) => result.stdout.trim()),
        secondTip,
      ),
    ).toBe(secondTip);
    expect((await card())[0]?.detail).toContain("2 behind base origin/main");
  });
});

test("the card's background fetch runs with the change's workspace env", async () => {
  const git = (await import("../apps/server/src/integrations/git/index.ts")).default;
  const repo = await gitRepo(tmp, "ws-env-fetch", { remote: true });
  const origin = join(tmp, "ws-env-fetch.git");
  const other = join(tmp, "ws-env-fetch-other");
  // The origin URL is deliberately unusable; only the workspace's env (a global git config with
  // a URL rewrite) can resolve it. `env` is how a workspace supplies git credentials, so a
  // background fetch without it would fail silently and Fast-forward would never appear.
  const configPath = join(tmp, "ws-env-fetch.gitconfig");
  await Bun.write(
    configPath,
    `[url "file://${origin}"]\n\tinsteadOf = https://unreachable.example/ws-env-fetch.git\n`,
  );
  const workspace = { id: "ws-env", name: "ws-env", settings: { env: { GIT_CONFIG_GLOBAL: configPath } } };
  await withRuntimeConfig({ workspaces: [workspace] }, async () => {
    const change = await runEffect(
      createChange({
        id: "PROJ-WSENV",
        branch: "PROJ-WSENV-work",
        workspace: "ws-env",
        checkouts: checkoutsOf([repo]),
      }),
    );
    await Effect.runPromise(provisionRepositories(change));
    await runSh(["git", "remote", "set-url", "origin", "https://unreachable.example/ws-env-fetch.git"], repo);
    await pushToBase(origin, other, "later.txt");
    const pushedTip = (await runSh(["git", "rev-parse", "main"], other)).stdout.trim();

    const card = (): Promise<{ actions?: { id: string }[] }[]> =>
      runEffect(git.cards[0]!.repoStatus!(change, repo));
    await card();
    const landed = await until(
      () => runSh(["git", "rev-parse", "origin/main"], repo).then((result) => result.stdout.trim()),
      pushedTip,
    );
    expect(landed).toBe(pushedTip);
    expect((await card())[0]?.actions?.map((action) => action.id)).toEqual(["fast-forward"]);
  });
});

test("the card's default-branch read agrees with the policy's when no remote names one", async () => {
  // No remote means no `origin/HEAD` at all, so both reads have to fall back to the local default
  // branch — and a fetch cannot recreate the metadata in between. The card's read and the one
  // provisioning used must name the same ref.
  const repo = await gitRepo(tmp, "no-origin-head", {});
  const change = await runEffect(
    createChange({ id: "PROJ-NOHEAD", branch: "PROJ-NOHEAD-work", checkouts: checkoutsOf([repo]) }),
  );
  await Effect.runPromise(provisionRepositories(change));
  const entry = (await Effect.runPromise(entryFor(change, repo)))!;
  expect(entry.base_state?.base).toBe("main");
  // The worktree was cut from `main` by the capability's read: the same branch the card names.
  expect((await runEffect(checkoutFor(change, repo))) !== undefined).toBe(true);
  const mergeBase = (await runSh(["git", "merge-base", change.branch, "main"], repo)).stdout.trim();
  const mainTip = (await runSh(["git", "rev-parse", "main"], repo)).stdout.trim();
  expect(mergeBase).toBe(mainTip);
});

test("the merged proof follows the branch's target, not the repository default", async () => {
  const repo = await gitRepo(tmp, "target-proof", { remote: true });
  // A release branch beside main: this change's work lands there, not on the default branch.
  await runSh(["git", "checkout", "-q", "-b", "release"], repo);
  await Bun.write(join(repo, "release.txt"), "release\n");
  await runSh(["git", "add", "."], repo);
  await commitIn(repo, "the release branch");
  await runSh(["git", "push", "-q", "-u", "origin", "release"], repo);
  await runSh(["git", "checkout", "-q", "main"], repo);
  const change = await runEffect(
    createChange({
      id: "PROJ-TARGETPROOF",
      branch: "PROJ-TARGETPROOF-work",
      checkouts: [{ path: repo, location: "new", branch: { kind: "change" }, base: "release" }],
    }),
  );
  await Effect.runPromise(provisionRepositories(change));
  const worktree = (await runEffect(checkoutFor(change, repo)))!;
  await Bun.write(join(worktree, "work.txt"), "the work\n");
  await runSh(["git", "add", "."], worktree);
  await commitIn(worktree, "the work");

  // The work reaches main, but the change's target is release: measuring against the repository
  // default would call this merged; the branch's own landing ref says otherwise.
  await runSh(["git", "merge", "-q", "--no-ff", "-m", "land it on main", change.branch], repo);
  await runSh(["git", "push", "-q", "origin", "main"], repo);
  const notMerged = (await Effect.runPromise(entryFor(change, repo)))!;
  expect(notMerged.main_state).toBe("diverged");
  expect((await Effect.runPromise(repoItem(change, repo))).detail).not.toContain("merged");

  // It lands in release, the branch's actual target.
  await runSh(["git", "checkout", "-q", "release"], repo);
  await runSh(["git", "merge", "-q", "--no-ff", "-m", "land it on release", change.branch], repo);
  await runSh(["git", "checkout", "-q", "main"], repo);
  const merged = (await Effect.runPromise(entryFor(change, repo)))!;
  expect(merged.main_state).toBe("integrated");
  expect((await Effect.runPromise(repoItem(change, repo))).detail).toContain("merged");
});

test("a repos edit decided on a stale read cannot revert the phase", async () => {
  const { patchChange } = await import("../apps/server/src/change/routes.ts");
  const first = await gitRepo(tmp, "repos-race-a", { remote: true });
  const second = await gitRepo(tmp, "repos-race-b", { remote: true });
  const change = await runEffect(
    createChange({
      id: "PROJ-REPOSRACE",
      state: "Ideation",
      branch: "PROJ-REPOSRACE-x",
      checkouts: checkoutsOf([first]),
    }),
  );
  await Effect.runPromise(provisionRepositories(change));
  const observed = (await runEffect(readChange(change.id)))!;
  // The phase changes after the repos edit read the record.
  const started = await runEffect(patchChange(observed, { state: "Implementation" }));
  expect(started.startedAt).toBeDefined();

  const result = await runEffect(setRepos(observed, checkoutsOf([second])).pipe(Effect.result));
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(result.failure._tag).toBe("ChangeConflict");

  // The phase and its `startedAt` stand, the repository list is unchanged, and nothing was torn
  // down before the write was refused.
  const after = (await runEffect(readChange(change.id)))!;
  expect(after.state).toBe("Implementation");
  expect(after.startedAt).toBe(started.startedAt);
  expect(after.checkouts?.map((spec) => spec.path)).toEqual([first]);
  expect((await lstat(join(changeDir(after), basename(first)))).isDirectory()).toBe(true);
});

test("a change branch whose target is its own remote name proves nothing", async () => {
  const repo = await gitRepo(tmp, "target-self-change", { remote: true });
  const branch = "PROJ-TARGETSELFCHANGE-work";
  const change = await runEffect(
    createChange({
      id: "PROJ-TARGETSELFCHANGE",
      branch,
      checkouts: [
        {
          path: repo,
          location: "new",
          branch: { kind: "change" },
          // A push makes `origin/<branch>` exist; treating it as the landing ref would compare
          // the branch with its own remote tip and call it merged.
          target: `origin/${branch}`,
        },
      ],
    }),
  );
  await Effect.runPromise(provisionRepositories(change));
  const worktree = (await runEffect(checkoutFor(change, repo)))!;
  await Bun.write(join(worktree, "work.txt"), "the work\n");
  await runSh(["git", "add", "."], worktree);
  await commitIn(worktree, "the work");
  await runSh(["git", "push", "-q", "-u", "origin", branch], worktree);

  const entry = (await Effect.runPromise(entryFor(change, repo)))!;
  expect(entry.main_state).toBeUndefined();
  expect((await Effect.runPromise(repoItem(change, repo))).detail).not.toContain("merged");
});

test("a branch whose target is its own counterpart proves nothing", async () => {
  const repo = await gitRepo(tmp, "target-self", { remote: true });
  await runSh(["git", "checkout", "-q", "-b", "feature"], repo);
  await Bun.write(join(repo, "feature.txt"), "feature\n");
  await runSh(["git", "add", "."], repo);
  await commitIn(repo, "feature work");
  await runSh(["git", "push", "-q", "-u", "origin", "feature"], repo);
  await runSh(["git", "checkout", "-q", "main"], repo);
  const change = await runEffect(
    createChange({
      id: "PROJ-TARGETSELF",
      checkouts: [
        {
          path: repo,
          location: "new",
          branch: { kind: "existing", name: "feature" },
          // The branch names its own remote counterpart as the target: comparing it with itself
          // would always read "merged" for work that never left.
          target: "origin/feature",
        },
      ],
    }),
  );
  await Effect.runPromise(provisionRepositories(change));
  const entry = (await Effect.runPromise(entryFor(change, repo)))!;
  expect(entry.main_state).toBeUndefined();
  expect((await Effect.runPromise(repoItem(change, repo))).detail).not.toContain("merged");
});

test("an in-place checkout on its expected branch offers Fast-forward too", async () => {
  const repo = await gitRepo(tmp, "ff-inplace-repo", { remote: true });
  const change = await runEffect(
    createChange({
      id: "PROJ-FFINPLACE",
      branch: "PROJ-FFINPLACE-work",
      checkouts: [{ path: repo, location: "original" as const, branch: { kind: "change" as const } }],
    }),
  );
  await Effect.runPromise(provisionRepositories(change));
  expect((await Effect.runPromise(repoItem(change, repo))).actions ?? []).toEqual([]);

  await pushToBase(join(tmp, "ff-inplace-repo.git"), join(tmp, "ff-inplace-other"), "later.txt");
  await runSh(["git", "fetch", "-q", "origin"], repo);
  const offered = await Effect.runPromise(repoItem(change, repo));
  expect(offered.actions?.map((action) => action.id)).toEqual(["fast-forward"]);

  await Effect.runPromise(gitRun(change, "fast-forward", repo));
  const tip = (await runSh(["git", "rev-parse", "HEAD"], repo)).stdout.trim();
  const baseTip = (await runSh(["git", "rev-parse", "origin/main"], repo)).stdout.trim();
  expect(tip).toBe(baseTip);
  expect((await Effect.runPromise(repoItem(change, repo))).actions ?? []).toEqual([]);

  // Uncommitted work is a refusal even when the base moved: the action never advances under
  // local edits, whether or not git would let the files it updates alone.
  await pushToBase(join(tmp, "ff-inplace-repo.git"), join(tmp, "ff-inplace-other"), "later.txt");
  await Bun.write(join(repo, "README.md"), "my unsaved edit\n");
  await expect(Effect.runPromise(gitRun(change, "fast-forward", repo))).rejects.toThrow(
    /uncommitted changes/,
  );
  expect((await runSh(["git", "rev-parse", "HEAD"], repo)).stdout.trim()).toBe(tip);
  expect(await Bun.file(join(repo, "README.md")).text()).toBe("my unsaved edit\n");
});

test("the capability store and the app store serialize on the one record lock", async () => {
  const change = await runEffect(createChange({ id: "PROJ-LOCKRACE", state: "Ideation" }));
  const observed = (await runEffect(readChange(change.id)))!;
  const expected = observed.revision ?? 0;
  // Two writers, both decided on the same revision: the capability store's patch and the app
  // store's conditional write. The process-wide record lock is what makes the pair one winner
  // and one loser, not the revision check alone.
  const capabilityPatch = Effect.gen(function* () {
    const store = yield* ChangeStore;
    return yield* store.patch(ChangeId.make(change.id), {
      phase: "Verification",
      expectedRevision: expected,
    });
  }).pipe(Effect.provide(storeLayer({ roots: changePairs() })));
  const appWrite = writeChangeAt({ ...observed, title: "the app store won" }, expected);
  const results = await Effect.runPromise(
    Effect.all([Effect.result(capabilityPatch), Effect.result(appWrite)], { concurrency: "unbounded" }),
  );
  expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
  const loser = results.find((result) => result._tag === "Failure");
  expect(loser !== undefined && loser._tag === "Failure" ? loser.failure._tag : "").toBe("ChangeConflict");

  // Exactly one edit landed, on the revision the winner wrote.
  const after = (await runEffect(readChange(change.id)))!;
  expect([after.state === "Verification", after.title === "the app store won"].filter(Boolean)).toHaveLength(
    1,
  );
  expect(after.revision).toBe(expected + 1);
});
