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
