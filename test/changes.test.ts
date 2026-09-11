import { config } from "../src/workspace/server/index.ts";
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
} from "../src/change/server/index.ts";
import { provisionRepo, gitRun, repoItem, checkoutFor, currentBranch } from "../src/core/integrations/git.ts";
import { Effect } from "effect";
import type { Change } from "../src/core/domain/change.ts";
import type { TmuxWindow } from "../src/core/host/api.ts";
import type { PresentedWindow } from "../src/terminal/server/index.ts";
import { runEffect, runSh, TestError } from "./helpers.ts";

let tmp: string;
let repo: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "iwe-"));
  process.env.IWE_ROOT = join(tmp, "changes");
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
  const change = await runEffect(createChange({ id: "PROJ-1", repos: [repo] }));
  expect(change.branch).toBe("PROJ-1");
  expect(await runEffect(listChanges())).toHaveLength(1);

  const before = await Effect.runPromise(repoItem(change, repo));
  expect(before.state).toBe("none");
  expect(before.actions?.[0]?.id).toBe("add");

  // wt is pointed at the change directory, so the worktree lives with the change's own state.
  // realpath on both sides: macOS temp dirs are symlinks into /private.
  // The same checkouts the git extension's change:created hook creates.
  await Effect.runPromise(Effect.forEach(change.repos, (repo) => provisionRepo(change, repo), { concurrency: 1 }));
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
  await runEffect(createChange({ id: "PROJ-2", repos: [repo] }));
  expect(runEffect(createChange({ id: "PROJ-2", repos: [repo] }))).rejects.toThrow("already exists");
  expect(runEffect(createChange({ id: "../escape", repos: [repo] }))).rejects.toThrow("invalid change id");
  expect(runEffect(createChange({ id: "PROJ-3" }))).rejects.toThrow("at least one repository");
});

test("completed changes move to the archive and stay listable", async () => {
  const change = await runEffect(createChange({ id: "PROJ-9", repos: [repo] }));
  expect(await runEffect(listChanges())).toContainEqual(change);

  await runEffect(archiveChange(change.id));
  expect(await Bun.file(join(changeDir(change.id), "change.json")).exists()).toBe(false);
  expect(await Bun.file(join(archiveDir(change.id), "change.json")).exists()).toBe(true);

  // Reading, writing and listing all still find it where it now lives.
  expect(await runEffect(readChange(change.id))).toEqual(change);
  const completed = { ...change, completedAt: new Date().toISOString() };
  await runEffect(writeChange(completed));
  expect(await runEffect(readChange(change.id))).toEqual(completed);
  expect(await runEffect(listChanges())).toContainEqual(completed);
  expect(await runEffect(listChanges())).not.toContainEqual(change);
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

  const change = await runEffect(createChange({ id: "PROJ-REMOTE", repos: [clone] }));
  // The same checkouts the git extension's change:created hook creates.
  await Effect.runPromise(Effect.forEach(change.repos, (repo) => provisionRepo(change, repo), { concurrency: 1 }));

  const worktree = (await runEffect(checkoutFor(change, clone)))!;
  expect(await Bun.file(join(worktree, "f.txt")).text()).toBe("one\ntwo\n");
});

test("a change starts in progress and completing it is what sets Completed", async () => {
  const change = await runEffect(createChange({ id: "PROJ-STATE", repos: [repo] }));
  expect(change.state).toBe("In Progress");

  // Completing writes the state along with the timestamp; here just the shape of that write.
  await runEffect(writeChange({ ...change, state: "Awaiting Review" }));
  expect((await runEffect(readChange(change.id)))?.state).toBe("Awaiting Review");
});

