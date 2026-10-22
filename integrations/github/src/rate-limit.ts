/**
 * The one seam every `gh` call goes through: a per-resource gate that refuses before spawning a
 * process, the classification of a limit out of a failed command's output, and the reset the
 * limit carries — learned from `gh api rate_limit`, which GitHub does not count against the
 * budget, once per closure and resource.
 *
 * The limit belongs to a token, and a workspace has a token of its own (`GH_CONFIG_DIR` is one of
 * the workspace's environment variables), so the state here is keyed by workspace and resource
 * and lives as long as the process: one workspace running out must not refuse another, and the
 * first one's reset says nothing about the second's. `forgetRateLimit()` is the explicit retry.
 *
 * What the gate learns is *when* GitHub will answer again, not how much is left: the reported
 * `remaining` moved by hundreds of points between two reads minutes apart on a token that had
 * spent six, so a running total would be fiction. A gate that refuses until a time is honest.
 */
import { DEFAULT_WORKSPACE } from "@corvi/contracts/config";
import { CliError } from "@corvi/contracts/errors";
import { Workspace } from "@corvi/contracts/workspace";
import { cliJson } from "@corvi/shell/cli";
import { Clock, Deferred, Effect, Option, Schema } from "effect";
import { sh, type ShellResult } from "./shell.ts";

/** GitHub's two independent budgets, and the burst throttle that is neither. `gh` itself settles
 * most writes on GraphQL (creating, merging and closing all go through its mutation API), so an
 * exhausted GraphQL budget makes those impossible: refusing them at the gate is what GitHub would
 * answer, said sooner and without a process. */
const resources = ["graphql", "core", "secondary"] as const;

export type RateLimitResource = (typeof resources)[number];

/** GitHub will not answer until `resetsAt`; waiting is the only fix. */
export class GitHubRateLimited extends Schema.TaggedError<GitHubRateLimited>()("GitHubRateLimited", {
  message: Schema.String,
  resource: Schema.Literals(resources),
  resetsAt: Schema.String,
}) {}

/** How long the gate stays closed when GitHub does not say when it will answer again: a
 * secondary limit is a pause rather than a budget, and a failed probe says nothing at all. It is
 * also the floor for a reset in the past — our clock can run ahead of GitHub's. */
const BACKOFF_MS = 60_000;

/** "Refuses until", keyed by workspace and resource, in epoch milliseconds. The token's budget,
 * not any change's or repository's, so it outlives every request. */
const gatedUntil = new Map<string, number>();

/** The probe in flight, per workspace: everyone in that workspace who hit the limit at the same
 * moment awaits it rather than spending a `gh` of their own — and nobody else's answer. */
const probesInFlight = new Map<string, Deferred.Deferred<ProbedResets>>();

const gateKey = (workspace: string, resource: RateLimitResource): string =>
  `${workspace}|${resource}`;

/** As much of `gh api rate_limit`'s answer as the gate reads. */
const RateLimitSchema = Schema.Struct({
  resources: Schema.optional(
    Schema.Struct({
      graphql: Schema.optional(Schema.Struct({ reset: Schema.optional(Schema.Number) })),
      core: Schema.optional(Schema.Struct({ reset: Schema.optional(Schema.Number) })),
    }),
  ),
});

type RateLimitPayload = Schema.Schema.Type<typeof RateLimitSchema>;

type ProbedResets = Partial<Record<RateLimitResource, number>>;

/** Which workspace's token is being spent. Absent outside a request: the default workspace's
 * budget, exactly as `shell.ts` resolves the environment. */
const workspaceId = (): Effect.Effect<string> =>
  Effect.map(Effect.serviceOption(Workspace), (workspace) =>
    Option.isSome(workspace) ? workspace.value.id : DEFAULT_WORKSPACE.id,
  );

