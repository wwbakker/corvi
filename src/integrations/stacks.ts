import { sh, json } from "../sh.ts";

/** Where a pull request sits in its stack, when it is in one. */
export type Stack = { number: number; size: number; position: number };

/** How a stack reads on the pull request row. */
export const describeStack = (stack: Stack): string =>
  `${stack.position} of ${stack.size} in stack #${stack.number}`;

/** GitHub's stacked pull requests are a preview feature, so the API version has to be asked for
 * by name. */
const STACKS_API = ["-H", "X-GitHub-Api-Version: 2026-03-10"];

/**
 * The call that puts a new pull request on top of the one below it: appended to that pull
 * request's stack when it already has one, otherwise a stack of the two of them.
 *
 * Pull requests are given bottom to top, and each one's base must be the previous one's head —
 * which is exactly how a change based on another change's branch is already set up.
 */
export function stackRequest(
  repo: string,
  below: number,
  number: number,
  stack?: number,
): string[] {
  return stack
    ? [`repos/${repo}/stacks/${stack}/add`, "-F", `pull_requests[]=${number}`]
    : [`repos/${repo}/stacks`, "-F", `pull_requests[]=${below}`, "-F", `pull_requests[]=${number}`];
}

/**
 * Tie a new pull request to the one it was branched off, as a GitHub stack: reviewers then see
 * the order of the work, and merging the bottom one moves the rest along.
 *
 * Best effort. The stack is a nicety on top of a pull request that already targets the right
 * branch, so a repository without the preview feature, or a base branch with no pull request of
 * its own, changes nothing else.
 */
export async function stackOnBase(worktree: string, baseBranch: string, number: number): Promise<void> {
  const repo = (await sh(["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], worktree)).stdout;
  const below = json<{ number: number }[]>(
    (await sh(["gh", "pr", "list", "--head", baseBranch, "--state", "open", "--json", "number", "--limit", "1"], worktree)).stdout,
    [],
  )[0]?.number;
  if (!repo || !below) return; // the branch below has no pull request: nothing to stack onto

  const stack = json<{ stack?: { number?: number } }>(
    (await sh(["gh", "api", `repos/${repo}/pulls/${below}`, ...STACKS_API], worktree)).stdout,
    {},
  ).stack?.number;
  const r = await sh(
    ["gh", "api", "-X", "POST", ...STACKS_API, ...stackRequest(repo, below, number, stack)],
    worktree,
  );
  if (r.code !== 0) console.warn(`could not stack #${number} onto #${below}: ${r.stderr.trim()}`);
}

/** What a merge request says about itself; the same object comes back from both endpoints. */
export type MergeResult = {
  status: "pending" | "merged" | "enqueued" | "failed";
  details?: { message?: string; uuid?: string; sha?: string };
};

/**
 * What to do with a merge result: keep waiting, stop happily, or fail with what GitHub said.
 * `enqueued` is an ending too — the stack went into the base branch's merge queue, and the queue
 * owns it from there.
 */
export function outcomeOf(result: MergeResult): { waiting: boolean; note?: string; error?: string } {
  switch (result.status) {
    case "pending":
      return { waiting: true };
    case "merged":
      return { waiting: false };
    case "enqueued":
      return { waiting: false, note: "added to the merge queue" };
    default:
      return { waiting: false, error: result.details?.message ?? "the merge failed" };
  }
}

/** A merge result read from a response, or nothing when the response was not one: a poll can
 * fail (the request expired, the network hiccuped) and that is not the same as "still running". */
export function pollResult(code: number, stdout: string): MergeResult | undefined {
  if (code !== 0) return undefined;
  const parsed = json<Partial<MergeResult>>(stdout, {});
  return parsed.status ? (parsed as MergeResult) : undefined;
}

/** Whether the pull request is merged, asked of the pull request itself. The merge request is a
 * report about the work; this is the work. */
async function merged(worktree: string, repository: string, number: number): Promise<boolean> {
  const r = await sh(["gh", "api", `repos/${repository}/pulls/${number}`, "-q", ".merged"], worktree);
  return r.stdout.trim() === "true";
}

/**
 * Merge a stacked pull request. A stack cannot go through the ordinary merge endpoint at all —
 * GitHub refuses and points here — because merging one pull request of a stack merges everything
 * below it too, which takes long enough that it runs in the background.
 *
 * Submit, then poll until it is no longer pending.
 */
export async function mergeStacked(
  worktree: string,
  repository: string,
  number: number,
  method = "squash",
): Promise<string | undefined> {
  const submit = await sh(
    [
      "gh",
      "api",
      "--method",
      "PUT",
      ...STACKS_API,
      `repos/${repository}/pulls/${number}/merge-async`,
      "-f",
      `merge_method=${method}`,
      // default: merge directly, or use the merge queue when the branch demands one.
      "-f",
      "merge_action=default",
    ],
    worktree,
  );
  // 409 means a merge request already exists; its uuid comes back all the same, so poll that one.
  const submitted = json<MergeResult>(submit.stdout, { status: "failed" });
  if (submit.code !== 0 && !submitted.details?.uuid) {
    throw new Error(`could not start the merge of #${number}: ${submit.stderr || submit.stdout}`);
  }

  let result = submitted;
  const uuid = submitted.details?.uuid;
  const deadline = Date.now() + 5 * 60_000;
  while (outcomeOf(result).waiting && uuid) {
    if (Date.now() > deadline) {
      // It may well have landed while we were failing to hear about it.
      if (await merged(worktree, repository, number)) return undefined;
      throw new Error(`the merge of #${number} is still running after 5m`);
    }
    await Bun.sleep(1000);
    const poll = await sh(
      ["gh", "api", ...STACKS_API, `repos/${repository}/pulls/${number}/merge-async/${uuid}`],
      worktree,
    );
    const read = pollResult(poll.code, poll.stdout);
    // A failed poll used to be read as "still pending", which turned any hiccup into five
    // minutes of silence and then a timeout — while the merge had usually happened.
    if (!read) {
      if (await merged(worktree, repository, number)) return undefined;
      throw new Error(
        `lost track of the merge of #${number}: ${poll.stderr.split("\n")[0] || "no result"}`,
      );
    }
    result = read;
  }

  const outcome = outcomeOf(result);
  if (outcome.error) throw new Error(`could not merge #${number}: ${outcome.error}`);
  return outcome.note;
}
