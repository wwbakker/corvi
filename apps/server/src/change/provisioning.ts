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
import { Repositories } from "@corvi/repositories";
import { messageOf } from "../capabilities/effect/support.ts";
import { copyTooling } from "../capabilities/os.ts";
import { isIdeation, type Change, type ProvisionResult } from "../domain/change.ts";
import { browseRepo } from "../vendors/git.ts";
import { runtimeConfig } from "../workspace/server/index.ts";
import { repositoriesLayer } from "./lifecycle-layer.ts";
import { archiveRoot, changeDir, root } from "./server/store.ts";

const errorDetail = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : messageOf(error);

/**
 * Give the change its presence: browse it as an idea, or check it out as started work. A failure
 * stops the remaining repositories and is reported once under the `git` integration; creation
 * itself already happened and survives it.
 */
export const provisionChangeRepositories = (change: Change): Effect.Effect<ProvisionResult[]> =>
  Effect.gen(function* () {
    if (isIdeation(change)) {
      yield* Effect.forEach(change.repos, (repo) => browseRepo(change, repo), {
        concurrency: 1,
        discard: true,
      });
      return [{ integration: "git", ok: true }];
    }

    const repositories = yield* Repositories;
    for (const repo of change.repos) {
      const direct = change.direct?.includes(repo) ?? false;
      const base = change.base?.[repo];
      const checkout = join(changeDir(change.id), basename(repo));
      const work = direct
        ? repositories
            .provisionInPlace({
              source: AbsolutePath.make(repo),
              branch: change.branch,
              ...(base ? { base } : {}),
            })
            .pipe(Effect.asVoid)
        : repositories
            .provisionLinkedWorktree({
              source: AbsolutePath.make(repo),
              directory: AbsolutePath.make(checkout),
              branch: change.branch,
              ...(base ? { base } : {}),
            })
            .pipe(
              Effect.tap(() =>
                copyTooling(repo, checkout, runtimeConfig().worktreeCopy).pipe(
                  Effect.catchAll(() => Effect.void),
                ),
              ),
            );

      const attempt = yield* work.pipe(Effect.either);
      if (attempt._tag === "Left")
        return [{ integration: "git", ok: false, error: errorDetail(attempt.left) }];
    }
    return [{ integration: "git", ok: true }];
  }).pipe(
    Effect.provide(repositoriesLayer({ root: root(), archiveRoot: archiveRoot() })),
  );
