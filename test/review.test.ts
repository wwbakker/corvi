import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChange } from "../src/change/server/index.ts";
import { checkoutFor } from "../src/vendors/git.ts";
import { changeTabsFor, dispatchExtensionRoute, provision } from "../src/extension-host/index.ts";
import { resolveChangePage } from "../src/change-page/client/changeTabs.ts";
import type { Workspace } from "../src/workspace/server/index.ts";
import type { Change } from "../src/domain/change.ts";
import type { CommitResult, LocalStatus } from "../src/extensions/review/shared.ts";
import { runEffect, runSh } from "./helpers.ts";
import type { Result } from "../src/capabilities/shell.ts";

/**
 * The review extension on the change-tab contract (E3): its tab exists exactly when the
 * extension does, and its routes — mounted under `/api/ext/review/` — do the git work the core
 * used to. Committing and pushing go through the real dispatcher, so the route shape, the
 * workspace resolution and the status-code mapping are all exercised as the app uses them.
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

const changeFor = async (id: string, repos: string[]): Promise<Change> =>
  runEffect(createChange({ id, branch: `${id}-work`, repos }));

/** Call the extension's own namespace (the path after `/api/ext/review/`), as the page does. */
const ext = async (
  path: string,
  method = "GET",
  body?: unknown,
): Promise<Response> => {
  const response = dispatchExtensionRoute(
    new Request(`http://localhost/api/ext/review/${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    }),
  );
  if (!response) throw new Error(`no route: ${method} ${path}`);
  return response;
};

const ws = (patch: Partial<Workspace> = {}): Workspace => ({ id: "test", name: "Test", ...patch });

beforeAll(async () => {
  // Resolved: on macOS the temporary directory is a symlink, and git reports where it lands.
  tmp = await realpath(await mkdtemp(join(tmpdir(), "iwe-review-")));
  process.env.IWE_ROOT = join(tmp, "changes");
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

test("the review tab is offered only when the extension is enabled, and its URL otherwise falls back", () => {
  const enabled = changeTabsFor(ws({ extensions: ["review"] }));
  expect(enabled).toEqual([{ id: "review", title: "Review changes", extension: "review" }]);
  expect(resolveChangePage("review", enabled)).toEqual({ kind: "tab", tab: enabled[0]! });

  // A workspace that dropped review has no tab for it, and /changes/:id/review is the dashboard,
  // not a blank page.
  const disabled = changeTabsFor(ws({ extensions: [] }));
  expect(disabled).toEqual([]);
  expect(resolveChangePage("review", disabled)).toEqual({ kind: "dashboard" });
});

test("the extension's local route answers for a repository of a change, and 404s an unknown one", async () => {
  const repo = await clonedRepo("local");
  const change = await changeFor("PROJ-REVIEW-LOCAL", [repo]);
  await runEffect(provision(change));
  const worktree = (await runEffect(checkoutFor(change, repo)))!;
  await Bun.write(join(worktree, "added.txt"), "staged\n");
  await runSh(["git", "add", "added.txt"], worktree);

  const response = await ext(`changes/${change.id}/local?path=${encodeURIComponent(repo)}`);
  expect(response.status).toBe(200);
  const status = (await response.json()) as LocalStatus;
  expect(status.files.map((f) => f.path)).toEqual(["added.txt"]);
  expect(status.files[0]).toMatchObject({ staged: true });

  // The change is found through the Changes capability; one that does not exist is a 404.
  const missing = await ext(`changes/PROJ-NOPE/local?path=${encodeURIComponent(repo)}`);
  expect(missing.status).toBe(404);
  expect((await missing.json() as { error: string }).error).toMatch(/no such change/);

  // A missing query parameter is the caller's mistake, exactly as the core route said it.
  const noPath = await ext(`changes/${change.id}/local`);
  expect(noPath.status).toBe(400);
});

test("committing takes the files you ticked, in every repository at once", async () => {
  const a = await clonedRepo("commit-a");
  const b = await clonedRepo("commit-b");
  const change = await changeFor("PROJ-COMMIT", [a, b]);
  await runEffect(provision(change));
  const wtA = (await runEffect(checkoutFor(change, a)))!;
  const wtB = (await runEffect(checkoutFor(change, b)))!;

  await Bun.write(join(wtA, "README.md"), "edited\n");
  await Bun.write(join(wtA, "new.txt"), "untracked\n"); // never seen by git before
  await Bun.write(join(wtA, "later.txt"), "not this time\n");
  await Bun.write(join(wtB, "README.md"), "also edited\n");

  // One message, one commit per repository: a change is one piece of work.
  const response = await ext(`changes/${change.id}/commit`, "POST", {
    message: "PROJ-1 do the thing",
    files: { [a]: ["README.md", "new.txt"], [b]: ["README.md"] },
  });
  expect(response.status).toBe(200);
  const results = (await response.json()) as CommitResult[];
  expect(results.every((r) => r.ok)).toBe(true);
  expect(results.map((r) => r.name).sort()).toEqual(["commit-a", "commit-b"]);
  expect(results[0]!.hash).toMatch(/^[0-9a-f]{7,}$/);

  const subject = async (repo: string): Promise<string> =>
    (await runSh(["git", "log", "-1", "--pretty=%s"], repo)).stdout;
  expect(await subject(wtA)).toBe("PROJ-1 do the thing");
  expect(await subject(wtB)).toBe("PROJ-1 do the thing");

  // What was not ticked is still uncommitted, and nothing else was swept in.
  const left = (await (
    await ext(`changes/${change.id}/local?path=${encodeURIComponent(a)}`)
  ).json()) as LocalStatus;
  expect(left.files.map((f) => f.path)).toEqual(["later.txt"]);

  // A message is not optional, and neither is a file.
  const noMessage = await ext(`changes/${change.id}/commit`, "POST", {
    message: "  ",
    files: { [a]: ["later.txt"] },
  });
  expect(noMessage.status).toBe(400);
  expect((await noMessage.json() as { error: string }).error).toMatch(/needs a message/);

  const noFiles = await ext(`changes/${change.id}/commit`, "POST", { message: "x", files: { [a]: [] } });
  expect(noFiles.status).toBe(400);
  expect((await noFiles.json() as { error: string }).error).toMatch(/select at least one file/);
});

test("a repository that refuses to commit does not stop the others", async () => {
  const good = await clonedRepo("commit-good");
  const change = await changeFor("PROJ-PARTIAL", [good]);
  await runEffect(provision(change));
  await Bun.write(join((await runEffect(checkoutFor(change, good)))!, "README.md"), "edited\n");

  // A repository of this change without a worktree: it says so, the other one still commits.
  const response = await ext(`changes/${change.id}/commit`, "POST", {
    message: "PROJ-1 do the thing",
    files: { [good]: ["README.md"], "/nowhere/at/all": ["README.md"] },
  });
  expect(response.status).toBe(200);
  const results = (await response.json()) as CommitResult[];
  expect(results.find((r) => r.repo === good)?.ok).toBe(true);
  expect(results.find((r) => r.repo === "/nowhere/at/all")).toMatchObject({
    ok: false,
    error: "no worktree",
  });
});

test("what is committed but only here is counted, and pushing takes it away", async () => {
  const repo = await clonedRepo("push");
  const change = await changeFor("PROJ-PUSH", [repo]);
  await runEffect(provision(change));
  const wt = (await runEffect(checkoutFor(change, repo)))!;

  // A branch that was never pushed has no upstream, so "ahead" says nothing: everything since
  // it left the base branch is unpushed, and that is what the button has to offer.
  await Bun.write(join(wt, "one.txt"), "1\n");
  await runSh(["git", "add", "."], wt);
  await commit(wt, "first");
  const before = (await (
    await ext(`changes/${change.id}/local?path=${encodeURIComponent(repo)}`)
  ).json()) as LocalStatus;
  expect(before).toMatchObject({ tracked: false, unpushed: 1 });

  const pushed = await ext(`changes/${change.id}/push`, "POST", { repos: [repo] });
  expect(pushed.status).toBe(200);
  expect(((await pushed.json()) as CommitResult[]).every((r) => r.ok)).toBe(true);
  const after = (await (
    await ext(`changes/${change.id}/local?path=${encodeURIComponent(repo)}`)
  ).json()) as LocalStatus;
  // Now it has an upstream, and nothing is ahead of it.
  expect(after).toMatchObject({ tracked: true, unpushed: 0 });

  // A second commit is one ahead, which is the other way of counting the same thing.
  await Bun.write(join(wt, "two.txt"), "2\n");
  await runSh(["git", "add", "."], wt);
  await commit(wt, "second");
  const again = (await (
    await ext(`changes/${change.id}/local?path=${encodeURIComponent(repo)}`)
  ).json()) as LocalStatus;
  expect(again).toMatchObject({ tracked: true, unpushed: 1 });
  await ext(`changes/${change.id}/push`, "POST", { repos: [repo] });
  const final = (await (
    await ext(`changes/${change.id}/local?path=${encodeURIComponent(repo)}`)
  ).json()) as LocalStatus;
  expect(final.unpushed).toBe(0);

  // And a repository that is not there says so instead of stopping the push.
  const bad = await ext(`changes/${change.id}/push`, "POST", { repos: ["/nowhere/at/all"] });
  expect(((await bad.json()) as CommitResult[])[0]).toMatchObject({ ok: false, error: "no worktree" });
  const none = await ext(`changes/${change.id}/push`, "POST", { repos: [] });
  expect(none.status).toBe(400);
  expect((await none.json() as { error: string }).error).toMatch(/nothing to push/);
});

test("a repository's line says what is uncommitted and what is only here", async () => {
  const { summarise } = await import("../src/extensions/review/LocalPane.tsx");
  const status = (files: unknown[], unpushed = 0): LocalStatus => ({
    repo: "/r",
    name: "r",
    files: files as never[],
    unpushed,
    tracked: true,
  });

  // "Nothing here" is an answer, and gets a heading of its own rather than being left out.
  expect(summarise(status([]))).toEqual({ text: "clean", state: "ok" });
  expect(summarise(status([1]))).toEqual({ text: "1 change", state: "pending" });
  expect(summarise(status([1, 2]))).toEqual({ text: "2 changes", state: "pending" });

  // A clean repository with commits nobody else has looks finished and is not.
  expect(summarise(status([], 3))).toEqual({ text: "3 unpushed", state: "pending" });
  expect(summarise(status([1], 2))).toEqual({ text: "1 change, 2 unpushed", state: "pending" });

  expect(summarise({ ...status([]), error: "no worktree" })).toEqual({
    text: "no worktree",
    state: "error",
  });
  // Not asked yet is not the same as clean.
  expect(summarise(undefined)).toEqual({ text: "…", state: "none" });
});
