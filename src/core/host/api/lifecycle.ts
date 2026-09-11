import type { Effect } from "effect";
import type { Config, Workspace as WorkspaceConfig } from "../../../config.ts";
import type { Change, CompletionStep } from "../../domain/change.ts";
import type { Capabilities } from "./capabilities.ts";

/** What a pure completion-plan function is handed, since it runs before anything does: the
 * plain data it may name a step from. Pure functions get plain data, not services. */
export type PlanWorld = { config: Config; workspace: WorkspaceConfig };

/** One step of completing a change, contributed alongside the core's own (merge the pull
 * requests, remove the worktrees, archive). Contributed steps run after the merges and
 * before the worktrees go, in registration order, and are journaled like every other step:
 * the plan is named before anything runs, and the outcome is written as it happens. */
export type CompletionStepContributor = {
  /** The step as the plan shows it while waiting, or undefined when this change has nothing
   * for it to do (no issue linked, say) — in which case `run` is not called either. */
  plan(change: Change, world: PlanWorld): CompletionStep | undefined;
  /** Do it. A returned string is recorded as the step's detail; a failure stops the
   * completion where it stands, exactly as a core step's failure does. */
  run(change: Change): Effect.Effect<string | void, unknown, Capabilities>;
};

/** The handlers an extension can hang off the change lifecycle. Grows per event, typed, when a
 * second consumer needs one. */
export type ExtensionEvents = {
  "change:created"?: ((change: Change) => Effect.Effect<void, unknown, Capabilities>)[];
};
