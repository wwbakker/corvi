import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, realpath, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  CORE_SIDECARS,
  PLAN_FILE,
  archiveDir,
  changeDir,
  completeChange,
  completionOf,
  createChange,
  readChange,
  readSidecar,
  startChangeWithWorkflow,
  writeSidecar,
} from "../apps/server/src/change/server/index.ts";
import { gitRun, provisionRepositories, setRepos } from "../apps/server/src/change/provisioning.ts";
import { checkoutFor } from "../apps/server/src/vendors/git.ts";
import { isIdeation, slugFor } from "@corvi/changes/record";
import type { Change } from "@corvi/changes/record";
import { checkoutsOf, runCancel, runEffect, runSetRepos, runSh  } from "./helpers.ts";
import type { ShellResult } from "../apps/server/src/capabilities/shell.ts";

/**
 * The ideation stage: an idea is created with a title and a plan and nothing else — no branch,
 * no worktree, no ticket transition — and starting it is the real transition that provisions
 * the work. These pin the create/start split and the git hook that distinguishes them.
 */

let tmp: string;

const commit = (repo: string, message: string): Promise<ShellResult> =>
  runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", message], repo);

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

beforeAll(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), "corvi-ideation-")));
  process.env.CORVI_ROOT = join(tmp, "changes");
  process.env.CORVI_ARCHIVE_ROOT = join(tmp, "changes-archive");
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

test("a title becomes an identifier", () => {
  expect(slugFor("Ideation Stage")).toBe("ideation-stage");
  expect(slugFor("  Spaces   and   case  ")).toBe("spaces-and-case");
  // Accents fold to ASCII so the directory and branch stay portable.
  expect(slugFor("Café déjà vu")).toBe("cafe-deja-vu");
  // Nothing usable is the empty string, which the create form refuses for lack of an id.
  expect(slugFor("!!!")).toBe("");
  expect(slugFor("x".repeat(100)).length).toBe(60);
  expect(slugFor("x".repeat(100)).endsWith("-")).toBe(false);
});

test("an idea is created without repositories and carries a plan", async () => {
  const idea = await runEffect(
    createChange({ id: "idea-one", title: "Ideation Stage", state: "Ideation" }),
  );
  expect(idea.state).toBe("Ideation");
  expect(((idea).checkouts ?? []).map((spec) => spec.path)).toEqual([]);
  expect(idea.title).toBe("Ideation Stage");
  // Typed, not taken from a ticket: no title source may overwrite it later.
  expect(idea.titleEdited).toBe(true);
  expect(isIdeation(idea)).toBe(true);

  // PLAN.md is a core sidecar: it archives with the change, and the capability's migration read
  // cannot be turned on it.
  expect(CORE_SIDECARS.has(PLAN_FILE)).toBe(true);
  await runEffect(writeSidecar(idea.id, PLAN_FILE, "# Plan\n\nSomething.\n"));
  expect(await runEffect(readSidecar(idea.id, PLAN_FILE))).toBe("# Plan\n\nSomething.\n");
});

test("starting is a real transition, and only from an idea", async () => {
  const idea = await runEffect(createChange({ id: "idea-start", state: "Ideation" }));
  const started = await runEffect(startChangeWithWorkflow(idea));
  expect(started.change.state).toBe("Implementation");
  expect((await runEffect(readChange("idea-start")))?.state).toBe("Implementation");
  // Starting twice would claim work that already happened (and provision a second time).
  await expect(runEffect(startChangeWithWorkflow(started.change))).rejects.toThrow(
    /already started/,
  );
});

test("a change created ready to work still needs a repository", async () => {
  await expect(runEffect(createChange({ id: "no-repos" }))).rejects.toThrow(
    "at least one repository",
  );
  // A finished state is not something you create into; only Ideation and Implementation are.
  await expect(
    runEffect(createChange({ id: "already-done", state: "Completed" })),
  ).rejects.toThrow(/Ideation or Implementation/);
});

test("an idea gets its worktree on the change branch at creation", async () => {
  const repo = await clonedRepo("ideation-repo");
  const idea = await runEffect(
    createChange({
      id: "idea-browse",
      title: "Browse the code",
      state: "Ideation",
      checkouts: checkoutsOf([repo]),
    }),
  );

  // Creating an idea cuts the worktree and the change's branch right away: an agent working in
  // the change directory works there, never through a link into the source checkout.
  await runEffect(provisionRepositories(idea));
  const worktree = join(changeDir(idea), basename(repo));
  expect((await lstat(worktree)).isDirectory()).toBe(true);
  expect((await lstat(worktree)).isSymbolicLink()).toBe(false);
  expect((await runSh(["git", "rev-parse", "--abbrev-ref", "HEAD"], worktree)).stdout.trim()).toBe(
    "idea-browse",
  );
  // The repository's own checkout is untouched.
  expect((await runSh(["git", "rev-parse", "--abbrev-ref", "HEAD"], repo)).stdout.trim()).toBe("main");

  // Starting changes the state and keeps the same checkout.
  const started = await runEffect(startChangeWithWorkflow(idea));
  expect(started.change.state).toBe("Implementation");
  expect(await runEffect(checkoutFor(started.change, repo))).toBe(worktree);
});

