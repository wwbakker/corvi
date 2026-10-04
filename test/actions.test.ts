import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  actionFiles,
  deleteActionFile,
  deleteRepositoryActionFile,
  repositoryActionFiles,
  writeActionFile,
  writeRepositoryActionFile,
} from "../apps/server/src/actions/server/files.ts";
import { listActionsFor } from "../apps/server/src/actions/server/run.ts";
import type { Change } from "@corvi/changes/record";
import { configPath, reloadConfig } from "../apps/server/src/workspace/server/index.ts";
import { checkoutsOf, runEffect, runSh, testTempDir } from "./helpers.ts";

/** The change the listing is asked about: its phase is what the filter reads. */
const changeWith = (over: Partial<Change> = {}): Change => ({
  id: "PROJ-actions",
  branch: "PROJ-actions",
  checkouts: checkoutsOf([]),
  state: "Implementation",
  createdAt: new Date().toISOString(),
  ...over,
});

/** These tests write a config file and action files where `configPath()` points — which is the
 * ambient `CORVI_CONFIG`, and outside the wrapper (a focused `bun test`) that is the user's own
 * `~/.config/corvi/config.json`. So the env is pointed at this run's own directory first, before
 * anything reads it: config tests never touch the real config. */
const own = await testTempDir("actions");
process.env.CORVI_CONFIG = join(own, "config.json");
await mkdir(join(own, "actions"), { recursive: true });
await writeFile(configPath(), "{}");

/** The smallest file that parses: a label and what it delivers. */
const sayHello = "---\nlabel: Say hello\nkind: prompt\ntarget: active\n---\necho hello\n";

test("the page lists the shipped actions and the workspaces that can hold files", async () => {
  const listing = await runEffect(actionFiles());
  const brief = listing.files.find((f) => f.id === "brief");
  expect(brief?.scope).toBe("builtin");
  expect(brief?.label).toBe("Send PLAN.md instructions");
  expect(brief?.problems).toBeUndefined();
  expect(listing.workspaces.length).toBeGreaterThan(0); // the default workspace stands in
});

test("a written file is listed with its label; one that is not an action is refused with reasons", async () => {
  const after = await runEffect(
    writeActionFile({ scope: "global", id: "say-hello", text: sayHello }),
  );
  const found = after.files.find((f) => f.id === "say-hello");
  expect(found?.label).toBe("Say hello");
  expect(found?.scope).toBe("global");
  // The list is read from disk, not from memory.
  expect(await readFile(join(dirname(configPath()), "actions", "say-hello.md"), "utf8")).toBe(
    sayHello,
  );

  await expect(
    runEffect(
      writeActionFile({ scope: "global", id: "broken", text: "---\nkind: command\n---\nrm -rf\n" }),
    ),
  ).rejects.toThrow("label: required");
  const listing = await runEffect(actionFiles());
  expect(listing.files.find((f) => f.id === "broken")).toBeUndefined();

  const gone = await runEffect(deleteActionFile({ scope: "global", id: "say-hello" }));
  expect(gone.files.find((f) => f.id === "say-hello")).toBeUndefined();
});

test("ids and scopes are policed", async () => {
  await expect(
    runEffect(writeActionFile({ scope: "global", id: "../evil", text: sayHello })),
  ).rejects.toThrow("not a file name Corvi can use");
  await expect(
    runEffect(writeActionFile({ scope: "workspace", workspace: "no-such", id: "x", text: sayHello })),
  ).rejects.toThrow("no such workspace");
});

test("an action that names its phases is offered only in them", async () => {
  await runEffect(
    writeActionFile({
      scope: "global",
      id: "only-ideation",
      text: "---\nlabel: Shape the plan\nkind: prompt\ntarget: agent\nphases: [Ideation]\n---\nhello\n",
    }),
  );
  const labels = async (state: Change["state"]): Promise<string[]> =>
    (await runEffect(listActionsFor(changeWith({ state })))).map((a) => a.label);

  // In its phase it is offered, and so is the shipped brief (whose only phase this is).
  expect(await labels("Ideation")).toContain("Shape the plan");
  expect(await labels("Ideation")).toContain("Send PLAN.md instructions");
  // Outside it the phase filter hides both, while an action without phases is offered anywhere.
  expect(await labels("Implementation")).not.toContain("Shape the plan");
  expect(await labels("Implementation")).not.toContain("Send PLAN.md instructions");
  expect(await labels("Implementation")).toContain("New pi session");

  await runEffect(deleteActionFile({ scope: "global", id: "only-ideation" }));
});

