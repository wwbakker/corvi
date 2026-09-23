import { basename, join } from "node:path";
import { Effect } from "effect";

import { ChangeId } from "@corvi/contracts/changes";
import { ChangeWork, describeProvisionError } from "@corvi/workflows";
import {
  BadRequestError,
  ConflictError,
  isIweError,
  type IweError,
} from "@corvi/contracts/errors";
import { messageOf } from "../../capabilities/effect/support.ts";
import { copyTooling } from "../../capabilities/os.ts";
import { type Change, type ProvisionResult } from "../../domain/change.ts";
import { extensionsFor } from "../../integrations/selectors.ts";
import { capabilitiesLayer } from "../../integrations/services.ts";
import { moveIssueOnStart } from "@corvi/jira";
import { unlinkRepo, browseRepo } from "../../vendors/git.ts";
import { runtimeConfig, workspaceOf } from "../../workspace/server/index.ts";
import { changeWorkLayer } from "../lifecycle-layer.ts";
import { archiveRoot, changeDir, readChange, root } from "./store.ts";

/**
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
        message: `${change.id} has already started (${change.state ?? "Implementation"})`,
      });
    }
    // Our typed errors carry the sentence the user sees; the tag is a last resort for a
    // foreign tagged error, never the first choice — it would show the page the type name.
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

    yield* Effect.forEach(change.checkouts ?? [], (spec) => unlinkRepo(change, spec.path), {
      concurrency: 1,
      discard: true,
    });

    const outcome = yield* work
      .startChange(ChangeId.make(change.id))
      .pipe(
        Effect.catchAll((error): Effect.Effect<never, IweError> => Effect.fail(asIwe(change, error))),
      );

    if (runtimeConfig().worktreeCopy.length > 0) {
      yield* Effect.forEach(
        outcome.repositories.filter((repository) => repository.location === "new"),
        (repository) =>
          copyTooling(
            repository.originalLocation,
            join(changeDir(change.id), basename(repository.originalLocation)),
            runtimeConfig().worktreeCopy,
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

    // A checkout used in place is linked from the change directory for reading; the worktree
    // methods already place their own directory.
    yield* Effect.forEach(
      outcome.repositories.filter((repository) => repository.location === "original"),
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
