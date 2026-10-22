import { Effect, Schema } from "effect";
import type { ChangeWireDto as Change } from "@corvi/contracts/api";
import type { WidgetItemDto as WidgetItem, WidgetStateDto as WidgetState } from "@corvi/contracts/api";
import { Cache, Changes, GitFacts, Shell, Workspace } from "@corvi/contracts/capabilities";
import { cliJson } from "@corvi/shell/cli";
import { ghSoft, type GitHubRateLimited } from "./rate-limit.ts";

export type Check = {
  name: string;
  state: string;
  bucket: string;
  link?: string;
  startedAt?: string;
  completedAt?: string;
};

/** `gh pr checks --json` output, as far as this file reads it. */
const ChecksSchema = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    state: Schema.String,
    bucket: Schema.String,
    link: Schema.optional(Schema.String),
    startedAt: Schema.optional(Schema.String),
    completedAt: Schema.optional(Schema.String),
  }),
);

/** GitHub's own word for a check, which is the only vocabulary shared by Actions, Azure Pipelines
 * in any project, Cypress and whatever else a repository has bolted on. */
const checkState = (bucket: string): WidgetState =>
  ({ pass: "ok", fail: "error", pending: "pending", skipping: "none", cancel: "warn" })[bucket] as
    | WidgetState
    | undefined ?? "none";

/** The change's checkout of `repo`, read through the contract's `Changes` store. */
const worktreeOf = (change: Change, repo: string): Effect.Effect<string | undefined, never, Changes> =>
  Effect.flatMap(Changes, (changes) => changes.checkout(change, repo));

/**
 * The checks of a pull request, as the tree shows them.
 *
 * Names like `owner.pipeline (CI App @scope/one-app)` are grouped by the part before
 * the bracket, so thirty jobs of one build read as one row you can open.
 */
export const checkItems = (
  change: Change,
  repo: string,
  number: number,
): Effect.Effect<WidgetItem[], never, Changes | Shell | Workspace | Cache | GitFacts> =>
  Effect.gen(function* () {
    const cache = yield* Cache;
    const read = Effect.gen(function* () {
      const worktree = (yield* worktreeOf(change, repo)) ?? repo;
      // Non-zero means "something is failing or pending", which is a result, not an error; a rate
      // limit stays in the error channel, for the cache boundary below to catch.
      const r = yield* ghSoft(
        [
          "gh",
          "pr",
          "checks",
          String(number),
          "--json",
          "name,state,bucket,link,startedAt,completedAt",
        ],
        worktree,
      );
      return groupChecks(yield* cliJson(ChecksSchema, [] as Check[])(r.stdout));
    });
    // A minute: a `gh` call costs at least a point, so what is saved here is calls, and a check's
    // state does not change faster than this that anybody watches. That is why the gate is not
    // asked first, as `prSummary` does: inside the TTL the last real checks stand, stale but true;
    // past it, a gated read answers with the limit's row.
    return yield* cache.swr(`gh:checks:${repo}:${number}`, 60_000, read).pipe(
      // One row saying the checks could not be asked. An empty list would read as "no checks",
      // which is the one thing a gated read does not know. Caught outside the cache on purpose:
      // stored, the row would keep saying so for the whole TTL after GitHub answers again.
      Effect.catchTag("GitHubRateLimited", (error) => Effect.succeed([rateLimitedRow(error)])),
    );
  });

/** The row a gated read shows instead of the checks: what is unknown, and until when. */
const rateLimitedRow = (error: GitHubRateLimited): WidgetItem => ({
  label: "checks",
  detail: error.message,
  state: "warn",
});

/** Grouped by the part of the name before the bracket, so thirty jobs of one build read as one
 * row you can open. */
// Pure and synchronous: nothing for an Effect to wrap.
export function groupChecks(checks: Check[]): WidgetItem[] {
  if (checks.length === 0) return [];
  const groups = new Map<string, Check[]>();
  for (const check of checks) {
    const group = check.name.split(" (")[0]!;
    groups.set(group, [...(groups.get(group) ?? []), check]);
  }
  return [...groups].map(([name, members]): WidgetItem => {
    const states = members.map((c) => checkState(c.bucket));
    const state = states.includes("error")
      ? "error"
      : states.includes("pending")
        ? "pending"
        : states.includes("ok")
          ? "ok"
          : "none";
    const failed = states.filter((s) => s === "error").length;
    const running = states.filter((s) => s === "pending").length;
    return {
      label: name,
      detail: [
        `${members.length} check${members.length === 1 ? "" : "s"}`,
        failed ? `${failed} failing` : undefined,
        running ? `${running} running` : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
      state,
      url: members.length === 1 ? members[0]!.link : undefined,
      // A single check is its own row already; more than one is worth opening.
      children:
        members.length === 1
          ? undefined
          : members.map((c): WidgetItem => ({
              // The check named exactly like the group is the build as a whole; the rest are its
              // jobs, named by what is left after the group's name.
              label: c.name.slice(name.length).replace(/^ \(|\)$/g, "") || "overall",
              detail: c.state.toLowerCase(),
              url: c.link,
              state: checkState(c.bucket),
              progress: c.bucket === "pending" && c.startedAt ? { startedAt: c.startedAt } : undefined,
            })),
    };
  });
}
