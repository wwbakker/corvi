import { baseName } from "@corvi/contracts/paths";
import { effectiveBranchOf } from "@corvi/contracts/changes";
import { Effect, Option, Result, Schema } from "effect";
import type { ChangeWireDto as Change } from "@corvi/contracts/api";
import type { WidgetItemDto as WidgetItem, WidgetStateDto as WidgetState } from "@corvi/contracts/api";
import { stackOnBase, describeStack, mergeStacked, type Stack } from "./stacks.ts";
import { shOrThrow, shSoft, type ShellResult } from "./shell.ts";
import { ghOrThrow, ghSoft, refusalNow, type GitHubRateLimited } from "./rate-limit.ts";
import { Cache, Changes, GitFacts, invalidate, swr } from "@corvi/contracts/capabilities";
import { BadRequestError, type CliError } from "@corvi/contracts/errors";
import { cliJson } from "@corvi/shell/cli";

/** `gh pr list --json` for one head. */
const PrSchema = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  state: Schema.String,
  isDraft: Schema.Boolean,
  reviewDecision: Schema.optional(Schema.NullOr(Schema.String)),
  mergeable: Schema.optional(Schema.NullOr(Schema.String)),
  statusCheckRollup: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          conclusion: Schema.optional(Schema.String),
          state: Schema.optional(Schema.String),
        }),
      ),
    ),
  ),
});

type Pr = {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  reviewDecision?: string | null;
  mergeable?: string | null;
  statusCheckRollup: { conclusion?: string; state?: string }[] | null;
};

/** What a pull request's review state means for merging. GitHub sets `REVIEW_REQUIRED` only
 * while a review the repository requires is still outstanding, and leaves `reviewDecision`
 * null when no review is required at all — so the absence of a decision is the signal that
 * nothing is waiting on one. `CHANGES_REQUESTED` is a decision too: a reviewer asked for
 * changes, and that blocks whether or not the repository requires an approval. */
export type ReviewState = "approved" | "changes-requested" | "required" | "none";

// Pure and synchronous: nothing for an Effect to wrap.
export function reviewState(pr: { reviewDecision?: string | null }): ReviewState {
  switch (pr.reviewDecision) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes-requested";
    case "REVIEW_REQUIRED":
      return "required";
    default:
      return "none";
  }
}

/** What the pull request is waiting for. Unresolved threads do not hide the review decision:
 * "approved with comments still open" is a real and interesting state. */
// Pure and synchronous: nothing for an Effect to wrap.
export function readiness(
  pr: { reviewDecision?: string | null; mergeable?: string | null },
  unresolved = 0,
): { text: string; tone?: WidgetState } {
  const comments = unresolved
    ? `${unresolved} unresolved comment${unresolved === 1 ? "" : "s"}`
    : undefined;
  const say = (text: string, tone?: WidgetState): { text: string; tone: WidgetState | undefined } => ({
    text: [comments, text].filter(Boolean).join(" · "),
    tone: comments ? ("warn" as WidgetState) : tone,
  });

  if (pr.mergeable === "CONFLICTING") return say("conflicts", "error");
  switch (reviewState(pr)) {
    case "approved":
      // Approved, but open threads mean it is not simply ready: say approved, not ready to merge.
      return comments ? say("approved") : say("ready to merge", "ok");
    case "changes-requested":
      return say("changes requested", "warn");
    case "required":
      return say("review required");
    case "none":
      // No review is required: nothing is pending. A draft still reads as one separately.
      return say("no review required");
  }
}

/** SUCCESS/FAILURE come from checks, SUCCESS/PENDING from commit statuses; treat both. */
function checksState(pr: Pr): { state: WidgetState; text: string } {
  const checks = pr.statusCheckRollup ?? [];
  if (checks.length === 0) return { state: pr.isDraft ? "pending" : "ok", text: "no checks" };
  const results = checks.map((c) => c.conclusion || c.state || "");
  const failed = results.filter((r) => ["FAILURE", "ERROR", "TIMED_OUT"].includes(r)).length;
  const running = results.filter((r) => ["PENDING", "IN_PROGRESS", "QUEUED", ""].includes(r)).length;
  if (failed) return { state: "error", text: `${failed} failing` };
  if (running) return { state: "pending", text: `${running} running` };
  return { state: "ok", text: "checks passed" };
}

