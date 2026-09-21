import { basename, join } from "node:path";
import { Effect } from "effect";

import { ChangeId } from "@corvi/contracts/changes";
import { ChangeWork, describeProvisionError } from "@corvi/workflows";
import {
  BadRequestError,
  ConflictError,
  isIweError,
  type IweError,
} from "../../capabilities/effect/errors.ts";
import { messageOf } from "../../capabilities/effect/support.ts";
import { copyTooling } from "../../capabilities/os.ts";
import { IDEATION, type Change, type ProvisionResult } from "../../domain/change.ts";
import { extensionsFor } from "../../integrations/index.ts";
import { capabilitiesLayer } from "../../integrations/services.ts";
import { moveIssueOnStart } from "../../extensions/jira/index.ts";
import { unlinkRepo, browseRepo } from "../../vendors/git.ts";
import { config, workspaceOf } from "../../workspace/server/index.ts";
import { changeWorkLayer } from "../lifecycle-layer.ts";
import { archiveRoot, changeDir, readChange, root, writeChange } from "./store.ts";

/**
 * Start an idea's work: leave `Ideation` for `In Progress`.
 *
 * The state move is all this does. What a start implies — creating each repository's checkout,
 * moving the ticket to In Progress — belongs to the `change:started` hooks, so the core never
 * learns what a ticket is, and a failure there is reported rather than undoing the start. That is
 * the same bargain creating a change makes: the record is written first and always survives.
 */
export const startChange = (change: Change): Effect.Effect<Change, ConflictError> =>
  Effect.gen(function* () {
    if (change.state !== IDEATION) {
      return yield* new ConflictError({
        message: `${change.id} has already started (${change.state ?? "In Progress"})`,
      });
    }
    const started: Change = { ...change, state: "In Progress" };
    yield* writeChange(started);
    return started;
  });

/** What a workflow start produced: the started record and the per-target report the page shows. */
export type Started = { readonly change: Change; readonly provision: ProvisionResult[] };

/** The transport boundary for a workflow error: conflicts stay conflicts, everything else is the
 * taxonomy the route mapper knows. */
const asIwe = (change: Change, error: unknown): IweError => {
  if (isIweError(error)) return error;
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tag = String((error as { _tag: unknown })._tag);
    const raw = "message" in error ? (error as { message: unknown }).message : undefined;
    if (tag === "InvalidTransition") {
      return new ConflictError({
        message: `${change.id} has already started (${change.state ?? "In Progress"})`,
      });
    }
    return new BadRequestError({ message: raw ? String(raw) : tag });
  }
  return new BadRequestError({ message: messageOf(error) });
};

/**
 * Start the work through the workflow: the phase moves, every checkout is provisioned by the
 * `repositories` capability, the browse links are dropped first (following one would make the
 * destination look like an existing checkout), and the configured tooling is copied into the
 * worktrees the start created. The extensions' `change:started` hooks still run afterwards — the
 * ticket move, the browse link an in-place checkout carries — and their failures are reported
 * as before, never fatal.
 */
export const startChangeWithWorkflow = (change: Change): Effect.Effect<Started, IweError> =>
  Effect.gen(function* () {
    const work = yield* ChangeWork;

    yield* Effect.forEach(change.repos, (repo) => unlinkRepo(change, repo), {
      concurrency: 1,
      discard: true,
    });

    const outcome = yield* work
      .startChange(ChangeId.make(change.id))
      .pipe(
        Effect.catchAll((error): Effect.Effect<never, IweError> => Effect.fail(asIwe(change, error))),
      );

    if (config.worktreeCopy.length > 0) {
      yield* Effect.forEach(
        outcome.repositories.filter(
          (repository) => repository.checkoutMethod === "UseNewLocationNewBranch",
        ),
        (repository) =>
          copyTooling(
            repository.originalLocation,
            join(changeDir(change.id), basename(repository.originalLocation)),
            config.worktreeCopy,
          ).pipe(
            Effect.catchAll((error) =>
              Effect.sync(() =>
                console.error(
                  `could not copy tooling into ${repository.directoryName}:`,
                  error,
                ),
              ),
            ),
          ),
        { concurrency: 1, discard: true },
      );
    }

    const updated = (yield* readChange(change.id)) ?? change;

    // An in-place checkout is linked from the change directory for reading; the worktree
    // methods already place their own directory.
    yield* Effect.forEach(
      outcome.repositories.filter(
        (repository) => repository.checkoutMethod !== "UseNewLocationNewBranch",
      ),
      (repository) => browseRepo(updated, repository.originalLocation),
      { concurrency: 1, discard: true },
    );

    const reports: ProvisionResult[] = [
      ...(outcome._tag === "PartiallyStarted"
        ? outcome.failures.map((failure) => ({
            integration: "git",
            ok: false,
            error: describeProvisionError(failure.error),
          }))
        : [{ integration: "git", ok: true }]),
    ];

    // The ticket move, called explicitly: the workspace's jira extension decides whether it
    // applies, and a failure is reported under its name like the hook's result was.
    const workspace = workspaceOf(updated);
    if (extensionsFor(workspace).some((extension) => extension.name === "jira")) {
      const moved = yield* moveIssueOnStart(updated).pipe(
        Effect.provide(capabilitiesLayer(workspace, "jira")),
        Effect.either,
      );
      reports.push(
        moved._tag === "Right"
          ? { integration: "jira", ok: true }
          : { integration: "jira", ok: false, error: messageOf(moved.left) },
      );
    }

    return { change: updated, provision: reports };
  }).pipe(
    Effect.provide(changeWorkLayer({ root: root(), archiveRoot: archiveRoot() })),
  );
