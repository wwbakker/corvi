/** Cancelling a change, through the lifecycle workflow.
 *
 * The app-level adapter keeps the HTTP-facing shape — the force question, the loose-end report,
 * the after-observer notices — while the orchestration, fresh safety rechecks, and journaling
 * live in `@corvi/workflows/lifecycle`. The extension veto still runs after the force question
 * and before anything irreversible, as it did before the cutover.
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
import { BadRequestError, NotFoundError, isIweError, type IweError } from "../../capabilities/effect/errors.ts";
import { messageOf } from "../../capabilities/effect/support.ts";
import type { Change } from "../../domain/change.ts";
import type { Workspace as WorkspaceShape } from "../../domain/config.ts";
import {
  afterChange,
  beforeChange,
  looseEndContributorsFor,
  type ProvisionResult,
} from "../../extension-host/index.ts";
import { capabilitiesLayer } from "../../extension-host/services.ts";
import { prLooseEnds } from "../../extensions/github/index.ts";
import { jiraLooseEnds } from "../../extensions/jira/index.ts";
import { includedLooseEndIntegrations } from "../included-integrations.ts";
import { workspaceOf } from "../../workspace/server/index.ts";
import { unlinkRepo } from "../../vendors/git.ts";
import { lifecycleLayer } from "../lifecycle-layer.ts";
import { archiveRoot, readChange, root } from "./store.ts";

/** Names of the repositories whose work would be lost, when that needs asking about first. */
export type NeedsForce = { _tag: "NeedsForce"; needsForce: string[] };
export type Cancelled = {
  _tag: "Done";
  change: Change;
  loose: string[];
  /** What the after-hooks reported, under each extension's name: collected, never fatal. */
  after: ProvisionResult[];
};

const isAcknowledgementCode = (
  code: LifecycleReason["code"],
): code is Acknowledgement["code"] =>
  code === "review-pending" ||
  code === "unpushed" ||
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

const namesOf = (links: readonly Repository[], reasons: readonly LifecycleReason[]): string[] =>
  reasons.map((reason) => {
    const link = links.find((entry) => entry.repositoryId === reason.subject?.repositoryId);
    return link?.directoryName ?? reason.text;
  });

const services = (
  workspace: WorkspaceShape,
  roots: { readonly root: string; readonly archiveRoot: string },
): Layer.Layer<ChangeLifecycle | ChangeRepositories> =>
  Layer.merge(
    changesNodeLayer.pipe(Layer.provide(storeLayer(roots))),
    lifecycleLayer(workspace, roots),
  )

/** The transport boundary for this operation: capability failures become the taxonomy the route
 * mapper knows; the workflow and capability errors stay typed behind it. */
const asIwe = (error: unknown): IweError => {
  if (isIweError(error)) return error;
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tag = String((error as { _tag: unknown })._tag);
    const raw = "message" in error ? (error as { message: unknown }).message : undefined;
    const message = raw ? String(raw) : tag;
    return tag === "ChangeNotFound" ? new NotFoundError({ message }) : new BadRequestError({ message });
  }
  return new BadRequestError({ message: messageOf(error) });
};;

export const cancelChange = (
  change: Change,
  force = false,
): Effect.Effect<Cancelled | NeedsForce, IweError> => {
  const workspace = workspaceOf(change);
  const roots = { root: root(), archiveRoot: archiveRoot() };
  return Effect.gen(function* () {
    const repositoryLinks = yield* ChangeRepositories;
    const lifecycle = yield* ChangeLifecycle;
    const changeId = ChangeId.make(change.id);
    const links = yield* repositoryLinks
      .listRepositories(changeId)
      .pipe(Effect.mapError((error) => new BadRequestError({ message: error.message })));

    // Fresh, and before anything is written: the acknowledgement question and the refusal are
    // decisions about whether to start, not a cancellation that started and stopped. Uncommitted
    // work refuses outright, even with force.
    const readiness = yield* lifecycle.assessCancellation(changeId);
    if (readiness._tag === "Blocked") {
      return yield* new BadRequestError({
        message: `${namesOf(links, readiness.reasons).join(", ")}: uncommitted changes, commit or revert them before cancelling`,
      });
    }
    if (readiness._tag === "AcknowledgementRequired" && !force)
      return { _tag: "NeedsForce", needsForce: namesOf(links, readiness.reasons) } satisfies NeedsForce;

    // The extensions' veto: after the question, before anything irreversible.
    yield* beforeChange("change:cancelling", change);

    // The change directory's browse links: an idea's symlinks are Corvi's own, so they go before
    // the checkout removal, which then finds nothing at that path rather than failing on a
    // directory Git does not know as a worktree. A real worktree is untouched by this.
    yield* Effect.forEach(change.repos, (repo) => unlinkRepo(change, repo), {
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
        return yield* new BadRequestError({ message: "the cancelled change could not be read back" });
      const after = yield* afterChange("change:cancelled", updated);
      return { _tag: "Done", change: updated, loose: [...outcome.loose], after } satisfies Cancelled;
    }
    if (outcome._tag === "NeedsAcknowledgement")
      return { _tag: "NeedsForce", needsForce: namesOf(links, outcome.reasons) } satisfies NeedsForce;
    return yield* new BadRequestError({
      message: `${namesOf(links, outcome.reasons).join(", ")}: uncommitted changes, commit or revert them before cancelling`,
    });
  }).pipe(
    Effect.catchAll((error) => Effect.fail(asIwe(error))),
    Effect.provide(services(workspace, roots)),
  );
};

/**
 * What cancelling deliberately leaves alone, said out loud.
 *
 * A cancelled change that quietly leaves an open pull request and a ticket in progress is a
 * change that comes back to you in a week as somebody else's question. The included integrations
 * are called by name, in load order (github's pull requests before jira's ticket); extensions
 * loaded from outside the repository still contribute through the registry until the platform is
 * removed, with the included names skipped so their lines are not said twice. A lookup that
 * fails contributes nothing: cancelling must never fail because a vendor is unreachable.
 */
export const looseEnds = (change: Change): Effect.Effect<string[]> =>
  Effect.map(
    Effect.all([
      Effect.catchAll(
        Effect.provide(prLooseEnds(change), capabilitiesLayer(workspaceOf(change), "github")),
        () => Effect.succeed([] as string[]),
      ),
      Effect.forEach(
        looseEndContributorsFor(workspaceOf(change)).filter(
          ({ name }) => !includedLooseEndIntegrations.includes(name),
        ),
        ({ name, contribution }) =>
          Effect.catchAll(
            Effect.provide(contribution.looseEnds(change), capabilitiesLayer(workspaceOf(change), name)),
            () => Effect.succeed([] as string[]),
          ),
        // Unbounded concurrency is deliberate: these contributors are independent.
        { concurrency: "unbounded" },
      ),
    ]),
    ([pullRequests, contributed]) => [
      ...pullRequests,
      ...jiraLooseEnds(change),
      ...contributed.flat(),
    ],
  );