/** The budget a command spends. Explicit because the two budgets are independent, and a wrong
 * guess only ever means refusing a command that would have answered: GitHub's answer to the
 * failure is authoritative wherever `gh` mixes both. */
const resourceOf = (cmd: readonly string[]): RateLimitResource => {
  const group: string | undefined = cmd[1];
  const action: string | undefined = cmd[2];
  if (group === "api") return action === "graphql" ? "graphql" : "core";
  // Every `gh pr` subcommand Corvi uses is GraphQL: reads, and create/merge, which are mutations.
  if (group === "pr") return "graphql";
  // So is every `gh issue` subcommand, creating included (`api.IssueCreate` is a GraphQL
  // mutation in `gh`, REST only in GitHub's own vocabulary).
  if (group === "issue") return "graphql";
  if (group === "repo") return "graphql";
  // Every command Corvi uses is named above; a group this table does not know reads as REST,
  // which is the safer guess for a failure whose words name no budget.
  return "core";
};

/** GitHub's words for "not now", as `gh` passes them through: GraphQL's own sentence, REST's
 * 403, and the burst throttle that is neither. */
const LIMIT = /api rate limit exceeded|already exceeded|secondary rate limit|abuse detection/i;
const SECONDARY = /secondary rate limit|abuse detection/i;
const GRAPHQL = /graphql/i;

/** Which budget a failure exhausted, or nothing when the failure was not a limit. `gh` puts an
 * error on either stream, so both are read. Its words win when they name a budget; otherwise the
 * command's own is the answer — a GraphQL failure can be reported in REST's wording, and gating
 * the budget the command did not spend would leave the exhausted one open. */
const classify = (
  result: ShellResult,
  budget: RateLimitResource,
): RateLimitResource | undefined => {
  const output = `${result.stderr}\n${result.stdout}`;
  if (!LIMIT.test(output)) return undefined;
  if (SECONDARY.test(output)) return "secondary";
  return GRAPHQL.test(output) ? "graphql" : budget;
};

/** The gate that refuses `resource`, when one does. A secondary limit is about how fast the
 * requests come rather than about a budget, so it shuts both budgets and names itself. */
const closedBy = (
  workspace: string,
  resource: RateLimitResource,
): { resource: RateLimitResource; until: number } | undefined => {
  const secondary = gatedUntil.get(gateKey(workspace, "secondary")) ?? 0;
  const own = gatedUntil.get(gateKey(workspace, resource)) ?? 0;
  if (secondary > 0 && secondary >= own) return { resource: "secondary", until: secondary };
  return own > 0 ? { resource, until: own } : undefined;
};

/** `12:32 UTC`: the server may serve a client in another time zone, so the reset is said in UTC;
 * the ISO `resetsAt` carries the instant for a client that wants its own clock. */
const timeOf = (at: number): string => {
  const date = new Date(at);
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes} UTC`;
};

/** The coarsest true duration: "in 8 minutes" is useful, "in 7 minutes and 34 seconds" is not.
 * Always a duration ahead: a reset is clamped to at least the backoff, and a gate refuses only
 * while its instant is still in the future. */
const inWords = (ms: number): string => {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 1) return "in a minute";
  if (minutes < 60) return `in ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "in an hour" : `in ${hours} hours`;
};

const refusal = (resource: RateLimitResource, until: number, now: number): GitHubRateLimited =>
  new GitHubRateLimited({
    message: `GitHub rate limit reached; resets at ${timeOf(until)} (${inWords(until - now)})`,
    resource,
    resetsAt: new Date(until).toISOString(),
  });

/** The resets `gh api rate_limit` reports, keyed by resource. `/rate_limit` does not count
 * against the budget, so it is the one question that still has an answer at the limit. The
 * `remaining` it carries is deliberately not read, for the reason this file gives at the top. */
