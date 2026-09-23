import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChange, readChange, changeDir } from "../apps/server/src/change/server/index.ts";
import { provisionRepo, checkoutFor } from "../apps/server/src/vendors/git.ts";
import { Effect } from "effect";
import { runCancel, runEffect, runSh, TestError } from "./helpers.ts";
import { cancelChange } from "../apps/server/src/change/server/index.ts";
import type { Result } from "../apps/server/src/capabilities/shell.ts";
import { byWorkOrder, isFinished, CHANGE_STATES, type Change } from "../apps/server/src/domain/change.ts";

/**
 * Cancelling is the other way a change ends, and the one with no undo button on the far side: it
 * removes the worktrees. So the two things worth pinning down are that it refuses when work would
 * be lost, and that it leaves alone everything anyone else can see.
 */
let tmp: string;

const commit = (repo: string, message: string): Promise<Result> =>
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
  tmp = await realpath(await mkdtemp(join(tmpdir(), "corvi-cancel-")));
  process.env.CORVI_ROOT = join(tmp, "changes");
  process.env.CORVI_ARCHIVE_ROOT = join(tmp, "changes-archive");
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

test("the order the lists show changes in", () => {
  const at = (id: string, state: Change["state"], createdAt: string): Change => ({
    id,
    branch: id,
    repos: [],
    state,
    createdAt,
  });
  // The lifecycle: an idea first, then what you can get on with, then what is with somebody
  // else, then what is stuck.
  const sorted = [
    at("stuck", "Blocked", "2026-01-05T00:00:00Z"),
    at("older", "In Progress", "2026-01-01T00:00:00Z"),
    at("idea", "Ideation", "2026-01-02T00:00:00Z"),
    at("review", "Awaiting Review", "2026-01-04T00:00:00Z"),
    at("newer", "In Progress", "2026-01-03T00:00:00Z"),
  ]
    .sort(byWorkOrder)
    .map((c) => c.id);
  expect(sorted).toEqual(["idea", "newer", "older", "review", "stuck"]);

  // A change with no state is one you are working on.
  expect([at("none", undefined, "2026-01-09T00:00:00Z"), at("b", "Blocked", "2026-01-09T00:00:00Z")]
    .sort(byWorkOrder)
    .map((c) => c.id)).toEqual(["none", "b"]);

  // The select offers them in the same order the lists sort by: one order, used twice.
  expect(CHANGE_STATES.slice(0, 3)).toEqual(["Ideation", "In Progress", "Awaiting Review"]);
});

test("a change is over when it was completed or cancelled", () => {
  const base = { id: "x", branch: "x", repos: [], createdAt: "2026-01-01T00:00:00Z" };
  expect(isFinished({ ...base, state: "In Progress" })).toBe(false);
  expect(isFinished({ ...base, state: "Blocked" })).toBe(false);
  expect(isFinished({ ...base, state: "Completed" })).toBe(true);
  expect(isFinished({ ...base, state: "Cancelled" })).toBe(true);
  // The fact, whatever the state says: finishing a change is what sets this.
  expect(isFinished({ ...base, completedAt: "2026-02-02T00:00:00Z" })).toBe(true);
});

test("cancelling takes back the worktree and leaves the branch", async () => {
  const repo = await clonedRepo("cancel-plain");
  const change = await runEffect(createChange({ id: "PROJ-CANCEL", branch: "PROJ-CANCEL-x", repos: [repo] }));
  // The same checkouts the git extension's change:created hook creates.
  await Effect.runPromise(Effect.forEach(change.repos, (repo) => provisionRepo(change, repo), { concurrency: 1 }));
  expect(await runEffect(checkoutFor(change, repo))).toBeDefined();

  const result = await runCancel(change);
  expect("change" in result).toBe(true);
  const cancelled = (result as { change: Change }).change;

  expect(cancelled.state).toBe("Cancelled");
  expect(cancelled.completedAt).toBeDefined();
  expect(isFinished(cancelled)).toBe(true);
  expect(await runEffect(checkoutFor(cancelled, repo))).toBeUndefined();
  // Archived, and still readable: what was abandoned is worth being able to look up.
  expect(await Bun.file(join(changeDir("PROJ-CANCEL"), "change.json")).exists()).toBe(false);
  expect((await runEffect(readChange("PROJ-CANCEL")))?.state).toBe("Cancelled");

  // Nothing was committed on it, so the branch had nothing to add and went with the worktree —
  // and the report says so rather than claiming a branch is waiting for you that is not.
  expect((await runSh(["git", "branch", "--list", "PROJ-CANCEL-x"], repo)).stdout).toBe("");
  expect((result as { loose: string[] }).loose.some((l) => l.includes("branch"))).toBe(false);
});