test("cancelling an idea takes its worktree away — but never uncommitted work", async () => {
  const repo = await clonedRepo("ideation-cancel");
  const idea = await runEffect(
    createChange({ id: "idea-cancel", state: "Ideation", checkouts: checkoutsOf([repo]) }),
  );
  await runEffect(provisionRepositories(idea));
  expect((await lstat(join(changeDir(idea), basename(repo)))).isDirectory()).toBe(true);

  const cancelled = await runCancel(idea);
  expect("change" in cancelled && cancelled.change.state).toBe("Cancelled");
  // The archived directory keeps no checkout behind.
  const archived = await lstat(join(archiveDir(idea), basename(repo))).then(
    () => true,
    () => false,
  );
  expect(archived).toBe(false);

  // The removal safety is uniform: an idea's worktree with uncommitted work refuses to go,
  // forced or not, exactly like a started change's.
  const scribbled = await runEffect(
    createChange({ id: "idea-scribbled", state: "Ideation", checkouts: checkoutsOf([repo]) }),
  );
  await runEffect(provisionRepositories(scribbled));
  await Bun.write(join(changeDir(scribbled), basename(repo), "wip.txt"), "half a thought\n");
  expect(runCancel(scribbled)).rejects.toThrow(/uncommitted changes/);
  expect(runCancel(scribbled, true)).rejects.toThrow(/uncommitted changes/);
});

test("adding a repository to an idea cuts its worktree and branch", async () => {
  const repo = await clonedRepo("ideation-add");
  const idea = await runEffect(createChange({ id: "idea-add", state: "Ideation" }));

  const updated = await runSetRepos(idea, checkoutsOf([repo]));
  expect("change" in updated).toBe(true);
  const change = (updated as { change: Change }).change;

  // The worktree on the change's branch exists from the edit, and the source checkout is still
  // the user's own.
  const worktree = join(changeDir(change), basename(repo));
  expect((await lstat(worktree)).isDirectory()).toBe(true);
  expect((await runSh(["git", "rev-parse", "--abbrev-ref", "HEAD"], worktree)).stdout.trim()).toBe(
    "idea-add",
  );
  expect((await runSh(["git", "rev-parse", "--abbrev-ref", "HEAD"], repo)).stdout.trim()).toBe("main");
});

test("a fetch that fails at creation is reported, and the row action retries it", async () => {
  const repo = await clonedRepo("ideation-fetch");
  const origin = join(tmp, "ideation-fetch.git");
  // The remote stops answering: fetch must fail loudly rather than branch from stale refs.
  await runSh(["git", "remote", "set-url", "origin", join(tmp, "gone.git")], repo);
  const idea = await runEffect(
    createChange({ id: "idea-fetch", state: "Ideation", checkouts: checkoutsOf([repo]) }),
  );

  const failed = await runEffect(provisionRepositories(idea));
  expect(failed.provision.some((result) => !result.ok && /fetch failed/.test(result.error ?? ""))).toBe(
    true,
  );
  expect(failed.refresh[0]?.state).toBe("fetch-failed");
  // The record survived, and no checkout came out of possibly-stale refs.
  expect(await Bun.file(join(changeDir(idea), basename(repo))).exists()).toBe(false);

  // The remote answers again — the row's action is the retry.
  await runSh(["git", "remote", "set-url", "origin", origin], repo);
  await runEffect(gitRun(idea, "add", repo));
  const worktree = join(changeDir(idea), basename(repo));
  expect((await lstat(worktree)).isDirectory()).toBe(true);
  expect((await runSh(["git", "rev-parse", "--abbrev-ref", "HEAD"], worktree)).stdout.trim()).toBe(
    "idea-fetch",
  );
});