const readRateLimit = (): Effect.Effect<ProbedResets> =>
  Effect.gen(function* () {
    const r = yield* sh(["gh", "api", "rate_limit"]);
    if (r.code !== 0) return {} as ProbedResets;
    const payload = yield* cliJson(RateLimitSchema, {} as RateLimitPayload)(r.stdout);
    const seconds = (reset: number | undefined): number | undefined =>
      reset === undefined ? undefined : reset * 1_000;
    return {
      graphql: seconds(payload.resources?.graphql?.reset),
      core: seconds(payload.resources?.core?.reset),
    };
  }).pipe(
    // A probe that cannot run at all — no Shell in context, a timeout — is no reset, not a
    // failure of the command that was already failing.
    Effect.catchTag("CliError", () => Effect.succeed({} as ProbedResets)),
  );

/** What a probe learned, and the cell that carried it: the caller that records the gate drops
 * that cell and no other. */
type Probed = { resets: ProbedResets; shared: Deferred.Deferred<ProbedResets> };

/** The probe, single-flight per workspace: one `gh api rate_limit` answers both budgets, and
 * nobody else's — a second workspace holds a second token. Only the resource that hit the limit
 * keeps the reset the probe reports: recording the other budget's would refuse calls it can still
 * answer, so that budget probes for itself when its turn comes. The probe deliberately does not
 * go through `gh` — it is the call that must still be made while the gate is shut, which is how
 * the gate learns when it opens. */
const probeResets = (workspace: string): Effect.Effect<Probed> =>
  Effect.gen(function* () {
    const running = probesInFlight.get(workspace);
    if (running !== undefined) return { resets: yield* Deferred.await(running), shared: running };
    const shared = yield* Deferred.make<ProbedResets>();
    probesInFlight.set(workspace, shared);
    const resets = yield* Effect.gen(function* () {
      const found = yield* readRateLimit();
      // Everyone who joined while the probe ran gets the answer it found.
      yield* Deferred.succeed(shared, found);
      return found;
    }).pipe(
      // `ensuring` runs however the probe ends — success, typed failure, defect and interruption
      // alike — where `onInterrupt` misses a defect. A probe that ends without an answer must
      // still release its joiners, with the backoff ("GitHub did not say"), or they would wait on
      // a Deferred nobody completes for the life of the process. The success path has already
      // completed the cell, so this answers only the case it is meant for.
      Effect.ensuring(
        Effect.sync(() => {
          if (!Deferred.doneUnsafe(shared, Effect.succeed({} as ProbedResets))) return;
          if (probesInFlight.get(workspace) === shared) probesInFlight.delete(workspace);
        }),
      ),
    );
    return { resets, shared };
  });

/** When GitHub will answer again for `resource`, and the probe cell that said so when this call
 * had to ask: the reset it reports, or a flat backoff when it reports none. A reset this closure
 * already learned is reused rather than probed for again. */
const resetFor = (
  workspace: string,
  resource: RateLimitResource,
): Effect.Effect<{ until: number; probed?: Deferred.Deferred<ProbedResets> }> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    // A secondary limit is a pause rather than a budget: GitHub's payload carries no reset for
    // it, and a probe inside the window would be one more request exactly when to send none.
    if (resource === "secondary") return { until: now + BACKOFF_MS };
    const known = gatedUntil.get(gateKey(workspace, resource));
    if (known !== undefined && known > now) return { until: known };
    const { resets, shared } = yield* probeResets(workspace);
    // Read the clock after the probe: it can take the CLI's whole timeout, and a floor measured
    // before it can land in the past, where it would be no gate at all.
    const after = yield* Clock.currentTimeMillis;
    // A reset in the past means our clock runs ahead of GitHub's (the VM drift the repository
    // notes describe); the backoff is the honest floor.
    return { until: Math.max(resets[resource] ?? 0, after + BACKOFF_MS), probed: shared };
  });

