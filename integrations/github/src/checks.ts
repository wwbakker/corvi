import { Effect, Schema } from "effect";
import type { ChangeWireDto as Change } from "@corvi/contracts/api";
import type { WidgetItemDto as WidgetItem, WidgetStateDto as WidgetState } from "@corvi/contracts/api";
import { Cache, Changes, GitFacts, Shell, Workspace } from "@corvi/contracts/capabilities";
import { cliJson } from "@corvi/shell/cli";
import type { Result } from "@corvi/contracts/capabilities";

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

/** The Result-branching contract: the one failure `Shell` can raise here is a timeout, which
 * surfaces as a failed command (exit code 124) rather than a failure of the operation, so
 * everything downstream branches on `code`. */
const shResult = (cmd: string[], cwd?: string): Effect.Effect<Result, never, Shell | Workspace> =>
  Effect.gen(function* () {
    const shell = yield* Shell;
    return yield* shell.run(cmd, { cwd }).pipe(
      Effect.catchAll((e) => Effect.succeed({ code: e.exitCode, stdout: "", stderr: e.stderr })),
    );
  });

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
    return yield* cache.swr(
      `gh:checks:${repo}:${number}`,
      15_000,
      Effect.gen(function* () {
        const worktree = (yield* worktreeOf(change, repo)) ?? repo;
        // Non-zero means "something is failing or pending", which is a result, not an error.
        const r = yield* shResult(
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
      }),
    );
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