test("what would be lost stops it, and what is recoverable asks first", async () => {
  const repo = await clonedRepo("cancel-work");
  const change = await runEffect(createChange({ id: "PROJ-WORK", branch: "PROJ-WORK-x", repos: [repo] }));
  // The same checkouts the git extension's change:created hook creates.
  await Effect.runPromise(Effect.forEach(change.repos, (repo) => provisionRepo(change, repo), { concurrency: 1 }));
  const worktree = (await runEffect(checkoutFor(change, repo)))!;

  // Uncommitted: nowhere else, and no question makes it recoverable.
  await Bun.write(join(worktree, "wip.txt"), "not committed\n");
  expect(runCancel(change)).rejects.toThrow(/uncommitted changes/);
  expect(runCancel(change, true)).rejects.toThrow(/uncommitted changes/);
  expect(await runEffect(checkoutFor(change, repo))).toBeDefined();

  // Committed but never pushed: recoverable from the branch, which cancelling keeps — so this
  // is a question rather than a refusal.
  await runSh(["git", "add", "."], worktree);
  await commit(worktree, "work nobody else has");
  const asked = await runCancel(change);
  expect(asked).toEqual({ needsForce: ["cancel-work"] });
  expect(await runEffect(checkoutFor(change, repo))).toBeDefined();

  const forced = await runCancel(change, true);
  expect("change" in forced).toBe(true);
  expect(await runEffect(checkoutFor(change, repo))).toBeUndefined();
  expect((await runSh(["git", "log", "-1", "--format=%s", "PROJ-WORK-x"], repo)).stdout).toBe(
    "work nobody else has",
  );
  // And that is a loose end: the commits are only on that branch now.
  expect((forced as { loose: string[] }).loose).toContain("the branch PROJ-WORK-x is kept in cancel-work");
});

test("a change cannot be declared finished by hand", async () => {
  // The select offers the states you are in; this is where that is true rather than merely
  // displayed. Picking "Completed" from a list would set the word without merging anything,
  // removing a worktree or archiving the change.
  const { applyPatch } = await import("../apps/server/src/change/server/index.ts");
  const change = await runEffect(createChange({
    id: "PROJ-HAND",
    branch: "PROJ-HAND-x",
    repos: [await clonedRepo("cancel-byhand")],
  }));

  expect(() => applyPatch(change, { state: "Completed" })).toThrow(/completing or cancelling/);
  expect(() => applyPatch(change, { state: "Cancelled" })).toThrow(/completing or cancelling/);
  expect(() => applyPatch(change, { state: "Nonsense" })).toThrow(/unknown state/);
  // Ideation is the other end of the same rule: set by creating an idea, left by starting work.
  expect(() => applyPatch(change, { state: "Ideation" })).toThrow(/start work/);

  // The states you work in are still yours to set, and so is the name.
  expect(applyPatch(change, { state: "Blocked" }).state).toBe("Blocked");
  expect(applyPatch(change, { title: "Something I called it" })).toMatchObject({
    title: "Something I called it",
    titleEdited: true,
  });
  // Cleared: the ticket may name it again.
  expect(applyPatch(change, { title: "  " }).titleEdited).toBeUndefined();

  // And a change that has ended keeps its state: this is about how it gets there.
  const over = { ...change, state: "Cancelled" as const, completedAt: "2026-01-01T00:00:00Z" };
  expect(applyPatch(over, { title: "renamed afterwards" }).state).toBe("Cancelled");
});

test("a change that is over is read, not acted on", async () => {
  const { repoStatusOf, cardForExtension } = await import("../apps/server/src/integrations/index.ts");
  const repo = await clonedRepo("cancel-readonly");
  // Not provisioned: a repository with no worktree is exactly the row that offers to make one.
  const change = await runEffect(createChange({ id: "PROJ-OVER", branch: "PROJ-OVER-x", repos: [repo] }));

  const git = cardForExtension("git")!;
  const live = await runEffect(repoStatusOf("git", git, change, repo));
  expect(live.flatMap((i) => i.actions ?? []).map((a) => a.label)).toContain("Create worktree");

  const cancelled = ((await runCancel(change)) as { change: Change }).change;
  const after = await runEffect(repoStatusOf("git", git, cancelled, repo));

  // The row stays — what the change touched is worth reading afterwards — but offering to make
  // a worktree for an archived change is offering to half-revive something that is finished.
  expect(after.length).toBe(live.length);
  expect(after.flatMap((i) => i.actions ?? [])).toEqual([]);
});

test("what cancelling leaves alone is said out loud", async () => {
  const repo = await clonedRepo("cancel-loose");
  const change = await runEffect(createChange({
    id: "PROJ-LOOSE",
    branch: "PROJ-LOOSE-x",
    repos: [repo],
    extensions: { jira: { key: "PROJ-LOOSE" } },
  }));
  // The same checkouts the git extension's change:created hook creates.
  await Effect.runPromise(Effect.forEach(change.repos, (repo) => provisionRepo(change, repo), { concurrency: 1 }));

  const result = (await runCancel(change)) as { loose: string[] };
  // The ticket and the branch: a cancelled change that quietly leaves those behind comes back in
  // a week as somebody else's question. (No pull request here: there is no GitHub remote.) The
  // loose ends are gathered from the extensions in load order, so ci's pull-request lines would
  // precede jira's ticket line.
  expect(result.loose).toContain("PROJ-LOOSE is still open in Jira");
});
