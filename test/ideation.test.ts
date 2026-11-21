import { test, expect, beforeAll, afterAll } from "bun:test";
import { Effect, Result } from "effect";
import { rm, lstat } from "node:fs/promises";
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
  writeChange,
  writeSidecar,
} from "../apps/server/src/change/server/index.ts";
import { applyPatch } from "../apps/server/src/change/model.ts";
import { gitRun, provisionRepositories, setRepos } from "../apps/server/src/change/provisioning.ts";
import { checkoutFor } from "../apps/server/src/vendors/git.ts";
import { isIdeation, slugFor } from "@corvi/changes/record";
import type { Change } from "@corvi/changes/record";
import {
  callGuarded,
  checkoutsOf,
  runCancel,
  runEffect,
  runSetRepos,
  runSh,
  useOwnChangeRoot,
  commitIn,
  gitRepo,
} from "./helpers.ts";
/**
 * The ideation stage: an idea is created with a title and a plan, and its checkouts are cut
 * straight away. Ideation is an ordinary manual phase — leaving it is a phase change like any
 * other — so these pin what an idea *is*, not a separate workflow out of it.
 */
let tmp: string;
beforeAll(async () => {
  tmp = await useOwnChangeRoot("ideation");
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
  const idea = await runEffect(createChange({ id: "idea-one", title: "Ideation Stage", state: "Ideation" }));
  expect(idea.state).toBe("Ideation");
  expect((idea.checkouts ?? []).map((spec) => spec.path)).toEqual([]);
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
test("leaving Ideation is an ordinary phase change, in both directions", async () => {
  const idea = await runEffect(createChange({ id: "idea-start", state: "Ideation" }));
  const started = applyPatch(idea, { state: "Implementation" });
  await runEffect(writeChange(started));
  expect((await runEffect(readChange("idea-start")))?.state).toBe("Implementation");
  // Back to Ideation, and out again to another manual phase: no workflow is needed, and no
  // phase is a one-way door.
  const back = applyPatch(started, { state: "Ideation" });
  await runEffect(writeChange(back));
  expect((await runEffect(readChange("idea-start")))?.state).toBe("Ideation");
  expect(applyPatch(back, { state: "Blocked" }).state).toBe("Blocked");
});
test("a PATCH that names the phase a change is already in writes nothing", async () => {
  const { patchChange } = await import("../apps/server/src/change/routes.ts");
  const idea = await runEffect(createChange({ id: "idea-same-phase", state: "Ideation" }));
  const observed = (await runEffect(readChange(idea.id)))!;
  // `corvi change create` prints `change phase Implementation` as a next step; a retry must not
  // be a conflict.
  const same = await runEffect(patchChange(observed, { state: "Ideation" }));
  expect(same).toEqual(observed);
  expect((await runEffect(readChange(idea.id)))?.revision).toBe(observed.revision);
});

test("a PATCH can move the phase and rename in one write", async () => {
  const { patchChange } = await import("../apps/server/src/change/routes.ts");
  const idea = await runEffect(createChange({ id: "idea-both-at-once", state: "Ideation" }));
  const observed = (await runEffect(readChange(idea.id)))!;
  const moved = await runEffect(patchChange(observed, { state: "Implementation", title: "Both at once" }));
  expect(moved.state).toBe("Implementation");
  expect(moved.title).toBe("Both at once");
  const after = (await runEffect(readChange(idea.id)))!;
  expect(after.state).toBe("Implementation");
  expect(after.title).toBe("Both at once");
  expect(after.revision).toBe((observed.revision ?? 0) + 1);
});

test("a PATCH that loses to a concurrent finish is a conflict, not an overwrite", async () => {
  const { patchChange } = await import("../apps/server/src/change/routes.ts");
  const change = await runEffect(createChange({ id: "idea-race-finish", state: "Ideation" }));
  const observed = (await runEffect(readChange(change.id)))!;
  // The lifecycle finishes the change after this edit read it: the record moves to the archive
  // and its revision moves on with it.
  const completed = await runEffect(completeChange(observed));
  expect(completed._tag).toBe("Done");

  const result = await runEffect(patchChange(observed, { state: "Blocked" }).pipe(Effect.result));
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(result.failure._tag).toBe("ConflictError");
  // The finish stands: the stale edit neither resurrects the change nor clears its date.
  const after = await runEffect(readChange(change.id));
  expect(after?.state).toBe("Completed");
  expect(after?.completedAt).toBe(completed._tag === "Done" ? completed.change.completedAt : undefined);
});

test("startedAt survives a cancel and reopen", async () => {
  const { patchChange } = await import("../apps/server/src/change/routes.ts");
  const { reopenChange } = await import("../apps/server/src/change/server/index.ts");
  const idea = await runEffect(createChange({ id: "idea-started-reopen", state: "Ideation" }));
  const observed = (await runEffect(readChange(idea.id)))!;
  const started = await runEffect(patchChange(observed, { state: "Implementation" }));
  expect(started.startedAt).toBeDefined();
  // Back to Ideation, so cancelling remembers the phase reopening returns to.
  const back = await runEffect(patchChange(started, { state: "Ideation" }));
  expect(back.state).toBe("Ideation");
  await runCancel(back);
  expect((await runEffect(readChange(idea.id)))?.state).toBe("Cancelled");

  // The fact the ticket move is guarded by outlives the archive round-trip: reopening must not
  // re-arm it.
  const reopened = await runEffect(reopenChange((await runEffect(readChange(idea.id)))!));
  expect(reopened.change.state).toBe("Ideation");
  expect(reopened.change.startedAt).toBe(started.startedAt);
});

test("a record already outside Ideation without startedAt is stamped on its next edit", async () => {
  const { patchChange } = await import("../apps/server/src/change/routes.ts");
  const idea = await runEffect(createChange({ id: "idea-legacy-started", state: "Ideation" }));
  // An older record: written in a working phase before the fact existed.
  const legacy = (await runEffect(readChange(idea.id)))!;
  await runEffect(writeChange({ ...legacy, state: "Implementation", startedAt: undefined }));
  const onDisk = (await runEffect(readChange(idea.id)))!;
  expect(onDisk.startedAt).toBeUndefined();

  // Nothing to edit is not a write: the record and its revision are untouched.
  const untouched = await runEffect(patchChange(onDisk, {}));
  expect(untouched).toEqual(onDisk);
  expect((await runEffect(readChange(idea.id)))?.revision).toBe(onDisk.revision);

  const moved = await runEffect(patchChange(onDisk, { state: "Verification" }));
  expect(moved.startedAt).toBeDefined();
  expect((await runEffect(readChange(idea.id)))?.startedAt).toBe(moved.startedAt);
});

test("a conditional write refuses a record it cannot read", async () => {
  const { patchChange } = await import("../apps/server/src/change/routes.ts");
  const change = await runEffect(createChange({ id: "idea-unreadable", state: "Ideation" }));
  const observed = (await runEffect(readChange(change.id)))!;
  const path = join(changeDir(change), "change.json");
  const corrupt = "{ not json";
  await Bun.write(path, corrupt);

  const result = await runEffect(patchChange(observed, { state: "Implementation" }).pipe(Effect.result));
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(result.failure._tag).toBe("DecodeError");
  // A write cannot claim a revision the disk never confirmed: the file is left as it was.
  expect(await Bun.file(path).text()).toBe(corrupt);
});

test("a blank phase is refused at the boundary, and nothing is written or moved", async () => {
  const { changeRoutes } = await import("../apps/server/src/change/routes.ts");
  const idea = await runEffect(createChange({ id: "idea-blank-phase", state: "Ideation" }));
  const response = await callGuarded(changeRoutes, "PATCH", "/api/changes/:id", {
    params: { id: idea.id },
    body: { state: "" },
  });
  expect(response.status).toBe(400);
  const after = (await runEffect(readChange(idea.id)))!;
  expect(after.state).toBe("Ideation");
  expect(after.startedAt).toBeUndefined();
  expect(after.revision).toBe(1);
});

test("a change created ready to work still needs a repository", async () => {
  await expect(runEffect(createChange({ id: "no-repos" }))).rejects.toThrow("at least one repository");
  // A finished state is not something you create into; only Ideation and Implementation are.
  await expect(runEffect(createChange({ id: "already-done", state: "Completed" }))).rejects.toThrow(
    /Ideation or Implementation/,
  );
});
test("an idea gets its worktree on the change branch at creation", async () => {
  const repo = await gitRepo(tmp, "ideation-repo", { remote: true });
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
  // Leaving Ideation keeps the same checkout: the phase is a word, not a provisioning step.
  const started = applyPatch(idea, { state: "Implementation" });
  expect(await runEffect(checkoutFor(started, repo))).toBe(worktree);
});
test("cancelling an idea takes its worktree away — and shelves its uncommitted work", async () => {
  const repo = await gitRepo(tmp, "ideation-cancel", { remote: true });
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
  // The safety is uniform: an idea's worktree with uncommitted work is shelved with it, exactly
  // like a started change's, and nothing is asked — nothing is lost.
  const scribbled = await runEffect(
    createChange({ id: "idea-scribbled", state: "Ideation", checkouts: checkoutsOf([repo]) }),
  );
  await runEffect(provisionRepositories(scribbled));
  await Bun.write(join(changeDir(scribbled), basename(repo), "README.md"), "half a thought\n");
  const shelved = await runCancel(scribbled);
  expect("change" in shelved && shelved.change.state).toBe("Cancelled");
  expect("loose" in shelved && shelved.loose).toContain(
    `the uncommitted work in ${basename(repo)} is shelved; reopening the change applies it`,
  );
});
test("adding a repository to an idea cuts its worktree and branch", async () => {
  const repo = await gitRepo(tmp, "ideation-add", { remote: true });
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
  const repo = await gitRepo(tmp, "ideation-fetch", { remote: true });
  const origin = join(tmp, "ideation-fetch.git");
  // The remote stops answering: fetch must fail loudly rather than branch from stale refs.
  await runSh(["git", "remote", "set-url", "origin", join(tmp, "gone.git")], repo);
  const idea = await runEffect(
    createChange({ id: "idea-fetch", state: "Ideation", checkouts: checkoutsOf([repo]) }),
  );
  const failed = await runEffect(provisionRepositories(idea));
  expect(failed.provision.some((result) => !result.ok && /fetch failed/.test(result.error ?? ""))).toBe(true);
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
  const repo = await gitRepo(tmp, "ideation-race", { remote: true });
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
  const repo = await gitRepo(tmp, "ideation-edit-fail", { remote: true });
  await runSh(["git", "remote", "set-url", "origin", join(tmp, "gone.git")], repo);
  const idea = await runEffect(createChange({ id: "idea-edit-fail", state: "Ideation" }));
  // The edit applies and the record survives — and what the checkout then reported rides along,
  // never a silent "Done" over a repository that was never created.
  const result = await runEffect(setRepos(idea, checkoutsOf([repo])));
  expect(result._tag).toBe("Done");
  if (result._tag === "Done") {
    expect(result.change.checkouts?.map((spec) => spec.path)).toEqual([repo]);
    expect(result.provision.some((entry) => !entry.ok && /fetch failed/.test(entry.error ?? ""))).toBe(true);
    expect(result.refresh[0]?.state).toBe("fetch-failed");
  }
});
for (const selection of ["feature", "origin/feature"]) {
  test(`an existing branch ${selection} advances toward its remote counterpart`, async () => {
    const suffix = selection.replaceAll("/", "-");
    const repoName = `ideation-existing-${suffix}`;
    const repo = await gitRepo(tmp, repoName, { remote: true });
    // The branch the user keeps: made and pushed here, then the remote moves on from a second
    // clone while the local one stands still.
    await runSh(["git", "checkout", "-b", "feature"], repo);
    await Bun.write(join(repo, "feature.txt"), "feature\n");
    await runSh(["git", "add", "."], repo);
    await commitIn(repo, "feature work");
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
    await commitIn(other, "the remote moves on");
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
test("an idea is completed by the ordinary completion, with no Ideation guard", async () => {
  const idea = await runEffect(createChange({ id: "idea-complete", state: "Ideation" }));
  // With no repositories there is nothing outstanding, so the readiness check says ready.
  const completion = await runEffect(completionOf(idea));
  expect(completion.ready).toBe(true);
  expect(completion.reasons).toEqual([]);
  // And the completion runs its normal steps to the archive.
  const outcome = await runEffect(completeChange(idea));
  expect(outcome._tag).toBe("Done");
  expect((await runEffect(readChange("idea-complete")))?.state).toBe("Completed");
});
test("an idea's page offers the same state menu and actions as any other change", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { ChangeControls } = await import("../apps/web/src/change-page/client/ChangeControls.tsx");
  const { changeActions } = await import("../apps/web/src/change-page/client/changeActions.ts");
  const idea = await runEffect(createChange({ id: "idea-ui", state: "Ideation" }));
  const html = renderToStaticMarkup(
    createElement(ChangeControls, {
      change: idea,
      // The same menu every change gets: no idea branch, no Start work.
      actions: changeActions({
        completing: false,
        cancelling: false,
        completion: undefined,
        onRename: () => {},
        onCopyDescription: () => {},
        onComplete: () => {},
        onCancel: () => {},
      }),
      draft: null,
      onDraft: () => {},
      onRename: () => {},
      onState: () => {},
    }),
  );
  // The state is the dropdown, as for any other phase — not the static chip an unavailable
  // workspace shows — and the actions are the change's own menu.
  expect(html).toContain(`class="state `);
  expect(html).toContain("Ideation");
  expect(html).not.toContain("state-chip");
  expect(html).toContain("Actions");
});
