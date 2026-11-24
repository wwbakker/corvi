/** The harness profiles a selector may offer without resolving a generated environment per entry:
 * built-ins, global files, one workspace's files, and the harness profile files of the repositories a
 * wizard has chosen. Keys come from the same discovery the launch uses, so an offered key always
 * resolves. */
import { join } from "node:path";
import { basename, dirname, isAbsolute } from "node:path";
import { Effect, Result } from "effect";

import {
  describeHarnessProfileError,
  resolveHarnessProfileByKey,
} from "@corvi/agents/harness-profile-discovery";
import { discoverHarnessProfiles } from "@corvi/agents/node";
import { makeNodeShell } from "@corvi/shell/node";
import { childEnv } from "../../capabilities/env.ts";
import type {
  HarnessProfileChoicesResponseDto,
  HarnessProfileSummaryDto,
} from "@corvi/contracts/harness-profiles";
import { configPath } from "../../workspace/server/index.ts";

export type HarnessProfileChoicesQuery = {
  readonly workspace?: string;
  /** Source repository paths a wizard has chosen; their `.corvi/harnesses` is included. */
  readonly repositories: readonly string[];
  /** The subset whose checkout will be a fresh worktree. Those are filtered to files tracked in
   * the source repository; an in-place checkout resolves untracked files at launch, so it is not
   * filtered. */
  readonly trackedRepositories?: readonly string[];
};

const trackedShell = makeNodeShell({
  timeoutSeconds: () => 10,
  parallel: 2,
  environment: (base, extra) => childEnv(base, extra),
});

/** The harness-profile file ids tracked in the source repository: a fresh worktree carries committed
 * files, so a committed harness stays selectable and an untracked one cannot be promised. */
const trackedIds = (path: string): Effect.Effect<readonly string[]> =>
  Effect.gen(function* () {
    const result = yield* trackedShell
      .run(["git", "ls-files", "--", ".corvi/harnesses"], { cwd: path })
      .pipe(Effect.catch(() => Effect.succeed({ code: 1, stdout: "", stderr: "" })));
    return result.code === 0
      ? result.stdout
          .split("\n")
          .map((line) => basename(line.trim()))
          .filter((name) => name.endsWith(".md"))
          .map((name) => name.slice(0, -3))
      : [];
  });

export const harnessProfileChoices = (
  query: HarnessProfileChoicesQuery,
): Effect.Effect<HarnessProfileChoicesResponseDto> =>
  Effect.gen(function* () {
    // The wizard may name source checkouts; every one is absolute and addressed by its basename,
    // the same name launch discovery uses for the checkout.
    const repositories = query.repositories
      .filter((path) => isAbsolute(path) && path.trim() !== "")
      .map((path) => ({ name: basename(path), path }));
    const configDir = dirname(configPath());
    const discovery = yield* discoverHarnessProfiles({
      global: join(configDir, "harnesses"),
      workspaces:
        query.workspace === undefined
          ? []
          : [
              {
                id: query.workspace,
                label: query.workspace,
                dir: join(configDir, "workspaces", query.workspace, "harnesses"),
              },
            ],
      repositories: yield* Effect.forEach(repositories, (repository) =>
        Effect.map(
          (query.trackedRepositories ?? []).includes(repository.path)
            ? trackedIds(repository.path)
            : Effect.succeed(undefined),
          (include) => ({
            name: repository.name,
            dir: join(repository.path, ".corvi", "harnesses"),
            ...(include === undefined ? {} : { include }),
          }),
        ),
      ),
    });
    const profiles: HarnessProfileSummaryDto[] = discovery.profiles.map((found) => {
      const resolved = resolveHarnessProfileByKey(discovery, found.key);
      const base: HarnessProfileSummaryDto = {
        key: found.key,
        id: found.id,
        source: found.source,
        ...(found.sourceLabel === undefined ? {} : { sourceLabel: found.sourceLabel }),
        label: found.harnessProfile.label,
        ...(found.harnessProfile.harness === undefined ? {} : { harness: found.harnessProfile.harness }),
      };
      return Result.isSuccess(resolved)
        ? {
            ...base,
            ...(resolved.success.fields.model === undefined ? {} : { model: resolved.success.fields.model }),
            ...(resolved.success.fields.effort === undefined
              ? {}
              : { effort: resolved.success.fields.effort }),
          }
        : { ...base, problem: describeHarnessProfileError(resolved.failure) };
    });
    return {
      harnessProfiles: profiles,
      skipped: discovery.skipped.map((file) => ({ key: file.key, reasons: [...file.reasons] })),
    };
  });