test("a repository used in place is linked and switched, dirty ones are left alone", async () => {
  const { setRepos, isDirect } = await import("../src/core/integrations/git.ts");
  const clean = await makeRepo("clean");
  const dirty = await makeRepo("dirty");
  await Bun.write(join(dirty, "scratch.txt"), "half-finished work\n");

  const change = await runEffect(createChange({
    id: "PROJ-DIRECT",
    branch: "PROJ-DIRECT-work",
    repos: [clean, dirty],
    direct: [clean, dirty],
  }));
  expect(isDirect(change, clean)).toBe(true);
  // The same checkouts the git extension's change:created hook creates.
  await Effect.runPromise(Effect.forEach(change.repos, (repo) => provisionRepo(change, repo), { concurrency: 1 }));

  // Both are linked from the change directory, so it still shows everything the change touches.
  for (const repo of [clean, dirty]) {
    expect(await realpath(join(changeDir(change.id), basename(repo)))).toBe(await realpath(repo));
  }
  // The clean one moved to the branch; the dirty one kept its own, uncommitted work intact.
  expect(await runEffect(currentBranch(clean))).toBe("PROJ-DIRECT-work");
  expect(await runEffect(currentBranch(dirty))).toBe("main");
  expect(await Bun.file(join(dirty, "scratch.txt")).text()).toBe("half-finished work\n");

  // Dropping it removes the link only: the checkout and its branch stay.
  const result = await runEffect(setRepos(change, [dirty], true, [dirty]));
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
    repos: [clone],
    base: { [clone]: "origin/PROJ-1-first" },
  }));
  // The same checkouts the git extension's change:created hook creates.
  await Effect.runPromise(Effect.forEach(change.repos, (repo) => provisionRepo(change, repo), { concurrency: 1 }));

  // The file only the base branch has must be there: the new branch grew out of it.
  const worktree = (await runEffect(checkoutFor(change, clone)))!;
  expect(await Bun.file(join(worktree, "first.txt")).text()).toBe("work of the change below\n");

  // And a change without a base still starts from the remote default, which has no such file.
  const plain = await runEffect(createChange({ id: "PROJ-PLAIN", branch: "PROJ-PLAIN-x", repos: [clone] }));
  // The same checkouts the git extension's change:created hook creates.
  await Effect.runPromise(Effect.forEach(plain.repos, (repo) => provisionRepo(plain, repo), { concurrency: 1 }));
  const plainTree = (await runEffect(checkoutFor(plain, clone)))!;
  expect(await Bun.file(join(plainTree, "first.txt")).exists()).toBe(false);
});

test("a completed change is listed once, even when its directory is left behind", async () => {
  const change = await runEffect(createChange({ id: "PROJ-TWICE", repos: [repo] }));
  await runEffect(archiveChange(change.id));
  // A terminal, or a build, writing into the change's original path recreates it after the
  // archive moved.
  await Bun.write(join(changeDir(change.id), "terminal.json"), "{}\n");

  const listed = (await runEffect(listChanges())).filter((c) => c.id === "PROJ-TWICE");
  expect(listed.length).toBe(1);
});


test("a completion records itself before it starts checking anything", async () => {
  const { completeChange, progressOf } = await import("../src/change/server/index.ts");
  const change = await runEffect(createChange({ id: "PROJ-EARLY", repos: [repo] }));

  // Nothing yet: a change that was never completed has no record at all.
  expect(await runEffect(progressOf(change.id))).toBeNull();

  // The repository has no remote, so the readiness check refuses. That refusal is recorded too,
  // so a page opened later still sees it.
  expect(runEffect(completeChange(change))).rejects.toThrow(/cannot complete/);
  await Bun.sleep(2000);
  const failed = (await runEffect(progressOf(change.id)))!;
  expect(failed.startedAt).toBeTruthy();
  expect(failed.steps[0]).toMatchObject({ id: "check", state: "failed" });
  expect(failed.steps[0]!.detail).toContain("no worktree");
  expect(failed.error).toContain("cannot complete");
  expect(failed.finishedAt).toBeTruthy();
}, 20_000);

test("the overview counts windows that are running something, not windows", async () => {
  // Busy is a presented fact now: the merge in terminal/server/presenter.ts says which windows
  // are work.
  const { presentWindow } = await import("../src/terminal/server/index.ts");
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

  // An agent says what it is doing, and is believed: pi at its prompt is `node`, which would
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
  const { presentWindow } = await import("../src/terminal/server/index.ts");
  const presented = (option: string): PresentedWindow =>
    presentWindow({
      index: 0,
      id: "@1",
      name: "",
      command: "node",
      active: true,
      activity: false,
      directory: "example-api",
      named: false,
      options: { "@agent_status": option },
    });
  // What pi's busy-title extension sets with `tmux set -p @agent_status ...`.
  expect(presented("working")).toMatchObject({ label: "example-api - (pi working)", icon: "agent", state: "ok" });
  expect(presented("waiting")).toMatchObject({ label: "example-api - (pi waiting)", icon: "agent", state: "idle" });
  // Unset, or set to something else by something else: no claim is made about the window.
  expect(presented("")).toMatchObject({ label: "example-api - (node)", icon: "terminal", state: "idle" });
  expect(presented("busy")).toMatchObject({ label: "example-api - (node)", icon: "terminal", state: "idle" });
});