test("two creation-time runs racing leave exactly one worktree and one branch", async () => {
  const repo = await clonedRepo("ideation-race");
  const idea = await runEffect(
    createChange({ id: "idea-race", state: "Ideation", checkouts: checkoutsOf([repo]) }),
  );

  // Create-time provisioning and a row retry, arriving together: the per-change lock makes the
  // second run find the checkout the first one made.
  const [first, second] = await Promise.all([
    runEffect(provisionRepositories(idea)),
    runEffect(provisionRepositories(idea)),
  ]);
  expect(first.provision.every((result) => result.ok)).toBe(true);
  expect(second.provision.every((result) => result.ok)).toBe(true);

  const worktree = join(changeDir(idea), basename(repo));
  expect((await lstat(worktree)).isDirectory()).toBe(true);
  const branches = await runSh(["git", "branch", "--list", "idea-race"], repo);
  expect(branches.stdout.trim().split("\n").filter(Boolean)).toHaveLength(1);
  // The source checkout plus exactly one linked worktree.
  const worktrees = await runSh(["git", "worktree", "list", "--porcelain"], repo);
  expect(worktrees.stdout.split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(2);
});

test("a repository edit reports its checkout failures with the edit", async () => {
  const repo = await clonedRepo("ideation-edit-fail");
  await runSh(["git", "remote", "set-url", "origin", join(tmp, "gone.git")], repo);
  const idea = await runEffect(createChange({ id: "idea-edit-fail", state: "Ideation" }));

  // The edit applies and the record survives — and what the checkout then reported rides along,
  // never a silent "Done" over a repository that was never created.
  const result = await runEffect(setRepos(idea, checkoutsOf([repo])));
  expect(result._tag).toBe("Done");
  if (result._tag === "Done") {
    expect(result.change.checkouts?.map((spec) => spec.path)).toEqual([repo]);
    expect(result.provision.some((entry) => !entry.ok && /fetch failed/.test(entry.error ?? ""))).toBe(
      true,
    );
    expect(result.refresh[0]?.state).toBe("fetch-failed");
  }
});

for (const selection of ["feature", "origin/feature"]) {
test(`an existing branch ${selection} advances toward its remote counterpart`, async () => {
  const suffix = selection.replaceAll("/", "-");
  const repoName = `ideation-existing-${suffix}`;
  const repo = await clonedRepo(repoName);
  // The branch the user keeps: made and pushed here, then the remote moves on from a second
  // clone while the local one stands still.
  await runSh(["git", "checkout", "-b", "feature"], repo);
  await Bun.write(join(repo, "feature.txt"), "feature\n");
  await runSh(["git", "add", "."], repo);
  await commit(repo, "feature work");
  await runSh(["git", "push", "--quiet", "-u", "origin", "feature"], repo);
  // Back on main: a branch is checked out in one worktree at a time, and the change's worktree
  // is where `feature` will live.
  await runSh(["git", "checkout", "main"], repo);

  const other = join(tmp, `${repoName}-other`);
  await runSh(["git", "clone", "--quiet", join(tmp, `${repoName}.git`), other]);
  await runSh(["git", "config", "user.email", "t@t"], other);
  await runSh(["git", "config", "user.name", "t"], other);
  await runSh(["git", "checkout", "feature"], other);
  await Bun.write(join(other, "more.txt"), "more\n");
  await runSh(["git", "add", "."], other);
  await commit(other, "the remote moves on");
  await runSh(["git", "push", "--quiet", "origin", "feature"], other);

  const idea = await runEffect(
    createChange({
      id: `idea-existing-${suffix}`,
      state: "Ideation",
      checkouts: [
        { path: repo, location: "new" as const, branch: { kind: "existing" as const, name: selection } },
      ],
    }),
  );
  const provision = await runEffect(provisionRepositories(idea));
  expect(provision.provision.every((entry) => entry.ok)).toBe(true);

  const worktree = join(changeDir(idea), basename(repo));
  expect((await lstat(worktree)).isDirectory()).toBe(true);
  expect((await runSh(["git", "symbolic-ref", "--short", "HEAD"], worktree)).stdout.trim()).toBe("feature");
  // Attached, then fast-forwarded to its remote counterpart's tip.
  const inWorktree = (await runSh(["git", "rev-parse", "HEAD"], worktree)).stdout.trim();
  const remoteTip = (await runSh(["git", "rev-parse", "origin/feature"], repo)).stdout.trim();
  expect(inWorktree).toBe(remoteTip);
});
}

test("an idea cannot be completed, only started", async () => {
  const idea = await runEffect(createChange({ id: "idea-complete", state: "Ideation" }));
  // No acknowledgement can make an idea completable: without force it is a structured refusal
  // (the page's hard reason), and forcing it still fails.
  const outcome = await runEffect(completeChange(idea));
  expect(outcome._tag).toBe("NotReady");
  if (outcome._tag !== "NotReady") throw new Error("expected a refusal");
  expect(outcome.refusal.reasons).toEqual([
    { text: "still an idea: start the work before completing it", kind: "hard" },
  ]);
  await expect(runEffect(completeChange(idea, true))).rejects.toThrow(/still an idea/);

  // The readiness check answers without a vendor call, so the button can explain itself.
  const completion = await runEffect(completionOf(idea));
  expect(completion.ready).toBe(false);
  expect(completion.reasons.join(" ")).toMatch(/still an idea/);

  // Nothing was written: it is still an idea.
  expect((await runEffect(readChange("idea-complete")))?.state).toBe("Ideation");
});
