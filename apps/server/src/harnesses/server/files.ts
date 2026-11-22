/** The Harnesses page's file operations and the regeneration a save triggers.
 *
 * Files are the source of truth, like actions and subagent profiles: saving writes the file,
 * deleting removes it, and a file that does not parse is listed with its reasons. After a save the
 * harness environments the change currently uses are regenerated in place, so the next `pi` start
 * in an existing shell already has the new file; a launch regenerates again regardless.
 */
import { lstat } from "node:fs/promises";
import { Effect, Result } from "effect";

import { resolveHarnessByKey } from "@corvi/agents/harness-discovery";
import { generatedHarnessDir, harnessScopeRoot } from "@corvi/agents/harness-generation";
import { builtinHarnessesDir, generateHarness, listInstances } from "@corvi/agents/node";
import { parseHarnessFile } from "@corvi/agents/harness-file";
import { harnessKeyOf } from "@corvi/contracts/harnesses";
import type {
  HarnessFileDto,
  HarnessFileRefDto,
  HarnessFileWriteDto,
  HarnessFilesResponseDto,
  HarnessRepositoryFileRefDto,
  HarnessRepositoryFileWriteDto,
  HarnessRepositoryFilesResponseDto,
} from "@corvi/contracts/harnesses";
import type { BadRequestError } from "@corvi/contracts/errors";
import type { Change } from "@corvi/changes/record";
import { stateDir } from "@corvi/configuration/node";
import { changeDir, listChanges } from "../../change/server/index.ts";
import { subagentHarnessLaunch } from "./env.ts";
import { makeMarkdownFiles } from "../../capabilities/markdownFiles.ts";
import { harnessDiscoveryFor, harnessRootsFor, selectedHarnessKey } from "./selection.ts";

/** A listed harness with the discovery key a selector stores. */
const withKey = (file: {
  readonly scope: "builtin" | "global" | "workspace" | "repository";
  readonly workspace?: string;
  readonly repository?: string;
  readonly id: string;
}): HarnessFileDto =>
  ({
    ...file,
    key: harnessKeyOf(file.scope, file.scope === "workspace" ? file.workspace : file.repository, file.id),
  }) as HarnessFileDto;

const files = makeMarkdownFiles({
  dirName: "harnesses",
  builtinDir: builtinHarnessesDir,
  parse: (text) => {
    const parsed = parseHarnessFile(text);
    return Result.isSuccess(parsed) ? { label: parsed.success.label } : { problems: parsed.failure.reasons };
  },
  unreadable: "problem",
  empty: "list",
  repositoryRoots: (change) => Effect.map(harnessRootsFor(change), (roots) => roots.repositories),
});

/** The discovery key a saved file changes, so the environments that depend on it regenerate. */
const affectedKey = (scope: "global" | "workspace" | "repository", id: string, origin?: string): string =>
  harnessKeyOf(scope, origin, id);

/** Regenerate the user/subagent environments of every active change whose selection reaches one
 * of the saved files. Best-effort: a save must not fail because another change's environment
 * could not be written; the next launch tries again. */
const exists = (path: string): Effect.Effect<boolean> =>
  Effect.tryPromise(() => lstat(path)).pipe(
    Effect.map(() => true),
    Effect.catch(() => Effect.succeed(false)),
  );

/** Regenerate every environment the change currently has state for — the selected ones, dialog
 * windows on any harness, and pinned subagents' own overlay directories — plus any whose chain
 * reaches a saved file. Best-effort: a save must not fail because another environment could not be
 * written; the next launch tries again. */