test("a change is named after its ticket, and keeps that name when its vendor is not there", async () => {
  const { refreshTitles } = await import("../src/change/server/index.ts");
  const { install, loaded } = await import("../src/core/host/index.ts");

  // A stub source claiming every change that has a jira key, answering from a map the test
  // controls.
  const answers = new Map<string, string>();
  const restore = loaded.splice(0, loaded.length);
  install({
    name: "stub",
    title: "Stub",
    titleSources: [
      {
        applies: (c) => Boolean(c.jira),
        lookup: (changes) => {
          asked = changes.map((c) => c.jira!);
          return Effect.succeed(
            new Map(
              changes.filter((c) => answers.has(c.jira!)).map((c) => [c.id, answers.get(c.jira!)!]),
            ),
          );
        },
      },
    ],
  });

  const named = await runEffect(createChange({ id: "PROJ-NAMED", repos: [repo], jira: "PROJ-7" }));
  const bare = await runEffect(createChange({ id: "PROJ-BARE", repos: [repo] }));

  // Captured rather than asserted inside: refreshTitles treats a failing source as "the vendor
  // is not answering", which would swallow the failure and pass the test for the wrong reason.
  let asked: string[] = [];
  answers.set("PROJ-7", "Split the invoice export");
  const titles = await runEffect(refreshTitles());
  // One question for the whole page, and only for changes that have a ticket at all.
  expect(asked).toContain("PROJ-7");
  expect(asked).not.toContain("PROJ-BARE");
  expect(titles["PROJ-NAMED"]).toBe("Split the invoice export");
  expect(titles["PROJ-BARE"]).toBeUndefined(); // no ticket: the page falls back to the branch

  // Stored, so the list itself carries the name and the page needs no CLI call to draw.
  expect((await runEffect(readChange(named.id)))?.title).toBe("Split the invoice export");
  expect((await runEffect(readChange(bare.id)))?.title).toBeUndefined();

  // A renamed ticket is followed.
  answers.set("PROJ-7", "Split the export in two");
  await runEffect(refreshTitles());
  expect((await runEffect(readChange(named.id)))?.title).toBe("Split the export in two");

  // A vendor that answers nothing — down, unauthenticated, ticket deleted — keeps the last name
  // rather than falling back to a branch nobody recognises.
  answers.clear();
  const kept = await runEffect(refreshTitles());
  expect(kept["PROJ-NAMED"]).toBe("Split the export in two");
  expect((await runEffect(readChange(named.id)))?.title).toBe("Split the export in two");

  loaded.splice(0, loaded.length, ...restore);
});

test("a change may be blocked, which is active but not workable", async () => {
  const { CHANGE_STATES, isFinished } = await import("../src/core/domain/change.ts");
  const { stateClass } = await import("../src/change/client/changeState.tsx");

  // How much of your attention each state asks for: the select offers them in this order and the
  // lists sort by it.
  expect(CHANGE_STATES).toEqual([
    "In Progress",
    "Awaiting Review",
    "Blocked",
    "Completed",
    "Cancelled",
  ]);
  expect(stateClass("Blocked")).toBe("state-blocked");

  // The server accepts it, and the overview counts it among the active changes: blocked work is
  // work you still have.
  const change = await runEffect(createChange({ id: "PROJ-BLOCKED", repos: [repo] }));
  const blocked = { ...change, state: "Blocked" as const };
  await runEffect(writeChange(blocked));
  expect((await runEffect(readChange(change.id)))?.state).toBe("Blocked");
  expect(isFinished(blocked)).toBe(false);
});

test("a name you wrote yourself is not overwritten by the ticket's", async () => {
  const { refreshTitles } = await import("../src/change/server/index.ts");
  const { install, loaded } = await import("../src/core/host/index.ts");

  const answers = new Map<string, string>();
  let asked: string[] = [];
  const restore = loaded.splice(0, loaded.length);
  install({
    name: "stub",
    title: "Stub",
    titleSources: [
      {
        applies: (c) => Boolean(c.jira),
        lookup: (changes) => {
          asked = changes.map((c) => c.jira!);
          return Effect.succeed(
            new Map(
              changes.filter((c) => answers.has(c.jira!)).map((c) => [c.id, answers.get(c.jira!)!]),
            ),
          );
        },
      },
    ],
  });

  const change = await runEffect(createChange({ id: "PROJ-NAME", repos: [repo], jira: "PROJ-8" }));

  // Until you say otherwise, the ticket names the change.
  answers.set("PROJ-8", "As the ticket puts it");
  await runEffect(refreshTitles());
  expect((await runEffect(readChange(change.id)))?.title).toBe("As the ticket puts it");

  // Renaming it here says the name is yours: the ticket is not asked about any more.
  await runEffect(writeChange({ ...(await runEffect(readChange(change.id)))!, title: "What it is really about", titleEdited: true }));
  await runEffect(refreshTitles());
  expect(asked).not.toContain("PROJ-8");
  expect((await runEffect(readChange(change.id)))?.title).toBe("What it is really about");

  loaded.splice(0, loaded.length, ...restore);
});