test("the built-in brief shows the text that runs, and a shadowing brief.md replaces it", async () => {
  // The legacy `ideationPrompt` overrides the shipped body while no file shadows it — so the
  // page shows what is actually sent, and saving that to Global preserves it.
  await writeFile(configPath(), JSON.stringify({ ideationPrompt: "legacy briefing {id}" }));
  await runEffect(reloadConfig);
  const withLegacy = await runEffect(actionFiles());
  expect(withLegacy.files.find((f) => f.id === "brief")?.text).toContain("legacy briefing {id}");

  const shadowed = await runEffect(
    writeActionFile({
      scope: "global",
      id: "brief",
      text: "---\nlabel: Mine\nkind: prompt\ntarget: agent\n---\nmy briefing\n",
    }),
  );
  // Each file stays in its own section; the shadow is the global one, and the built-in no longer
  // shows the legacy override — nothing overrides what a file of yours runs.
  const mine = shadowed.files.find((f) => f.id === "brief" && f.scope === "global");
  expect(mine?.text).toContain("my briefing");
  const shipped = shadowed.files.find((f) => f.id === "brief" && f.scope === "builtin");
  expect(shipped?.text).not.toContain("legacy briefing {id}");

  // Deleting the shadow brings the chain back — and the page shows the running text again.
  const restored = await runEffect(deleteActionFile({ scope: "global", id: "brief" }));
  expect(
    restored.files.find((f) => f.id === "brief" && f.scope === "builtin")?.text,
  ).toContain("legacy briefing {id}");

  await writeFile(configPath(), "{}");
  await runEffect(reloadConfig);
});

/** A real checkout, as the repository scope needs one: `checkoutFor` resolves the worktree on
 * the change's own branch, and a committed `git init -b <branch>` repo is its own worktree. */
const repoFixture = async (name: string, branch: string): Promise<string> => {
  const dir = join(own, name);
  await runSh(["git", "init", "-b", branch, dir]);
  await writeFile(join(dir, "README.md"), "hi\n");
  await runSh(["git", "add", "."], dir);
  await runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], dir);
  return dir;
};

test("a repository action is listed, written and deleted through its checkout", async () => {
  const repo = await repoFixture("repo-actions", "PROJ-repo-actions");
  const change = changeWith({ branch: "PROJ-repo-actions", checkouts: checkoutsOf([repo]) });
  // The checkout's own files are listed under the repository's name — problems and all.
  await mkdir(join(repo, ".corvi", "actions"), { recursive: true });
  await writeFile(join(repo, ".corvi", "actions", "broken.md"), "---\nkind: command\n---\nrm -rf\n");
  const before = await runEffect(repositoryActionFiles(change));
  expect(before.repositories.map((one) => one.repository)).toEqual([basename(repo)]);
  expect(before.repositories[0]?.files.find((f) => f.id === "broken")?.problems).toBeDefined();

  const written = await runEffect(
    writeRepositoryActionFile(change, { repository: basename(repo), id: "say-hello", text: sayHello }),
  );
  expect(written.repositories[0]?.files.find((f) => f.id === "say-hello")?.label).toBe("Say hello");

  const gone = await runEffect(
    deleteRepositoryActionFile(change, { repository: basename(repo), id: "say-hello" }),
  );
  expect(gone.repositories[0]?.files.find((f) => f.id === "say-hello")).toBeUndefined();
});

test("a repository the change does not carry is refused rather than invented", async () => {
  await expect(
    runEffect(writeRepositoryActionFile(changeWith(), { repository: "nope", id: "x", text: sayHello })),
  ).rejects.toThrow(/no such repository/);
});
