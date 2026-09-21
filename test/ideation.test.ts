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
  ideationPromptFor,
  readChange,
  readSidecar,
  startChangeWithWorkflow,
  writeSidecar,
} from "../src/change/server/index.ts";
import { provisionChangeRepositories } from "../src/change/provisioning.ts";
import { checkoutFor } from "../src/vendors/git.ts";
import { isIdeation, slugFor } from "../src/domain/change.ts";
import type { Change } from "../src/domain/change.ts";
import { runCancel, runEffect, runSetRepos, runSh } from "./helpers.ts";
import type { Result } from "../src/capabilities/shell.ts";

/**
 * The ideation stage: an idea is created with a title and a plan and nothing else — no branch,
 * no worktree, no ticket transition — and starting it is the real transition that provisions
 * the work. These pin the create/start split and the git hook that distinguishes them.
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
  expect(idea.repos).toEqual([]);
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
  expect(started.change.state).toBe("In Progress");
  expect((await runEffect(readChange("idea-start")))?.state).toBe("In Progress");
  // Starting twice would claim work that already happened (and provision a second time).
  await expect(runEffect(startChangeWithWorkflow(started.change))).rejects.toThrow(
    /already started/,
  );
});

test("a change created ready to work still needs a repository", async () => {
  await expect(runEffect(createChange({ id: "no-repos" }))).rejects.toThrow(
    "at least one repository",
  );
  // A finished state is not something you create into; only Ideation and In Progress are.
  await expect(
    runEffect(createChange({ id: "already-done", state: "Completed" })),
  ).rejects.toThrow(/Ideation or In Progress/);
});

test("an idea browses its repositories, and starting creates the checkout", async () => {
  const repo = await clonedRepo("ideation-repo");
  const idea = await runEffect(
    createChange({
      id: "idea-browse",
      title: "Browse the code",
      state: "Ideation",
      repos: [repo],
    }),
  );

  // Creating an idea links the repository for reading — no branch switch, no worktree.
  await runEffect(provisionChangeRepositories(idea));
  const link = join(changeDir(idea.id), basename(repo));
  expect((await lstat(link)).isSymbolicLink()).toBe(true);
  expect(await runEffect(checkoutFor(idea, repo))).toBeUndefined();
  expect((await runSh(["git", "rev-parse", "--abbrev-ref", "HEAD"], repo)).stdout).toBe("main");

  // Starting replaces the link with the checkout the change asked for.
  const started = await runEffect(startChangeWithWorkflow(idea));
  expect(await runEffect(checkoutFor(started.change, repo))).toBeDefined();
  // The path is the same; a real worktree now, not a symlink.
  expect((await lstat(link)).isDirectory()).toBe(true);
});

test("the briefing names the change, its state and its plan", () => {
  const idea: Change = {
    id: "idea-prompt",
    branch: "idea-prompt",
    repos: [],
    title: "Prompt Me",
    state: "Ideation",
    createdAt: "2026-01-01T00:00:00Z",
  };
  const prompt = ideationPromptFor(idea);
  expect(prompt).toContain("Prompt Me");
  expect(prompt).toContain("idea-prompt");
  expect(prompt).toContain(join(changeDir("idea-prompt"), PLAN_FILE));
  expect(prompt).toContain("Ideation");
  // A change with no title falls back to its id rather than leaving a hole in the prompt.
  expect(ideationPromptFor({ ...idea, title: undefined })).toContain("idea-prompt");
});

test("cancelling an idea drops its browse links", async () => {
  const repo = await clonedRepo("ideation-cancel");
  const idea = await runEffect(
    createChange({ id: "idea-cancel", state: "Ideation", repos: [repo] }),
  );
  await runEffect(provisionChangeRepositories(idea));
  expect((await lstat(join(changeDir(idea.id), basename(repo)))).isSymbolicLink()).toBe(true);

  const cancelled = await runCancel(idea);
  expect("change" in cancelled && cancelled.change.state).toBe("Cancelled");
  // The archived directory keeps no dangling symlink: the link went with the repository.
  const archived = await lstat(join(archiveDir(idea.id), basename(repo))).then(
    () => true,
    () => false,
  );
  expect(archived).toBe(false);
});

test("adding a repository to an idea links it rather than cutting a branch", async () => {
  const repo = await clonedRepo("ideation-add");
  const idea = await runEffect(createChange({ id: "idea-add", state: "Ideation" }));

  const updated = await runSetRepos(idea, [repo]);
  expect("change" in updated).toBe(true);
  const change = (updated as { change: Change }).change;

  // A link for reading, no registered worktree, and the repository's own checkout untouched.
  expect((await lstat(join(changeDir(change.id), basename(repo)))).isSymbolicLink()).toBe(true);
  expect(await runEffect(checkoutFor(change, repo))).toBeUndefined();
  expect((await runSh(["git", "rev-parse", "--abbrev-ref", "HEAD"], repo)).stdout).toBe("main");
});

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