test("the summary gathers the core's terminals fact and the extensions' contributions", async () => {
  const { summaryOf } = await import("../src/change/overview/server/index.ts");
  const { install, loaded } = await import("../src/core/host/index.ts");

  const restore = loaded.splice(0, loaded.length);
  install({
    name: "stub-summary",
    title: "Stub",
    summaryContributions: [
      {
        facts: () =>
          Effect.succeed({
            facts: [{ id: "tickets", label: "1 ticket open", state: "warn" }],
            state: "warn",
          }),
      },
      // A contributor whose vendor is down: it contributes nothing, never a failed request.
      { facts: () => Effect.fail(new TestError({ message: "down" })) },
    ],
  });

  try {
    // A change with a repository but no tmux session: nothing busy, nothing contributed
    // except the stub's say-so.
    const change = await runEffect(createChange({ id: "PROJ-SUMMARY", repos: [repo] }));
    const summary = await Effect.runPromise(summaryOf(change));

    // The core's own fact comes first, the contributed facts after it in load order — and the
    // failing contributor is simply absent, not an error on the card.
    expect(summary.facts).toEqual([
      { id: "terminals", label: "terminals idle", state: "none" },
      { id: "tickets", label: "1 ticket open", state: "warn" },
    ]);
    // The icon takes the worst of the verdicts that were offered; the failure offered none.
    expect(summary.state).toBe("warn");
  } finally {
    loaded.splice(0, loaded.length, ...restore);
  }
});

test("the icons take the worst of what the repositories say", async () => {
  const { worst } = await import("../src/core/domain/widget.ts");
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
  const { changeOfSession } = await import("../src/terminal/server/index.ts");
  // The navigation column lists the terminals of every change at once; asking tmux per change
  // would be a process per change every few seconds.
  expect(changeOfSession("iwe-PROJ-1")).toBe("PROJ-1");
  expect(changeOfSession("iwe-PROJ-1671-2")).toBe("PROJ-1671-2");
  // Sessions you started yourself are left alone, and not shown as terminals of a change.
  expect(changeOfSession("work")).toBeUndefined();
  expect(changeOfSession("")).toBeUndefined();
});

test("a change belongs to the context it was made in, and older ones to the first", async () => {
  const { inWorkspace, workspaceOf, ALL } = await import("../src/workspace/client/workspaces.ts");
  const workspaces = [
    { id: "client", name: "Acme" },
    { id: "personal", name: "Personal" },
  ];
  const change = (id: string, workspace?: string): never => ({ id, workspace }) as never;
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
  const original = { ...config };
  const { azureOf, usesAzure, workspaceOf } = await import("../src/workspace/server/index.ts");
  const { extensionsFor, loaded } = await import("../src/core/host/index.ts");
  const { siteFor } = await import("../src/extensions/jira/jira.ts");
  // Two contexts: a client with everything, and personal projects with neither. The personal
  // one names its extensions explicitly — enablement is the list, not a vendor flag — and keeps
  // `azure: false` for the pipelines it has none of.
  (config as { workspaces: unknown }).workspaces = [
    { id: "client", name: "Acme", azure: { organization: "https://dev.azure.com/one", project: "A" } },
    {
      id: "personal",
      name: "Personal",
      azure: false,
      extensions: loaded.map((e) => e.name).filter((n) => n !== "jira" && n !== "deployments"),
    },
  ];

  const client = { id: "PROJ-1", workspace: "client" } as never;
  const personal = { id: "IWE-1", workspace: "personal" } as never;
  const old = { id: "OLD-1" } as never; // no workspace: it belongs to the first one

  // A personal project has no ticket, and being asked about one is noise and a CLI call: the
  // jira extension is not there at all. The CI card is pull requests as well as pipelines, so
  // it stays either way.
  expect(extensionsFor(workspaceOf(client)).some((e) => e.name === "jira")).toBe(true);
  expect(extensionsFor(workspaceOf(personal)).some((e) => e.name === "jira")).toBe(false);
  expect(extensionsFor(workspaceOf(personal)).some((e) => e.name === "ci")).toBe(true);
  expect(usesAzure(workspaceOf(personal))).toBe(false);

  // Whose Azure DevOps, and whose Jira: what makes two clients possible rather than one. Jira's
  // site comes from the extension's own per-workspace settings; a workspace with none of them
  // uses whatever jira-cli itself has configured.
  expect(azureOf(workspaceOf(client)).organization).toBe("https://dev.azure.com/one");
  expect(siteFor("personal")).toEqual({});
  expect(siteFor("client")).toEqual({});

  // A change with no workspace belongs to the first workspace.
  expect(workspaceOf(old).id).toBe("client");

  (config as { workspaces: unknown }).workspaces = original.workspaces;
});