/** Shut the gate for `resource` and fail with the sentence that says when it opens. */
const limitReached = (
  workspace: string,
  resource: RateLimitResource,
): Effect.Effect<never, GitHubRateLimited> =>
  Effect.gen(function* () {
    const { until, probed } = yield* resetFor(workspace, resource);
    gatedUntil.set(gateKey(workspace, resource), until);
    // Only now is the probe's answer no longer needed: a caller that arrived while it ran has
    // joined it, and the next one is refused by the gate. Dropping it earlier would let that
    // joiner start a second probe.
    if (probed !== undefined && probesInFlight.get(workspace) === probed) {
      probesInFlight.delete(workspace);
    }
    const now = yield* Clock.currentTimeMillis;
    return yield* refusal(resource, until, now);
  });

/** The gate itself: answered before a process exists, so a closed gate costs nothing — no spawn
 * and no probe. A cached read asks this before trusting what it has, because a cache keeps its
 * last good value while refreshes fail and would otherwise answer with the pre-limit verdict for
 * as long as the gate lasts. */
export const refusalNow = (
  resource: RateLimitResource,
): Effect.Effect<Option.Option<GitHubRateLimited>> =>
  Effect.gen(function* () {
    const closed = closedBy(yield* workspaceId(), resource);
    if (closed === undefined) return Option.none();
    const now = yield* Clock.currentTimeMillis;
    if (closed.until <= now) return Option.none();
    return Option.some(refusal(closed.resource, closed.until, now));
  });

/** A `gh` command's outcome, or the refusal that it will not be run until `resetsAt`. The limit
 * belongs to the token, so this is answered before a process is spawned. */
export const gh = (
  cmd: readonly string[],
  cwd?: string,
): Effect.Effect<ShellResult, CliError | GitHubRateLimited> =>
  Effect.gen(function* () {
    const budget = resourceOf(cmd);
    const refused = yield* refusalNow(budget);
    if (Option.isSome(refused)) return yield* refused.value;
    const result = yield* sh(cmd, cwd);
    if (result.code === 0) return result;
    const limited = classify(result, budget);
    if (limited === undefined) return result;
    return yield* limitReached(yield* workspaceId(), limited);
  });

/** `gh`, with a non-zero exit as a failure — `<cmd> failed: <stderr>`, as `shOrThrow` has it. */
export const ghOrThrow = (
  cmd: readonly string[],
  cwd?: string,
): Effect.Effect<string, CliError | GitHubRateLimited> =>
  Effect.flatMap(gh(cmd, cwd), (r) => {
    if (r.code === 0) return Effect.succeed(r.stdout);
    const stderr = r.stderr || r.stdout;
    return Effect.fail(
      new CliError({
        tool: cmd[0] ?? "",
        command: cmd.join(" "),
        stderr,
        exitCode: r.code,
        message: `${cmd.join(" ")} failed: ${stderr}`,
      }),
    );
  });

/** `gh` for the call sites that branch on exit codes. The one failure `Shell` can raise is a
 * timeout, which reads as the failed command it is (exit 124) rather than as a failure of the
 * operation — what `shSoft` did. A rate limit stays in the error channel: whether it is surfaced
 * or degraded to a value is the caller's decision, and every caller makes it. */
export const ghSoft = (
  cmd: readonly string[],
  cwd?: string,
): Effect.Effect<ShellResult, GitHubRateLimited> =>
  gh(cmd, cwd).pipe(
    Effect.catchTag("CliError", (e) =>
      Effect.succeed({ code: e.exitCode, stdout: "", stderr: e.stderr || e.message }),
    ),
  );

/** Open every gate now: an explicit retry, and the tests that script `gh` failures. The limit
 * belongs to the tokens, which no test may inherit from whichever ran before it. */
export const forgetRateLimit = (): void => {
  gatedUntil.clear();
  for (const shared of probesInFlight.values()) {
    // A probe still running leaves nobody waiting on it past this point.
    Deferred.doneUnsafe(shared, Effect.succeed({} as ProbedResets));
  }
  probesInFlight.clear();
};
