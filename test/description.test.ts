import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describeChange, prDescription } from "../src/change/server/index.ts";
import type { Change } from "../src/core/domain/change.ts";
import { fakeShell, runWithShell, type FakeShell } from "./helpers.ts";

/**
 * The pull-request description is a heading the extensions compose, then one link per repository.
 * The joining is pure; the links come from each repository's pull request, and a repository with
 * none is named rather than dropped.
 */
let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "iwe-description-"));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const changeWith = (over: Partial<Change> = {}): Change => ({
  id: "PROJ-desc",
  branch: "PROJ-desc",
  repos: [],
  state: "In Progress",
  createdAt: new Date().toISOString(),
  ...over,
});

test("describeChange: heading parts join with a dash and each link is its own line", () => {
  expect(describeChange("PROJ-1", "Anonymize customers", ["https://x/1", "repo-without-pr"])).toBe(
    "PROJ-1 - Anonymize customers\nhttps://x/1\nrepo-without-pr\n",
  );

  // Either half of the heading alone still opens the description.
  expect(describeChange("PROJ-1", undefined, ["a"])).toBe("PROJ-1\na\n");
  expect(describeChange(undefined, "A summary", ["a"])).toBe("A summary\na\n");

  // No heading at all is an empty first line, not a missing one: the shape is stable.
  expect(describeChange(undefined, undefined, ["a"])).toBe("\na\n");
  // Empty strings are absent, not joined as blank heading parts.
  expect(describeChange("", "", ["a"])).toBe("\na\n");
  // No links: the heading, then an empty body.
  expect(describeChange("PROJ-1", "x", [])).toBe("PROJ-1 - x\n\n");
});

/** A worktree as `git worktree list --porcelain` reports it, for the change's branch. */
const worktreeAt = (path: string, branch: string): string =>
  `worktree ${path}\nHEAD ${"0".repeat(40)}\nbranch refs/heads/${branch}\n`;

/** A scripted shell for the per-repository pull-request lookup. */
const descriptionShell = (opts: {
  worktree?: string;
  branch?: string;
  pr?: Record<string, unknown> | null;
}): FakeShell =>
  fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line === "git worktree list --porcelain") {
      return opts.worktree ? worktreeAt(opts.worktree, opts.branch ?? "") : "";
    }
    if (line === "git status --porcelain=v2 --branch") return "";
    if (line === "git remote") return "";
    if (line.startsWith("git rev-parse --abbrev-ref --symbolic-full-name")) return "";
    if (line.startsWith("gh pr list")) return JSON.stringify(opts.pr ? [opts.pr] : []);
    // The review-thread query is a preview feature GitHub may refuse; an empty answer is fine.
    if (line.startsWith("gh api graphql")) return { code: 1, stderr: "no such field" };
    return undefined;
  });

test("prDescription: a repository without a pull request is named, not dropped", async () => {
  const repo = join(tmp, "without-pr");
  const change = changeWith({ id: "PROJ-desc-none", repos: [repo] });
  const shell = descriptionShell({ worktree: join(tmp, "wt-none"), branch: change.branch, pr: null });
  // No extension claims this change, so the heading is absent; the repository itself is the link.
  expect(await runWithShell(shell, prDescription(change))).toBe(`\n${basename(repo)}\n`);
});

test("prDescription: a repository with a pull request links to it", async () => {
  const repo = join(tmp, "with-pr");
  const change = changeWith({ id: "PROJ-desc-url", repos: [repo] });
  const shell = descriptionShell({
    worktree: join(tmp, "wt-url"),
    branch: change.branch,
    pr: {
      number: 12,
      title: "do the thing",
      url: "https://github.com/org/repo/pull/12",
      state: "OPEN",
      isDraft: false,
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      statusCheckRollup: [],
    },
  });
  expect(await runWithShell(shell, prDescription(change))).toBe(
    "\nhttps://github.com/org/repo/pull/12\n",
  );
});
