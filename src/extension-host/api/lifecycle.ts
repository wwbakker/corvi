import type { Effect } from "effect";
import type { Config, Workspace as WorkspaceConfig } from "../../domain/config.ts";
import type { Change, ChangeDraft, CompletionStep } from "../../domain/change.ts";
import type { Capabilities, CreatingCapabilities } from "./capabilities.ts";

export type { ChangeDraft } from "../../domain/change.ts";

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

/** A before-hook for an operation that has no draft to patch (completing, cancelling): it sees
 * the change and either lets the operation through or fails to veto it. It runs before any
 * irreversible step — the merges, the worktree removal — so a veto leaves nothing behind. */
export type ChangeBeforeHook = (change: Change) => Effect.Effect<void, unknown, Capabilities>;

/** An after-hook: it observes a change the core has already committed (change.json written,
 * and archived for the finished states). A failure is reported under the extension's name and
 * never fails the operation, exactly as `change:created` provisioning behaves. */
export type ChangeAfterHook = (change: Change) => Effect.Effect<void, unknown, Capabilities>;

/** A creation before-hook: it sees the plain draft and may return a patch, or nothing to leave
 * it alone. Hooks run in extension load order and chain — each sees the previous hook's
 * result. Failing vetoes the create; the core applies the final draft and then re-runs every
 * invariant before writing, so an extension may suggest, never bypass. */
export type ChangeCreatingHook = (
  draft: ChangeDraft,
) => Effect.Effect<Partial<ChangeDraft> | void, unknown, CreatingCapabilities>;

/** The handlers an extension can hang off the change lifecycle, one pair per moment — a
 * before that may transform or veto, and an after that only observes. `change:creating` has no
 * opposite draft to observe, so it pairs with `change:created` (the worktree provisioning).
 *
 * Planned completion steps are deliberately not here: they stay on `completionSteps`, where
 * they are planned up front, journaled and ordered inside the completion, rather than being a
 * second way to hang work off the same moment. */
export type ExtensionEvents = {
  "change:creating"?: ChangeCreatingHook[];
  "change:created"?: ChangeAfterHook[];
  /** After an idea's work has started: the change left `Ideation` for `In Progress`, and its
   * repositories are provisioned. The git extension creates the worktrees here, and a vendor
   * that tracks the ticket moves it. It is separate from `change:created` because creating an
   * idea must not start anything — no branch, no worktree, no ticket transition. */
  "change:started"?: ChangeAfterHook[];
  "change:completing"?: ChangeBeforeHook[];
  "change:completed"?: ChangeAfterHook[];
  "change:cancelling"?: ChangeBeforeHook[];
  "change:cancelled"?: ChangeAfterHook[];
};
