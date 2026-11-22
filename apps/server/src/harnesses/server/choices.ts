/** The harnesses a selector may offer without resolving a generated environment per entry:
 * built-ins, global files, one workspace's files, and the harness files of the repositories a
 * wizard has chosen. Keys come from the same discovery the launch uses, so an offered key always
 * resolves. */
import { join } from "node:path";
import { basename, dirname, isAbsolute } from "node:path";
import { Effect, Result } from "effect";

import { describeHarnessError, resolveHarnessByKey } from "@corvi/agents/harness-discovery";
import { discoverHarnesses } from "@corvi/agents/node";
import { makeNodeShell } from "@corvi/shell/node";
import { childEnv } from "../../capabilities/env.ts";
import type { HarnessChoicesResponseDto, HarnessSummaryDto } from "@corvi/contracts/harnesses";
import { configPath } from "../../workspace/server/index.ts";

export type HarnessChoicesQuery = {
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

/** The harness file ids tracked in the source repository: a fresh worktree carries committed
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

export const harnessChoices = (query: HarnessChoicesQuery): Effect.Effect<HarnessChoicesResponseDto> =>
  Effect.gen(function* () {
    // The wizard may name source checkouts; every one is absolute and addressed by its basename,
    // the same name launch discovery uses for the checkout.
    const repositories = query.repositories
      .filter((path) => isAbsolute(path) && path.trim() !== "")
      .map((path) => ({ name: basename(path), path }));
    const configDir = dirname(configPath());
    const discovery = yield* discoverHarnesses({
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
    const harnesses: HarnessSummaryDto[] = discovery.harnesses.map((found) => {
      const resolved = resolveHarnessByKey(discovery, found.key);
      const base: HarnessSummaryDto = {
        key: found.key,
        id: found.id,
        source: found.source,
        ...(found.sourceLabel === undefined ? {} : { sourceLabel: found.sourceLabel }),
        label: found.harness.label,
        ...(found.harness.agent === undefined ? {} : { agent: found.harness.agent }),
      };
      return Result.isSuccess(resolved)
        ? {
            ...base,
            ...(resolved.success.fields.model === undefined ? {} : { model: resolved.success.fields.model }),
            ...(resolved.success.fields.effort === undefined
              ? {}
              : { effort: resolved.success.fields.effort }),
          }
        : { ...base, problem: describeHarnessError(resolved.failure) };
    });
    return {
      harnesses,
      skipped: discovery.skipped.map((file) => ({ key: file.key, reasons: [...file.reasons] })),
    };
  });