const regenerateAffected = (keys: readonly string[]): Effect.Effect<void> =>
  Effect.gen(function* () {
    const affected = new Set(keys);
    const changes = yield* listChanges();
    for (const change of changes) {
      if (change.completedAt !== undefined) continue;
      const discovery = yield* harnessDiscoveryFor(change);
      const roots = yield* Effect.map(harnessRootsFor(change), (found) => found.bases);
      const selected = new Set([selectedHarnessKey(change, "user"), selectedHarnessKey(change, "subagents")]);
      for (const found of discovery.harnesses) {
        const resolved = resolveHarnessByKey(discovery, found.key);
        if (Result.isFailure(resolved)) continue;
        const harness = resolved.success;
        const dir = generatedHarnessDir(stateDir(), change.id, harness);
        const chainAffected = harness.chain.some((link) => affected.has(link.key));
        if (!selected.has(harness.key) && !chainAffected && !(yield* exists(dir))) continue;
        const scopeBase = harnessScopeRoot(harness, roots);
        yield* generateHarness({
          stateDir: stateDir(),
          changeId: change.id,
          harness,
          ...(scopeBase === undefined ? {} : { scopeBase }),
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() =>
              console.error(`could not regenerate harness "${harness.key}": ${error.message}`),
            ),
          ),
        );
      }
      // A subagent's environment is its pinned harness plus the profile's current overlay, in its
      // own directory; a save must reach those too.
      const records = yield* listInstances(changeDir(change)).pipe(Effect.catch(() => Effect.succeed([])));
      for (const record of records) {
        // A pinned subagent only depends on its harness's chain. A legacy record has no key: its
        // launch resolves the profile's harness (or the fallback chain), so regenerate it rather
        // than leave it stale.
        if (record.harnessKey !== undefined) {
          const pinned = resolveHarnessByKey(discovery, record.harnessKey);
          if (Result.isFailure(pinned) || !pinned.success.chain.some((link) => affected.has(link.key))) {
            continue;
          }
        }
        yield* subagentHarnessLaunch(change, record).pipe(
          Effect.catch((error) =>
            Effect.sync(() =>
              console.error(`could not regenerate subagent "${record.id}": ${error.message}`),
            ),
          ),
        );
      }
    }
  });

/** What the page lists: the shipped harnesses, the global ones, and each workspace's own. */
export const harnessFiles = (): Effect.Effect<HarnessFilesResponseDto> =>
  Effect.map(files.list(), (page) => ({
    ...page,
    files: page.files.map((file) => withKey(file)),
  })) as Effect.Effect<HarnessFilesResponseDto>;

/** Write one harness file, refusing anything that is not a harness. */
export const writeHarnessFile = (
  body: HarnessFileWriteDto,
): Effect.Effect<HarnessFilesResponseDto, BadRequestError> =>
  Effect.gen(function* () {
    const page = (yield* files.write(
      body.scope,
      body.workspace,
      body.id,
      body.text,
    )) as HarnessFilesResponseDto;
    yield* regenerateAffected([affectedKey(body.scope, body.id, body.workspace)]);
    return { ...page, files: page.files.map((file) => withKey(file)) } as HarnessFilesResponseDto;
  });

/** Delete one harness file. Deleting a shadowing copy brings the shipped one back. */
export const deleteHarnessFile = (
  ref: HarnessFileRefDto,
): Effect.Effect<HarnessFilesResponseDto, BadRequestError> =>
  Effect.gen(function* () {
    const page = yield* files.remove(ref.scope, ref.workspace, ref.id);
    yield* regenerateAffected([affectedKey(ref.scope, ref.id, ref.workspace)]);
    return { ...page, files: page.files.map((file) => withKey(file)) } as HarnessFilesResponseDto;
  });

/** The change's repository harness files, one block per checkout. */
const repositoryPage = (page: {
  readonly repositories: readonly {
    readonly repository: string;
    readonly files: readonly {
      readonly scope: "builtin" | "global" | "workspace" | "repository";
      readonly workspace?: string;
      readonly repository?: string;
      readonly id: string;
    }[];
  }[];
}): HarnessRepositoryFilesResponseDto => ({
  repositories: page.repositories.map((block) => ({
    ...block,
    files: block.files.map((file) => withKey({ ...file, repository: block.repository, scope: "repository" })),
  })),
});

export const repositoryHarnessFiles = (change: Change): Effect.Effect<HarnessRepositoryFilesResponseDto> =>
  files.listRepositories(change) as Effect.Effect<HarnessRepositoryFilesResponseDto>;

export const writeRepositoryHarnessFile = (
  change: Change,
  body: HarnessRepositoryFileWriteDto,
): Effect.Effect<HarnessRepositoryFilesResponseDto, BadRequestError> =>
  Effect.gen(function* () {
    const page = yield* files.writeRepository(change, body.repository, body.id, body.text);
    yield* regenerateAffected([affectedKey("repository", body.id, body.repository)]);
    return repositoryPage(page as never);
  });

export const deleteRepositoryHarnessFile = (
  change: Change,
  ref: HarnessRepositoryFileRefDto,
): Effect.Effect<HarnessRepositoryFilesResponseDto, BadRequestError> =>
  Effect.gen(function* () {
    const page = yield* files.removeRepository(change, ref.repository, ref.id);
    yield* regenerateAffected([affectedKey("repository", ref.id, ref.repository)]);
    return repositoryPage(page as never);
  });