/**
 * Which branch on the remote a pull request would be for. Usually the change's own branch, but a
 * branch that was renamed, or made around work that already existed, pushes somewhere else — and
 * a pull request belongs to the branch that was pushed, not to the one you have locally.
 *
 * The remote's default branch is never it: a branch left tracking `origin/main` is not a
 * pull request.
 */
// Pure and synchronous: nothing for an Effect to wrap.
export function headRef(branch: string, upstream?: string, remoteDefault?: string): string {
  if (!upstream || upstream === remoteDefault) return branch;
  const name = upstream.slice(upstream.indexOf("/") + 1);
  return name || branch;
}

const pushedAs = (worktree: string, repo: string, branch: string): Effect.Effect<string, never, GitFacts> =>
  Effect.gen(function* () {
    const r = yield* shSoft(
      ["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`],
      worktree,
    );
    const facts = yield* GitFacts;
    return headRef(branch, r.stdout || undefined, yield* facts.remoteDefaultBranch(repo));
  });

/** The branch this change's work in `repo` follows: the change's own, the existing branch the
 * spec named, or — adopted as it is — the one the checkout has checked out now, read live.
 * Without a checkout to observe, an adopted branch falls back to the change's name. */
const effectiveBranchName = (
  change: Change,
  repo: string,
  worktree: string | undefined,
): Effect.Effect<string, BadRequestError, GitFacts> => {
  const spec = (change.checkouts ?? []).find((entry) => entry.path === repo);
  if (spec?.branch.kind === "existing") {
    const name = spec.branch.name;
    return Effect.flatMap(GitFacts, (facts) => facts.existingBranch(repo, name)).pipe(
      Effect.flatMap((branch) => branch
        ? Effect.succeed(branch)
        : Effect.fail(new BadRequestError({ message: `could not resolve existing branch ${name} in ${repo}` }))),
    );
  }
  const effective = effectiveBranchOf(change.branch, spec?.branch ?? { kind: "change" });
  if (effective._tag === "Recorded") return Effect.succeed(effective.name);
  if (!worktree) return Effect.succeed(change.branch);
  return Effect.map(shSoft(["git", "rev-parse", "--abbrev-ref", "HEAD"], worktree), (r) => {
    const name = r.stdout.trim();
    return name && name !== "HEAD" ? name : change.branch;
  });
};

/** gh needs a repository as its working directory; the worktree is the one we know is on the
 * change's branch. Fails with a BadRequestError carrying the CLI's message. */
type FoundPr = { worktree: string; head: string; prs: Pr[] };

const prQuery = (
  change: Change,
  repo: string,
): Effect.Effect<FoundPr | undefined, BadRequestError | GitHubRateLimited, Changes | GitFacts> =>
  Effect.gen(function* () {
    const worktree = yield* Effect.flatMap(Changes, (changes) => changes.checkout(change, repo));
    if (!worktree) return undefined;
    const branch = yield* effectiveBranchName(change, repo, worktree);
    const head = yield* pushedAs(worktree, repo, branch);
    // A rate limit is not this command's failure but the token's, so `ghSoft` keeps it in the
    // error channel instead of letting it become the sentence below.
    const r = yield* ghSoft(
      [
        "gh",
        "pr",
        "list",
        "--head",
        head,
        "--state",
        "all",
        "--limit",
        "1",
        "--json",
        "number,title,url,state,isDraft,reviewDecision,mergeable,statusCheckRollup",
      ],
      worktree,
    );
    if (r.code !== 0) {
      // `??` after an index would never fire: an empty stderr's first line is `""`, not
      // undefined. `||` over both streams — `gh` can put an error on stdout — and then the
      // exit code: a `gh` that fails without a word must still reach the page as a sentence
      // naming the command and how it failed, not an empty line or a bare fallback.
      const reason = r.stderr.split("\n")[0]?.trim() || r.stdout.split("\n")[0]?.trim();
      return yield* new BadRequestError({
        message: reason || `gh pr list exited with code ${r.code}`,
      });
    }
    const prs = yield* cliJson(Schema.Array(PrSchema), [] as Pr[])(r.stdout);
    return { worktree, head, prs };
  });

/**
 * How long a pull request's state is worth reusing. A `gh` call costs at least one GraphQL point,
 * so the budget is in practice a budget of calls rather than of objects: this is what makes the
 * overview, the dashboard and the summaries share one lookup, and what keeps a change page's
 * polling inside the token. Thirty seconds is still short enough that pushing and refreshing
 * shows the change. Only the *display* paths use it — the click that decides asks GitHub itself.
 */
const PR_TTL = 30_000;

/** How long a pull request's review threads and stack position are worth reusing: ten times a
 * poll would otherwise ask GitHub for things nobody watches at that cadence, and both are quiet —
 * a comment count or a stack position does not change between two polls.
 *
 * A repository without GitHub's stacks preview pays **two** queries per refresh — the preview
 * query, then the same one without the stack fields — so its details cost twice what this TTL
 * implies, which is why the TTL is what makes that doubling affordable. */
const DETAILS_TTL = 120_000;

/** How many repositories are asked at once, for every fan-out over a change's repositories. Each
 * lookup is a `gh` process, and ten started together are also a burst GitHub answers with a
 * secondary limit — which would gate the very reads being asked for. Four keeps a ten-repository
 * change to three rounds. */
export const REPOSITORY_CONCURRENCY = 4;

const shownPr = (change: Change, repo: string): Effect.Effect<FoundPr | undefined, BadRequestError | GitHubRateLimited, Changes | GitFacts | Cache> =>
  swr(`gh:pr:${change.id}:${repo}`, PR_TTL, prQuery(change, repo));

/** Owner and name from a pull request URL, so counting threads costs no extra lookup. */
// Pure and synchronous: nothing for an Effect to wrap.
export function repoFromUrl(url: string): { owner: string; name: string } | undefined {
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\//.exec(url);
  return m ? { owner: m[1]!, name: m[2]! } : undefined;
}

type Details = { unresolved?: number; stack?: Stack };

const detailsQuery = (withStack: boolean): string =>
  "query($owner:String!,$name:String!,$number:Int!){viewer{login} repository(owner:$owner,name:$name)" +
  "{pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved " +
  "comments(last:1){nodes{author{login}}}}}" +
  (withStack ? " stack{number size} stackEntry{position}" : "") +
  "}}}";

type Thread = {
  isResolved: boolean;
  comments?: { nodes?: readonly { author?: { login?: string } | null }[] };
};

type DetailsResponse = {
  data?: {
    viewer?: { login?: string };
    repository?: {
      pullRequest?: {
        reviewThreads?: { nodes?: Thread[] };
        stack?: { number: number; size: number } | null;
        stackEntry?: { position: number } | null;
      };
    };
  };
};

/** The GraphQL answer, as far as this file reads it: every field optional, because where a query
 * fails the answer is "nothing", not an error. */
const DetailsSchema = Schema.Struct({
  data: Schema.optional(
    Schema.Struct({
      viewer: Schema.optional(Schema.Struct({ login: Schema.optional(Schema.String) })),
      repository: Schema.optional(
        Schema.Struct({
          pullRequest: Schema.optional(
            Schema.Struct({
              reviewThreads: Schema.optional(
                Schema.Struct({
                  nodes: Schema.optional(
                    Schema.Array(
                      Schema.Struct({
                        isResolved: Schema.Boolean,
                        comments: Schema.optional(
                          Schema.Struct({
                            nodes: Schema.optional(
                              Schema.Array(
                                Schema.Struct({
                                  author: Schema.optional(
                                    Schema.NullOr(
                                      Schema.Struct({ login: Schema.optional(Schema.String) }),
                                    ),
                                  ),
                                }),
                              ),
                            ),
                          }),
                        ),
                      }),
                    ),
                  ),
                }),
              ),
              stack: Schema.optional(
                Schema.NullOr(Schema.Struct({ number: Schema.Number, size: Schema.Number })),
              ),
              stackEntry: Schema.optional(
                Schema.NullOr(Schema.Struct({ position: Schema.Number })),
              ),
            }),
          ),
        }),
      ),
    }),
  ),
});

/**
 * Threads still waiting for you: unresolved, and not last spoken in by you.
 *
 * A thread you answered last is out of your hands — you replied, or you asked a question back —
 * and counting it makes the number say "you have work" when you do not. Only the reviewer
 * resolves a thread, so an answered one stays unresolved for as long as they take to look.
 */
// Pure and synchronous: nothing for an Effect to wrap.
export function waitingOnYou(threads: readonly Thread[], me?: string): number {
  return threads.filter((t) => {
    if (t.isResolved) return false;
    const last = t.comments?.nodes?.at(-1)?.author?.login;
    // No login to compare against (an unknown viewer, a deleted author): count it, since the
    // safe answer to "is this waiting for me?" is yes.
    return !me || !last || last !== me;
  }).length;
}

/**
 * Unresolved review threads and stack membership in one query: the only comment count worth
 * acting on (resolved ones are done), and where this pull request sits in a stack. REST exposes
 * neither on the list endpoint, hence GraphQL.
 *
 * Stacked pull requests are a preview feature: where it is not enabled the fields do not exist
 * and the whole query fails, so that case asks again without them rather than losing the counts.
 */
const prDetails = (
  worktree: string,
  url: string,
  number: number,
): Effect.Effect<Details, never, Changes | GitFacts | Cache> =>
  swr(`gh:details:${url}`, DETAILS_TTL, readDetails(worktree, url, number)).pipe(
    // The counts are a nicety: where GitHub will not answer, the card says nothing rather than
    // reporting zero as if it had asked. Caught outside the cache on purpose — an answer stored
    // as "no answer" would keep saying so for the whole TTL after GitHub answers again.
    Effect.catchTag("GitHubRateLimited", () => Effect.succeed({} as Details)),
  );

const readDetails = (
  worktree: string,
  url: string,
  number: number,
): Effect.Effect<Details, GitHubRateLimited, Changes | GitFacts> =>
  Effect.gen(function* () {
    const repo = repoFromUrl(url);
    if (!repo) return {};
    const ask = (withStack: boolean): Effect.Effect<ShellResult, GitHubRateLimited> =>
      ghSoft(
        [
          "gh",
          "api",
          "graphql",
          "-f",
          `query=${detailsQuery(withStack)}`,
          "-F",
          `owner=${repo.owner}`,
          "-F",
          `name=${repo.name}`,
          "-F",
          `number=${number}`,
        ],
        worktree,
      );
    let r = yield* ask(true);
    if (r.code !== 0) r = yield* ask(false);
    if (r.code !== 0) return {};

    const data = (yield* cliJson(DetailsSchema, {} as DetailsResponse)(r.stdout)).data;
    const pr = data?.repository?.pullRequest;
    const stack = pr?.stack;
    const position = pr?.stackEntry?.position;
    return {
      unresolved: waitingOnYou(pr?.reviewThreads?.nodes ?? [], data?.viewer?.login),
      stack: stack && position ? { number: stack.number, size: stack.size, position } : undefined,
    };
  });

/**
 * The pull request of this repository as the overview needs it: its number, and how many review
 * threads are still open. A merged or closed pull request is waiting for nobody, so it reports
 * none. Failures are not errors here — the overview says nothing rather than a red card — except
 * a rate limit, which is said: a gated read reports `checks: "warn"` and the limit's sentence, so
 * the summary does not read green, and `detail` is what the summary contributor says once for the
 * whole change.
 *
 * The number alone is what the azure-devops extension needs for the merge ref, through
 * `prNumberOf` below: one cached lookup serves both cards.
 */
export const prNumberOf = (
  change: Change,
  repo: string,
): Effect.Effect<number | undefined, never, Changes | GitFacts | Cache> =>
  Effect.map(
    Effect.orElseSucceed(prSummary(change, repo), () => undefined),
    (summary) => summary?.number,
  );

export type PrSummary = {
  number?: number;
  unresolved: number;
  checks: WidgetState;
  /** The limit's sentence, when the token is out: the row says it, and the overview says it once
   * for the change rather than once per repository. */
  detail?: string;
};

export const prSummary = (
  change: Change,
  repo: string,
): Effect.Effect<PrSummary, never, Changes | GitFacts | Cache> =>
  Effect.gen(function* () {
    const summary = yield* Effect.gen(function* () {
      const found = yield* Effect.orElseSucceed(shownPr(change, repo), () => undefined);
      const pr = found?.prs[0];
      if (!found || !pr) return { unresolved: 0, checks: "none" as WidgetState };
      // The checks come with the pull request itself — `statusCheckRollup` is part of the lookup
      // that was already made — so the state of the build costs nothing extra here.
      const checks = pr.state === "MERGED" ? "ok" : checksState(pr).state;
      if (["MERGED", "CLOSED"].includes(pr.state)) {
        return { number: pr.number, unresolved: 0, checks };
      }
      const details = yield* prDetails(found.worktree, pr.url, pr.number);
      return { number: pr.number, unresolved: details.unresolved ?? 0, checks };
    });
    // Asked last, and only once: the gate is the record of a limit whether it was already shut —
    // a warm display entry would otherwise report the state from before it — or was shut by the
    // read just made, whose details half swallows its own limit. A cheap question, with no I/O.
    const refused = yield* refusalNow("graphql");
    return Option.isSome(refused)
      ? { ...summary, checks: "warn" as WidgetState, detail: refused.value.message }
      : summary;
  });

/** The pull request for this change in `repo`, plus a row describing it. */
export const prItem = (
  change: Change,
  repo: string,
): Effect.Effect<{ number?: number; item: WidgetItem }, BadRequestError, Changes | GitFacts | Cache> =>
  Effect.gen(function* () {
    // The repository is the parent row in the tree, so these labels do not repeat it.
    const label = "pull request";
    const found = yield* Effect.result(shownPr(change, repo));
    if (Result.isFailure(found)) {
      return { item: { label, detail: found.failure.message, state: "error" } };
    }
    const hit = found.success;
    if (!hit) return { item: { label, detail: "no worktree", state: "none" } };
    const pr = hit.prs[0];
    if (!pr) {
      return {
        item: {
          label: "no pull request",
          detail: "not pushed yet",
          state: "none",
          actions: [{ id: "create", label: "Push & create PR", arg: repo }],
        },
      };
    }
    // The gate is asked before the row is described: a warm display entry would otherwise paint
    // the state from before the limit while the checks row and the summary say the token is out —
    // and the details read swallows its own limit, so the row would quietly lose its comment
    // count. The number stays: the repository row uses it to ask for the checks, whose warn row
    // says the same thing.
    const refused = yield* refusalNow("graphql");
    if (Option.isSome(refused)) {
      return {
        number: pr.number,
        item: {
          label: `#${pr.number} ${pr.title}`,
          detail: refused.value.message,
          url: pr.url,
          state: "warn",
        },
      };
    }
    const checks = checksState(pr);
    // No check text: the dot carries the check state and the runs are listed underneath. Draft,
    // merged and closed are the exceptions, since nothing else on the row says so. Comment counts
    // are the one thing you cannot see anywhere else on this page.
    const notable = pr.isDraft
      ? "draft"
      : ["MERGED", "CLOSED"].includes(pr.state)
      ? pr.state.toLowerCase()
      : undefined;
    // Surprising enough to say: the work goes to a branch with another name.
    const branch = yield* effectiveBranchName(change, repo, hit.worktree);
    const elsewhere = hit.head !== branch ? `pushed as ${hit.head}` : undefined;
    // A merged or closed pull request is not waiting for anything, so it only says so.
    const settled = ["MERGED", "CLOSED"].includes(pr.state);
    const details = yield* prDetails(hit.worktree, pr.url, pr.number);
    const unresolved = settled ? 0 : (details.unresolved ?? 0);
    const status = settled ? { text: "", tone: undefined } : readiness(pr, unresolved);
    return {
      number: pr.number,
      item: {
        label: `#${pr.number} ${pr.title}`,
        // The stack goes last: it describes the work around this pull request, not its state.
        detail:
          [notable, elsewhere, status.text, details.stack && describeStack(details.stack)]
            .filter(Boolean)
            .join(" · ") || undefined,
        detailTone: status.tone,
        url: pr.url,
        state: pr.state === "MERGED" ? "ok" : checks.state,
      },
    };
  });

/** Whether this repository's pull request may be merged as part of completing the change.
 *
 * Not being ready is a reason and its kind. `forceable` is this pull request's own state — a
 * draft, a conflict, a review still required — which a person may knowingly finish without
 * merging. `hard` is the token's limit: external, transient, and true of every repository at
 * once, so there is nothing here to decide and "Complete anyway" would fail at the merge. */
export type MergeReadiness =
  | { ready: true; merged: true }
  | { ready: true; merged: false; number: number }
  | { ready: false; reason: string; kind: "forceable" | "hard" };

/** Forget this change's cached pull-request reads: an action just made them wrong. Called once
 * per click path, before the fresh readiness check, so the dialog and the page that follows it
 * are not painting the state that was just superseded.
 *
 * The review threads go too, and their key is the pull request's URL rather than this change's:
 * two minutes of thread counts surviving a reply is what "action invalidates what it made wrong"
 * forbids, and a shared key only means another change re-reads a count it would have re-read
 * anyway. */
export const forgetPrs = (change: Change): Effect.Effect<void, never, Cache> =>
  Effect.gen(function* () {
    yield* invalidate(`gh:pr:${change.id}:`);
    yield* invalidate("gh:details:");
  });

/** A readiness check against freshly fetched refs: the branch may have merged upstream
 * seconds ago, and the local remote-tracking refs would still say otherwise. Fetches first,
 * then reads live — the click that decides never reads the shared cache — so the override
 * dialog only lists requirements that are genuinely unmet. The poll that orients asks
 * `cachedReadiness` instead. */
export const refreshReadiness = (
  change: Change,
  repo: string,
): Effect.Effect<MergeReadiness, BadRequestError, Changes | GitFacts> =>
  Effect.gen(function* () {
    yield* shSoft(["git", "fetch", "--quiet", "origin"], repo);
    return yield* mergeReadiness(change, repo);
  });

/** The verdict for a pull request that was already found: `mergeReadiness` reads it live, the
 * poll reads the display cache, and both decide the same way. */
const verdictOf = (
  change: Change,
  repo: string,
  found: FoundPr | undefined,
): Effect.Effect<MergeReadiness, BadRequestError, GitFacts> =>
  Effect.gen(function* () {
    const name = baseName(repo);
    if (!found) return { ready: false, reason: `${name}: no worktree`, kind: "forceable" };
    const pr = found.prs[0];
    if (pr?.state === "MERGED") return { ready: true, merged: true };
    // No pull request, or one that was closed without merging: the work may still have
    // landed — merged through a PR created elsewhere, or pushed straight to main. When
    // every commit on the branch is already in main there is nothing left to merge, so the
    // repository reads as merged rather than blocked. An open PR asserts "under review"
    // and still gates, even on an integrated branch.
    if (!pr || pr.state === "CLOSED") {
      const facts = yield* GitFacts;
      const base = yield* facts.targetFor(change, repo);
      const branch = yield* effectiveBranchName(change, repo, found.worktree);
      if (yield* facts.contentInMain(repo, branch, base)) {
        return { ready: true, merged: true };
      }
      return {
        ready: false,
        reason: pr ? `${name}: pull request is closed` : `${name}: no pull request`,
        kind: "forceable",
      };
    }
    if (pr.isDraft) return { ready: false, reason: `${name}: pull request is a draft`, kind: "forceable" };
    if (pr.mergeable === "CONFLICTING") {
      return { ready: false, reason: `${name}: conflicts`, kind: "forceable" };
    }
    // Only an outstanding required review, or one that asked for changes, blocks. No decision
    // at all means the repository requires no review, so there is nothing left to wait for.
    const review = reviewState(pr);
    if (review === "required" || review === "changes-requested") {
      const decision = (pr.reviewDecision ?? "review required").toLowerCase().replace(/_/g, " ");
      return { ready: false, reason: `${name}: not approved (${decision})`, kind: "forceable" };
    }
    return { ready: true, merged: false, number: pr.number };
  });

/** A token at its limit is not this repository's failure, so it is a verdict rather than a thrown
 * error: the sentence carries no repository prefix — ten repositories share one token — and no
 * acknowledgement waives it. */
const rateLimited = (error: GitHubRateLimited): MergeReadiness => ({
  ready: false,
  reason: error.message,
  kind: "hard",
});

/** Live, never cached: a pull request that was approved ninety seconds ago is not a merge. The
 * click that decides asks this one. */
export const mergeReadiness = (
  change: Change,
  repo: string,
): Effect.Effect<MergeReadiness, BadRequestError, Changes | GitFacts> =>
  prQuery(change, repo).pipe(
    Effect.flatMap((found) => verdictOf(change, repo, found)),
    Effect.catchTag("GitHubRateLimited", (error) => Effect.succeed(rateLimited(error))),
  );

/** The same verdict from the display read the cards already make — `shownPr` — so a poll costs no
 * live lookup per repository. Freshness is what it gives up: the cache is stale-while-revalidate,
 * so its answer is at least `PR_TTL` old and, while refreshes keep failing, older than that for
 * as long as GitHub stays unreachable. The click that decides does not use it.
 *
 * That gives-up freshness is why the gate is asked first: a warm entry survives the limit — the
 * cache keeps its last good value — so the display read would answer with the pre-limit verdict
 * (even "ready") for as long as the limit lasts. The gate knows without spawning or probing. */
export const cachedReadiness = (
  change: Change,
  repo: string,
): Effect.Effect<MergeReadiness, BadRequestError, Changes | GitFacts | Cache> =>
  Effect.gen(function* () {
    const refused = yield* refusalNow("graphql");
    if (Option.isSome(refused)) return rateLimited(refused.value);
    return yield* shownPr(change, repo).pipe(
      Effect.flatMap((found) => verdictOf(change, repo, found)),
      Effect.catchTag("GitHubRateLimited", (error) => Effect.succeed(rateLimited(error))),
    );
  });

/**
 * Squash-merge the pull request: the repositories this was written for allow squash only, and
 * delete the remote branch themselves.
 *
 * A pull request in a stack cannot be merged this way — GitHub refuses, because merging one
 * takes everything below it along and that runs in the background — so those go through the
 * asynchronous merge API instead.
 */
export const mergePr = (
  change: Change,
  repo: string,
  number: number,
): Effect.Effect<string | undefined, BadRequestError | CliError | GitHubRateLimited, Changes | GitFacts> =>
  Effect.gen(function* () {
    const worktree = yield* Effect.flatMap(Changes, (changes) => changes.checkout(change, repo));
    const branch = yield* effectiveBranchName(change, repo, worktree);
    if (!worktree) {
      return yield* new BadRequestError({ message: `no worktree for ${branch} in ${repo}` });
    }

    const stacked = yield* isStacked(worktree, repo, number);
    if (!stacked) {
      yield* ghOrThrow(["gh", "pr", "merge", String(number), "--squash"], worktree);
      return undefined;
    }
    // Returns a note when the merge did not simply happen: a queued stack has not landed yet.
    const note = yield* mergeStacked(worktree, stacked, number);
    return note && `${baseName(repo)} #${number}: ${note}`;
  });

/** The repository as `owner/name` when this pull request belongs to a stack, otherwise nothing. */
const isStacked = (
  worktree: string,
  repo: string,
  number: number,
): Effect.Effect<string | undefined, GitHubRateLimited> =>
  Effect.gen(function* () {
    const repository = (
      yield* ghSoft(["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], worktree)
    ).stdout;
    if (!repository) return undefined;
    const pr = yield* ghSoft(["gh", "api", `repos/${repository}/pulls/${number}`], worktree);
    const parsed = yield* cliJson(
      Schema.Struct({ stack: Schema.optional(Schema.Unknown) }),
      {} as { stack?: unknown },
    )(pr.stdout);
    return parsed.stack ? repository : undefined;
  });

/** Push the branch and open a pull request for it. */
export const createPr = (
  change: Change,
  repo: string,
): Effect.Effect<void, BadRequestError | CliError | GitHubRateLimited, Changes | GitFacts | Cache> =>
  Effect.gen(function* () {
    const worktree = yield* Effect.flatMap(Changes, (changes) => changes.checkout(change, repo));
    const branch = yield* effectiveBranchName(change, repo, worktree);
    if (!worktree) {
      return yield* new BadRequestError({ message: `no worktree for ${branch} in ${repo}` });
    }
    yield* shOrThrow(["git", "push", "-u", "origin", branch], worktree);
    // A change stacked on another one's branch must open its pull request against that branch:
    // against main the diff would contain the other change's commits as well. GitHub retargets
    // the pull request to main by itself once the base branch merges.
    const facts = yield* GitFacts;
    const base = yield* facts.targetFor(change, repo);
    const target = base?.startsWith("origin/") ? base.slice("origin/".length) : base;
    const against = target && (yield* facts.remoteDefaultBranch(repo)) !== base ? ["--base", target] : [];
    yield* ghOrThrow(["gh", "pr", "create", "--fill", ...against], worktree);
    if (against.length) {
      // The pull request exists by now: not learning its number costs the stack nicety, not the
      // create.
      const view = yield* ghSoft(
        ["gh", "pr", "view", "--json", "number", "-q", ".number"],
        worktree,
      ).pipe(
        Effect.catchTag("GitHubRateLimited", () =>
          Effect.succeed({ code: 1, stdout: "", stderr: "" }),
        ),
      );
      const number = Number(view.stdout);
      if (number) yield* stackOnBase(worktree, target!, number);
    }
    // The cached answer says there is no pull request, and it was right until a moment ago.
    yield* invalidate(`gh:pr:${change.id}:`);
  });

