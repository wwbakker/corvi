/** The Subagents page's file operations: what each scope holds, and writing one file at a time.
 *
 * Files are the source of truth — saving a profile writes its own file, and there is no
 * page-wide draft to lose. Built-in files stay in the listing — they are the templates the
 * create flow copies — but the page shows no Built-in section, and a copy shadows the shipped
 * file while it exists. A file that does not parse — or cannot be read — is listed with its
 * reasons rather than hidden.
 *
 * Repository profiles are the change-scoped half (`repositorySubagentFiles` and friends): one
 * block per checkout, addressed by the repository name the discovery key carries, written and
 * deleted here like any other file.
 *
 * The per-scope reading is `@corvi/agents/node`'s, the same reader discovery uses, so the page
 * and the menu cannot disagree about what a file is; the repository roots are `run.ts`'s, the
 * same roots discovery walks. */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Either, Effect } from "effect";

import { builtinProfilesDir, readProfileScope } from "@corvi/agents/node";
import { parseProfileFile } from "@corvi/agents/profile";
import type {
  SubagentFileRefDto,
  SubagentFileWriteDto,
  SubagentFilesResponseDto,
  SubagentProfileFileDto,
  SubagentRepositoryFileRefDto,
  SubagentRepositoryFileWriteDto,
  SubagentRepositoryFilesResponseDto,
} from "@corvi/contracts/subagents";
import { BadRequestError } from "@corvi/contracts/errors";
import type { Change } from "../../domain/change.ts";
import { configPath, runtimeConfig } from "../../workspace/server/index.ts";
import { profileRootsFor } from "./run.ts";

/** The id is the filename: one word-shaped name, no path tricks. */
const FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const globalDir = (): string => join(dirname(configPath()), "subagents");

const workspaceDir = (id: string): string => join(dirname(configPath()), "workspaces", id, "subagents");

/** The directory a writable scope lives in; an unknown workspace is refused, not invented. */
const dirFor = (
  scope: SubagentFileWriteDto["scope"],
  workspace?: string,
): Effect.Effect<string, BadRequestError> =>
  Effect.gen(function* () {
    if (scope === "global") return globalDir();
    const found = runtimeConfig().workspaces.find((w) => w.id === workspace);
    if (!found) return yield* new BadRequestError({ message: `no such workspace: ${workspace ?? ""}` });
    return workspaceDir(found.id);
  });

/** Where a file came from, as the page's rows show it: the workspace id and label, or the
 * repository name. */
type FileOrigin = {
  readonly workspace?: string;
  readonly workspaceLabel?: string;
  readonly repository?: string;
};

/** One scope's directory, parsed for the page. A file that does not parse, or cannot be read, is
 * still listed, with its reasons. */
const listScope = (
  dir: string,
  scope: SubagentProfileFileDto["scope"],
  origin: FileOrigin = {},
): Effect.Effect<readonly SubagentProfileFileDto[]> =>
  Effect.map(readProfileScope(dir), (files) =>
    files.map((file): SubagentProfileFileDto => {
      if (!file.readable) {
        return {
          scope,
          ...origin,
          id: file.id,
          path: file.path,
          text: file.text,
          problems: ["cannot read this file"],
        };
      }
      const parsed = parseProfileFile(file.text);
      return {
        scope,
        ...origin,
        id: file.id,
        path: file.path,
        text: file.text,
        ...(Either.isRight(parsed) ? { label: parsed.right.label } : { problems: parsed.left.reasons }),
      };
    }),
  );

/** What the page lists: the shipped profiles, the global ones, and each workspace's own. */
export const subagentFiles = (): Effect.Effect<SubagentFilesResponseDto> =>
  Effect.gen(function* () {
    const config = runtimeConfig();
    const files: SubagentProfileFileDto[] = [];
    files.push(...(yield* listScope(builtinProfilesDir(), "builtin")));
    files.push(...(yield* listScope(globalDir(), "global")));
    for (const workspace of config.workspaces) {
      files.push(
        ...(yield* listScope(workspaceDir(workspace.id), "workspace", {
          workspace: workspace.id,
          workspaceLabel: workspace.name,
        })),
      );
    }
    return {
      workspaces: config.workspaces.map((w) => ({ id: w.id, name: w.name })),
      files,
    };
  });

/** Write one profile file, refusing anything that is not a profile. The id is the filename, so
 * it has to look like one. */
export const writeSubagentFile = (
  body: SubagentFileWriteDto,
): Effect.Effect<SubagentFilesResponseDto, BadRequestError> =>
  Effect.gen(function* () {
    const dir = yield* dirFor(body.scope, body.workspace);
    if (!FILE_ID.test(body.id)) {
      return yield* new BadRequestError({ message: `"${body.id}" is not a file name Corvi can use` });
    }
    const parsed = parseProfileFile(body.text);
    if (Either.isLeft(parsed)) {
      return yield* new BadRequestError({ message: parsed.left.reasons.join("; ") });
    }
    yield* Effect.tryPromise({
      try: () =>
        mkdir(dir, { recursive: true }).then(() =>
          // Owner-only, like the config file: a profile decides what an agent runs.
          writeFile(join(dir, `${body.id}.md`), body.text, { mode: 0o600 }),
        ),
      catch: (e) => new Error(String(e)),
    }).pipe(Effect.mapError((e) => new BadRequestError({ message: e.message })));
    return yield* subagentFiles();
  });

