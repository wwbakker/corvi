import { Effect, Schema } from "effect";
import { BadRequestError } from "../effect/errors.ts";
import { cliJson, shSoft } from "../effect/support.ts";

/** Where a pull request sits in its stack, when it is in one. */
export type Stack = { number: number; size: number; position: number };

/** How a stack reads on the pull request row. */
export const describeStack = (stack: Stack): string =>
  `${stack.position} of ${stack.size} in stack #${stack.number}`;

// Pure and synchronous: nothing for an Effect to wrap.

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

// Pure and synchronous: nothing for an Effect to wrap.

/** What a merge request says about itself; the same object comes back from both endpoints. */
export type MergeResult = {
  status: "pending" | "merged" | "enqueued" | "failed";
  details?: { message?: string; uuid?: string; sha?: string };
};

/** Any object with a status is read as a merge result — the old cast trusted the field without
 * checking which word it held, and outcomeOf's default branch handled the rest. */
const MergeResultSchema = Schema.Struct({
  status: Schema.String,
  details: Schema.optional(
    Schema.Struct({
      message: Schema.optional(Schema.String),
      uuid: Schema.optional(Schema.String),
      sha: Schema.optional(Schema.String),
    }),
  ),
});

/** What to do with a merge result: keep waiting, stop happily, or fail with what GitHub said.
 * `enqueued` is an ending too — the stack went into the base branch's merge queue, and the queue
 * owns it from there. */
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

// Pure and synchronous: nothing for an Effect to wrap.

/** A merge result read from a response, or nothing when the response was not one: a poll can
 * fail (the request expired, the network hiccuped) and that is not the same as "still running".
 * Schema-decoded with the old tolerance — an unparseable or status-less answer is no result. */
export function pollResult(code: number, stdout: string): MergeResult | undefined {
  if (code !== 0) return undefined;
  try {
    const parsed = Schema.decodeUnknownSync(Schema.parseJson(MergeResultSchema))(stdout);
    return parsed.status ? (parsed as MergeResult) : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the pull request is merged, asked of the pull request itself. The merge request is a
 * report about the work; this is the work. */
const mergedEffect = (worktree: string, repository: string, number: number): Effect.Effect<boolean> =>
  Effect.map(
    shSoft(["gh", "api", `repos/${repository}/pulls/${number}`, "-q", ".merged"], worktree),
    (r) => r.stdout.trim() === "true",
  );

/**
 * Merge a stacked pull request. A stack cannot go through the ordinary merge endpoint at all —
 * GitHub refuses and points here — because merging one pull request of a stack merges everything
 * below it too, which takes long enough that it runs in the background.
 *
 * Submit, then poll until it is no longer pending. Fails with the message the old throws carried:
 * these are user-visible sentences about a merge that did not happen (BadRequestError maps where
 * the old thrown Error went — a 400 carrying its message).
 */
export const mergeStackedEffect = (
  worktree: string,
  repository: string,
  number: number,
  method = "squash",
): Effect.Effect<string | undefined, BadRequestError> =>
  Effect.gen(function* () {
    const submit = yield* shSoft(
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
    // The old cast trusted `status` without checking which word it held; outcomeOf's default
    // branch handles the rest, so the decode keeps that tolerance.
    const submitted = (yield* Effect.orElseSucceed(
      Schema.decodeUnknown(Schema.parseJson(MergeResultSchema))(submit.stdout || "{}"),
      () => ({ status: "failed" }),
    )) as MergeResult;
    if (submit.code !== 0 && !submitted.details?.uuid) {
      return yield* Effect.fail(
        new BadRequestError({
          message: `could not start the merge of #${number}: ${submit.stderr || submit.stdout}`,
        }),
      );
    }

    let result = submitted;
    const uuid = submitted.details?.uuid;
    const deadline = Date.now() + 5 * 60_000;
    while (outcomeOf(result).waiting && uuid) {
      if (Date.now() > deadline) {
        // It may well have landed while we were failing to hear about it.
        if (yield* mergedEffect(worktree, repository, number)) return undefined;
        return yield* Effect.fail(
          new BadRequestError({ message: `the merge of #${number} is still running after 5m` }),
        );
      }
      // An interruptible sleep: an interrupted completion stops the polling too, and the `gh`
      // child of the next poll dies with it rather than outliving the request.
      yield* Effect.sleep(1000);
      const poll = yield* shSoft(
        ["gh", "api", ...STACKS_API, `repos/${repository}/pulls/${number}/merge-async/${uuid}`],
        worktree,
      );
      const read = pollResult(poll.code, poll.stdout);
      // A failed poll used to be read as "still pending", which turned any hiccup into five
      // minutes of silence and then a timeout — while the merge had usually happened.
      if (!read) {
        if (yield* mergedEffect(worktree, repository, number)) return undefined;
        return yield* Effect.fail(
          new BadRequestError({
            message: `lost track of the merge of #${number}: ${poll.stderr.split("\n")[0] || "no result"}`,
          }),
        );
      }
      result = read;
    }

    const outcome = outcomeOf(result);
    if (outcome.error) {
      return yield* Effect.fail(
        new BadRequestError({ message: `could not merge #${number}: ${outcome.error}` }),
      );
    }
    return outcome.note;
  });


/**
 * Tie a new pull request to the one it was branched off, as a GitHub stack: reviewers then see
 * the order of the work, and merging the bottom one moves the rest along.
 *
 * Best effort. The stack is a nicety on top of a pull request that already targets the right
 * branch, so a repository without the preview feature, or a base branch with no pull request of
 * its own, changes nothing else.
 */
export const stackOnBaseEffect = (
  worktree: string,
  baseBranch: string,
  number: number,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const repo = (
      yield* shSoft(["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], worktree)
    ).stdout;
    const listed = yield* shSoft(
      ["gh", "pr", "list", "--head", baseBranch, "--state", "open", "--json", "number", "--limit", "1"],
      worktree,
    );
    const below = (yield* cliJson(
      Schema.Array(Schema.Struct({ number: Schema.Number })),
      [] as { number: number }[],
    )(listed.stdout))[0]?.number;
    if (!repo || !below) return; // the branch below has no pull request: nothing to stack onto

    const stack = yield* cliJson(
      Schema.Struct({ stack: Schema.optional(Schema.Struct({ number: Schema.optional(Schema.Number) })) }),
      {} as { stack?: { number?: number } },
    )(
      (yield* shSoft(["gh", "api", `repos/${repo}/pulls/${below}`, ...STACKS_API], worktree)).stdout,
    );
    const r = yield* shSoft(
      ["gh", "api", "-X", "POST", ...STACKS_API, ...stackRequest(repo, below, number, stack.stack?.number)],
      worktree,
    );
    if (r.code !== 0) console.warn(`could not stack #${number} onto #${below}: ${r.stderr.trim()}`);
  });
