/** Provisioning a freshly created change, explicitly.
 *
 * An idea gets a browse
 * symlink per repository, a started creation gets the real checkout. The Git work goes through
 * the `repositories` capability; the link, the tooling copy, and the per-integration report stay
 * here, where the change directory and the configured tooling live.
 */
import { basename, join } from "node:path";
import { Effect } from "effect";

import { AbsolutePath } from "@corvi/contracts/paths";
import { Repositories, type CheckoutError, type NotARepository } from "@corvi/repositories";
import { messageOf } from "../capabilities/effect/support.ts";
import { copyTooling } from "../capabilities/os.ts";
import { isIdeation, type Change, type CheckoutSpec, type ProvisionResult } from "../domain/change.ts";
import { browseRepo } from "../vendors/git.ts";
import { runtimeConfig } from "../workspace/server/index.ts";
import { repositoriesLayer } from "./lifecycle-layer.ts";
import { archiveRoot, changeDir, root } from "./server/store.ts";

const errorDetail = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : messageOf(error);

/** This change's checkout work for one spec — the same matrix `change-work.ts` applies on
 * start: adopting the checkout's current branch is nothing at all, a created branch may be
 * made, an existing one is only ever attached. */
const provisionSpec = (
  change: Change,
  spec: CheckoutSpec,
): Effect.Effect<void, NotARepository | CheckoutError, Repositories> =>
  Effect.gen(function* () {
    const repositories = yield* Repositories;
    const source = AbsolutePath.make(spec.path);
    if (spec.branch.kind === "current") return;
    const branch = spec.branch.kind === "existing" ? spec.branch.name : change.branch;
    const createMissing = spec.branch.kind === "change";
    if (spec.location === "original") {
      yield* repositories
        .provisionInPlace({
          source,
          branch,
          createMissing,
          ...(createMissing && spec.base ? { base: spec.base } : {}),
        })
        .pipe(Effect.asVoid);
      return;
    }
    const checkout = join(changeDir(change.id), basename(spec.path));
    yield* repositories.provisionLinkedWorktree({
      source,
      directory: AbsolutePath.make(checkout),
      branch,
      createMissing,
      ...(createMissing && spec.base ? { base: spec.base } : {}),
    });
    yield* copyTooling(spec.path, checkout, runtimeConfig().worktreeCopy).pipe(
      Effect.catchAll(() => Effect.void),
    );
  });

/**
 * Give the change its presence: browse it as an idea, or check it out as started work. A failure
 * stops the remaining repositories and is reported once under the `git` integration; creation
 * itself already happened and survives it.
 */
export const provisionChangeRepositories = (change: Change): Effect.Effect<ProvisionResult[]> =>
  Effect.gen(function* () {
    const checkouts = change.checkouts ?? [];
    if (isIdeation(change)) {
      yield* Effect.forEach(checkouts, (spec) => browseRepo(change, spec.path), {
        concurrency: 1,
        discard: true,
      });
      return [{ integration: "git", ok: true }];
    }

    for (const spec of checkouts) {
      const attempt = yield* provisionSpec(change, spec).pipe(Effect.either);
      if (attempt._tag === "Left")
        return [{ integration: "git", ok: false, error: errorDetail(attempt.left) }];
      // A checkout used where it is is linked from the change directory for reading; the
      // worktree method already places its own directory.
      if (spec.location === "original") yield* browseRepo(change, spec.path);
    }
    return [{ integration: "git", ok: true }];
  }).pipe(
    Effect.provide(repositoriesLayer({ root: root(), archiveRoot: archiveRoot() })),
  );
