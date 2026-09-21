import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { Effect } from "effect";
import { createChange, archiveChange, changeDir, readChange } from "../src/change/server/index.ts";
import { provisionRepo, checkoutFor } from "../src/vendors/git.ts";
import { dispatchIntegrationRoute } from "../src/integrations/index.ts";
import type { Leftover } from "../src/extensions/leftovers/shared.ts";
import { runEffect, runSh } from "./helpers.ts";

/**
 * The leftovers extension, through the dispatcher the server uses: `/api/ext/leftovers/…` is
 * the only door to it now, so the list and the guarded removal are exercised here rather than
 * against the change module's barrel.
 */

let tmp: string;
let repo: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "corvi-leftovers-"));
  process.env.CORVI_ROOT = join(tmp, "changes");
  process.env.CORVI_ARCHIVE_ROOT = join(tmp, "changes-archive");
  repo = join(tmp, "myrepo");
  await runSh(["git", "init", "-b", "main", repo]);
  await Bun.write(join(repo, "README.md"), "hi\n");
  await runSh(["git", "add", "."], repo);
  await runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], repo);
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** The page's read, through the dispatcher; the request is the one the client makes. */
const list = async (): Promise<Leftover[]> => {
  const response = (await dispatchIntegrationRoute(
    new Request("http://localhost/api/ext/leftovers/list"),
  ))!;
  return (await response.json()) as Leftover[];
};

/** The page's delete, through the dispatcher; the route's response is returned as it is. */
const remove = (name: string): Promise<Response> =>
  dispatchIntegrationRoute(
    new Request(`http://localhost/api/ext/leftovers/list/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),
  )!;

test("the extension lists directories left by finished changes, and only those", async () => {
  const active = await runEffect(createChange({ id: "PROJ-ALIVE", repos: [repo] }));

  // A change that was completed: change.json moved to the archive, the directory stayed.
  const done = await runEffect(createChange({ id: "PROJ-DONE", repos: [repo] }));
  await runEffect(archiveChange(done.id));
  await Bun.write(join(changeDir(done.id), "target", "build.jar"), "artifact\n");

  const leftovers = await list();
  const names = leftovers.map((l) => l.name);
  expect(names).toContain("PROJ-DONE");
  expect(names).not.toContain(active.id); // an active change is not litter
  expect(names).not.toContain("archive"); // the archive lives in its own root, not here
  expect(leftovers.find((l) => l.name === "PROJ-DONE")?.entries).toEqual([
    { name: "target", directory: true },
  ]);

  // Deleting refuses a change that is still live: the BadRequestError the route maps to a 400.
  expect((await remove(active.id)).status).toBe(400);

  // Deleting one takes the directory with it and answers with the list as it is now.
  const after = await remove("PROJ-DONE");
  expect(after.status).toBe(200);
  const remaining = (await after.json()) as Leftover[];
  expect(remaining.map((l) => l.name)).not.toContain("PROJ-DONE");
  expect(await Bun.file(join(changeDir("PROJ-DONE"), "target", "build.jar")).exists()).toBe(false);
  expect((await list()).map((l) => l.name)).not.toContain("PROJ-DONE");
  // The archived change itself is untouched: only the leftover directory went.
  expect(await runEffect(readChange("PROJ-DONE"))).toMatchObject({ id: "PROJ-DONE" });
});

test("deleting a leftover with a worktree in it prunes the repository afterwards", async () => {
  const change = await runEffect(createChange({ id: "PROJ-WT-LEFT", branch: "PROJ-WT-LEFT-x", repos: [repo] }));
  // The same checkouts the git extension's change:created hook creates.
  await Effect.runPromise(Effect.forEach(change.repos, (r) => provisionRepo(change, r), { concurrency: 1 }));
  // Resolved: the temporary directory is a symlink on macOS, and git reports where it lands.
  const worktree = (await runEffect(checkoutFor(change, repo)))!;
  expect(worktree).toBe(await realpath(join(changeDir(change.id), basename(repo))));

  // A change whose record is gone while its worktree is not: an interrupted creation, or a
  // change.json lost by hand. Completing removes worktrees first, so it cannot happen that way.
  await rm(join(changeDir(change.id), "change.json"));
  const listed = (await list()).find((l) => l.name === change.id)!;
  // Shown as what it is, so the warning before deleting can say so.
  expect(listed.entries).toContainEqual({ name: basename(repo), directory: true, git: "worktree" });

  expect((await remove(change.id)).status).toBe(200);
  // git forgets the worktree as well: a stale registration would block reusing the path.
  const registered = await runSh(["git", "worktree", "list"], repo);
  expect(registered.stdout).not.toContain(worktree);
});