/** Delete one profile file. Deleting a shadowing copy brings the shipped profile back. */
export const deleteSubagentFile = (
  ref: SubagentFileRefDto,
): Effect.Effect<SubagentFilesResponseDto, BadRequestError> =>
  Effect.gen(function* () {
    const dir = yield* dirFor(ref.scope, ref.workspace);
    if (!FILE_ID.test(ref.id)) {
      return yield* new BadRequestError({ message: `"${ref.id}" is not a file name Corvi can use` });
    }
    yield* Effect.tryPromise({
      try: () => rm(join(dir, `${ref.id}.md`), { force: true }),
      catch: (e) => new Error(String(e)),
    }).pipe(Effect.mapError((e) => new BadRequestError({ message: e.message })));
    return yield* subagentFiles();
  });

// --- The repository scope, addressed by change and repository ---------------------------------

/** One repository root as the change-scoped routes address it: the repository name of the
 * discovery key, and its `.corvi/subagents` directory inside the checkout. */
const repositoryBlocks = (
  change: Change,
): Effect.Effect<readonly { readonly repository: string; readonly dir: string }[]> =>
  Effect.map(profileRootsFor(change), (roots) =>
    roots.repositories.map((one) => ({ repository: one.name, dir: one.dir })),
  );

/** The `.corvi/subagents` directory of one named checkout. A repository the change does not
 * carry — or one not checked out — is refused, never invented. */
const repositoryDirFor = (
  change: Change,
  repository: string,
): Effect.Effect<string, BadRequestError> =>
  Effect.gen(function* () {
    const found = (yield* repositoryBlocks(change)).find((one) => one.repository === repository);
    if (found === undefined) {
      return yield* new BadRequestError({ message: `no such repository in this change: ${repository}` });
    }
    return found.dir;
  });

/** The change's repository profiles, one block per checkout — what the Repositories view lists,
 * parsed exactly as the other scopes are. */
export const repositorySubagentFiles = (
  change: Change,
): Effect.Effect<SubagentRepositoryFilesResponseDto> =>
  Effect.gen(function* () {
    const repositories: { repository: string; files: readonly SubagentProfileFileDto[] }[] = [];
    for (const root of yield* repositoryBlocks(change)) {
      repositories.push({
        repository: root.repository,
        files: [...(yield* listScope(root.dir, "repository", { repository: root.repository }))],
      });
    }
    return { repositories };
  });

/** Write one repository profile file, refusing anything that is not a profile exactly as the
 * other scopes do. */
export const writeRepositorySubagentFile = (
  change: Change,
  body: SubagentRepositoryFileWriteDto,
): Effect.Effect<SubagentRepositoryFilesResponseDto, BadRequestError> =>
  Effect.gen(function* () {
    const dir = yield* repositoryDirFor(change, body.repository);
    if (!FILE_ID.test(body.id)) {
      return yield* new BadRequestError({ message: `"${body.id}" is not a file name Corvi can use` });
    }
    const parsed = parseProfileFile(body.text);
    if (Either.isLeft(parsed)) {
      return yield* new BadRequestError({ message: parsed.left.reasons.join("; ") });
    }
    yield* Effect.tryPromise({
      try: () =>
        mkdir(dir, { recursive: true }).then(() =>
          // Owner-only, like the config file: a profile decides what an agent runs.
          writeFile(join(dir, `${body.id}.md`), body.text, { mode: 0o600 }),
        ),
      catch: (e) => new Error(String(e)),
    }).pipe(Effect.mapError((e) => new BadRequestError({ message: e.message })));
    return yield* repositorySubagentFiles(change);
  });

/** Delete one repository profile file from its checkout. */
export const deleteRepositorySubagentFile = (
  change: Change,
  ref: SubagentRepositoryFileRefDto,
): Effect.Effect<SubagentRepositoryFilesResponseDto, BadRequestError> =>
  Effect.gen(function* () {
    const dir = yield* repositoryDirFor(change, ref.repository);
    if (!FILE_ID.test(ref.id)) {
      return yield* new BadRequestError({ message: `"${ref.id}" is not a file name Corvi can use` });
    }
    yield* Effect.tryPromise({
      try: () => rm(join(dir, `${ref.id}.md`), { force: true }),
      catch: (e) => new Error(String(e)),
    }).pipe(Effect.mapError((e) => new BadRequestError({ message: e.message })));
    return yield* repositorySubagentFiles(change);
  });
