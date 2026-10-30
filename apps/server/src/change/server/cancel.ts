/** Cancelling a change, through the lifecycle workflow.
 *
 * The app-level adapter keeps the HTTP-facing shape — the force question, the loose-end
 * report — while the orchestration, fresh safety rechecks, and journaling live in
 * `@corvi/workflows/lifecycle`.
 */
import { Effect, Layer } from "effect";

import { layer as changesNodeLayer, storeLayer } from "@corvi/changes/node";
import { ChangeRepositories } from "@corvi/changes/repositories";
import { ChangeId, type Repository } from "@corvi/contracts/changes";
import {
  ChangeLifecycle,
  type Acknowledgement,
  type LifecycleReason,
  type Readiness,
} from "@corvi/workflows/lifecycle";
import {
  BadRequestError,
  InternalError,
  NotFoundError,
  isIweError,
  type IweError,
} from "@corvi/contracts/errors";
import { messageOf } from "../../capabilities/effect/support.ts";
import type { Change } from "@corvi/changes/record";
import type { Workspace as WorkspaceShape } from "@corvi/configuration/config";
import { workspaceOf } from "../../workspace/server/index.ts";
import { unlinkRepo } from "../../vendors/git.ts";
import type { ForceReason } from "../provisioning.ts";
import { lifecycleLayer } from "../lifecycle-layer.ts";
import { changePairs, readChange, type ChangeRoots } from "./store.ts";

/** Names of the repositories whose work would be lost, when that needs asking about first, and
 * what that work is. */
export type NeedsForce = { _tag: "NeedsForce"; needsForce: string[]; reasons: ForceReason[] };
export type Cancelled = {
  _tag: "Done";
  change: Change;
  loose: string[];
};

const isAcknowledgementCode = (
  code: LifecycleReason["code"],
): code is Acknowledgement["code"] =>
  code === "review-pending" ||
  code === "unpushed" ||
  code === "untracked" ||
  code === "ownership-unverified" ||
  code === "shared-worktree" ||
  code === "provider-veto";

const acknowledgementsFor = (readiness: Readiness): readonly Acknowledgement[] =>
  readiness._tag === "Ready"
    ? []
    : readiness.reasons.flatMap((reason) =>
        reason.kind === "forceable" && isAcknowledgementCode(reason.code)
          ? [{ code: reason.code, subject: reason.subject, facts: reason.facts }]
          : [],
      );

const repositoryOf = (links: readonly Repository[], reason: LifecycleReason): string | undefined =>
  links.find((entry) => entry.repositoryId === reason.subject?.repositoryId)?.directoryName;

const needsForce = (links: readonly Repository[], reasons: readonly LifecycleReason[]): NeedsForce => {
  const said = reasons.map((reason) => ({
    repository: repositoryOf(links, reason) ?? "",
    text: reason.text,
  }));
  return {
    _tag: "NeedsForce",
    needsForce: [...new Set(said.map((reason) => reason.repository).filter(Boolean))],
    reasons: said,
  };
};

/** The refusal's sentence: each hard reason in its own words, with the repository it is about. */
const refusal = (links: readonly Repository[], reasons: readonly LifecycleReason[]): BadRequestError =>
  new BadRequestError({
    message: reasons
      .filter((reason) => reason.kind === "hard")
      .map((reason) => {
        const repository = repositoryOf(links, reason);
        const text =
          reason.code === "dirty-worktree"
            ? `${reason.text} — commit or revert them before cancelling`
            : reason.text;
        return repository ? `${repository}: ${text}` : text;
      })
      .join("; "),
  });

const services = (
  workspace: WorkspaceShape,
  roots: readonly ChangeRoots[],
): Layer.Layer<ChangeLifecycle | ChangeRepositories> =>
  Layer.merge(
    changesNodeLayer.pipe(Layer.provide(storeLayer({ roots }))),
    lifecycleLayer(workspace, roots),
  )

/** The transport boundary for this operation: capability failures become the taxonomy the route
 * mapper knows; the workflow and capability errors stay typed behind it. */
const asIwe = (error: unknown): IweError => {
  if (isIweError(error)) return error;
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tag = String((error as { _tag: unknown })._tag);
    const raw = "message" in error ? (error as { message: unknown }).message : undefined;
    // Our typed errors carry the sentence the user sees; the tag is a last resort for a
    // foreign tagged error, never the first choice — it would show the page the type name.
    const message = raw ? String(raw) : tag;
    return tag === "ChangeNotFound" ? new NotFoundError({ message }) : new BadRequestError({ message });
  };
  return new BadRequestError({ message: messageOf(error) });
};

export const cancelChange = (
  change: Change,
  force = false,
): Effect.Effect<Cancelled | NeedsForce, IweError> => {
  const workspace = workspaceOf(change);
  const roots = changePairs();
  return Effect.gen(function* () {
    const repositoryLinks = yield* ChangeRepositories;
    const lifecycle = yield* ChangeLifecycle;
    const changeId = ChangeId.make(change.id);
    const links = yield* repositoryLinks
      .listRepositories(changeId)
      .pipe(Effect.mapError((error) => new BadRequestError({ message: error.message })));

    // Fresh, and before anything is written: the acknowledgement question and the refusal are
    // decisions about whether to start, not a cancellation that started and stopped. Uncommitted
    // changes to tracked files refuse outright, even with force.
    const readiness = yield* lifecycle.assessCancellation(changeId);
    if (readiness._tag === "Blocked") return yield* refusal(links, readiness.reasons);
    if (readiness._tag === "AcknowledgementRequired" && !force) return needsForce(links, readiness.reasons);

    // The change directory's browse links: an idea's symlinks are Corvi's own, so they go before
    // the checkout removal, which then finds nothing at that path rather than failing on a
    // directory Git does not know as a worktree. A real worktree is untouched by this.
    yield* Effect.forEach(change.checkouts ?? [], (spec) => unlinkRepo(change, spec.path), {
      concurrency: 1,
      discard: true,
    });

    const outcome = yield* lifecycle.cancelChange({
      changeId,
      acknowledgements: acknowledgementsFor(readiness),
    });
    if (outcome._tag === "Done") {
      const updated = yield* readChange(change.id);
      if (!updated)
        return yield* new InternalError({ message: "the cancelled change could not be read back" });
      return { _tag: "Done", change: updated, loose: [...outcome.loose] } satisfies Cancelled;
    }
    if (outcome._tag === "NeedsAcknowledgement") return needsForce(links, outcome.reasons);
    return yield* refusal(links, outcome.reasons);
  }).pipe(
    Effect.mapError(asIwe),
    Effect.provide(services(workspace, roots)),
  );
};

