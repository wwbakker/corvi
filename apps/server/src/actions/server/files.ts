/** The Actions page's file operations: what each scope holds, and writing one file at a time.
 *
 * Files are the source of truth — saving an action writes its own file, and there is no
 * page-wide draft to lose. Built-in files stay in the listing — they are the templates the
 * create flow copies — but the page shows no Built-in section, and a copy shadows the shipped
 * file while it exists. A file that does not parse is listed with its reasons rather than
 * hidden — the page is where it gets fixed.
 *
 * The brief's built-in entry shows the text that actually runs: the legacy `ideationPrompt`
 * setting overrides its body while no `brief.md` shadows it, and a copy of it — the template
 * the picker offers — preserves what the user has been sending.
 *
 * Repository actions are the change-scoped half (`repositoryActionFiles` and friends): one block
 * per checkout, addressed by the repository name the discovery key carries, written and deleted
 * here like any other file. */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Either, Effect } from "effect";

import { parseActionFile, splitFrontmatter } from "@corvi/actions/model";
import { builtinActionsDir } from "@corvi/actions/node";
import type {
  ActionFileDto,
  ActionFileRefDto,
  ActionFileWriteDto,
  ActionFilesResponseDto,
  ActionRepositoryFileRefDto,
  ActionRepositoryFileWriteDto,
  ActionRepositoryFilesResponseDto,
} from "@corvi/contracts/actions";
import { BadRequestError } from "@corvi/contracts/errors";
import type { Change } from "@corvi/changes/record";
import { configPath, runtimeConfig, settingsOf } from "../../workspace/server/index.ts";
import { actionRootsFor } from "./run.ts";

/** The id is the filename: one word-shaped name, no path tricks. */
const FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const globalDir = (): string => join(dirname(configPath()), "actions");

const workspaceDir = (id: string): string => join(dirname(configPath()), "workspaces", id, "actions");

/** The directory a writable scope lives in; an unknown workspace is refused, not invented. */
const dirFor = (
  scope: ActionFileWriteDto["scope"],
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

/** Every `*.md` directly in one scope's directory, parsed for the page. A file that does not
 * parse is still listed, with its reasons. */
const readScope = (
  dir: string,
  scope: ActionFileDto["scope"],
  origin: FileOrigin = {},
): Effect.Effect<readonly ActionFileDto[]> =>
  Effect.gen(function* () {
    const names = yield* Effect.tryPromise({
      try: () => readdir(dir),
      catch: () => new Error(`cannot read ${dir}`),
    }).pipe(Effect.catchAll(() => Effect.succeed([] as string[])));
    const files: ActionFileDto[] = [];
    for (const name of names.filter((n) => n.endsWith(".md")).sort()) {
      const text = yield* Effect.tryPromise({
        try: () => readFile(join(dir, name), "utf8"),
        catch: () => new Error(`cannot read ${join(dir, name)}`),
      }).pipe(Effect.catchAll(() => Effect.succeed("")));
      if (text === "") continue;
      const parsed = parseActionFile(text);
      files.push({
        scope,
        ...origin,
        id: name.slice(0, -3),
        path: join(dir, name),
        text,
        ...(Either.isRight(parsed)
          ? { label: parsed.right.label }
          : { problems: parsed.left.reasons }),
      });
    }
    return files;
  });

/** What the page lists: the shipped files, the global ones, and each workspace's own. */
export const actionFiles = (): Effect.Effect<ActionFilesResponseDto> =>
  Effect.gen(function* () {
    const config = runtimeConfig();
    const files: ActionFileDto[] = [];
    files.push(...(yield* readScope(builtinActionsDir(), "builtin")));
    files.push(...(yield* readScope(globalDir(), "global")));
    for (const workspace of config.workspaces) {
      files.push(
        ...(yield* readScope(workspaceDir(workspace.id), "workspace", {
          workspace: workspace.id,
          workspaceLabel: workspace.name,
        })),
      );
    }
    // The built-in brief shows the text that runs today: the legacy `ideationPrompt` — resolved
    // in the global scope — overrides its body while no user `brief.md` shadows it. The picker
    // previews and copies exactly this, so a copy carries what you have been sending — frontmatter
    // and all. (A workspace's own `ideationPrompt` overrides that scope's briefing in turn.)
    const shadowed = files.some((f) => f.id === "brief" && f.scope !== "builtin");
    const override = settingsOf().ideationPrompt;
    const builtIn = files.find((f) => f.id === "brief" && f.scope === "builtin");
    const split = builtIn === undefined ? undefined : splitFrontmatter(builtIn.text);
    if (!shadowed && override !== "" && builtIn && split) {
      files[files.indexOf(builtIn)] = {
        ...builtIn,
        text: `---\n${split.frontmatter}\n---\n${override}`,
      };
    }
    return {
      workspaces: config.workspaces.map((w) => ({ id: w.id, name: w.name })),
      files,
    };
  });

/** Write one action file, refusing anything that is not an action. The id is the filename, so
 * it has to look like one. */
export const writeActionFile = (
  body: ActionFileWriteDto,
): Effect.Effect<ActionFilesResponseDto, BadRequestError> =>
  Effect.gen(function* () {
    const dir = yield* dirFor(body.scope, body.workspace);
    if (!FILE_ID.test(body.id)) {
      return yield* new BadRequestError({ message: `"${body.id}" is not a file name Corvi can use` });
    }
    const parsed = parseActionFile(body.text);
    if (Either.isLeft(parsed)) {
      return yield* new BadRequestError({ message: parsed.left.reasons.join("; ") });
    }
    yield* Effect.tryPromise({
      try: () =>
        mkdir(dir, { recursive: true }).then(() =>
          // Owner-only, like the config file: an action can run anything.
          writeFile(join(dir, `${body.id}.md`), body.text, { mode: 0o600 }),
        ),
      catch: (e) => new Error(String(e)),
    }).pipe(
      Effect.mapError((e) => new BadRequestError({ message: e.message })),
    );
    return yield* actionFiles();
  });

/** Delete one action file. Deleting a shadowing `brief.md` brings the built-in brief back. */
export const deleteActionFile = (
  ref: ActionFileRefDto,
): Effect.Effect<ActionFilesResponseDto, BadRequestError> =>
  Effect.gen(function* () {
    const dir = yield* dirFor(ref.scope, ref.workspace);
    if (!FILE_ID.test(ref.id)) {
      return yield* new BadRequestError({ message: `"${ref.id}" is not a file name Corvi can use` });
    }
    yield* Effect.tryPromise({
      try: () => rm(join(dir, `${ref.id}.md`), { force: true }),
      catch: (e) => new Error(String(e)),
    }).pipe(Effect.mapError((e) => new BadRequestError({ message: e.message })));
    return yield* actionFiles();
  });

// --- The repository scope, addressed by change and repository ---------------------------------

/** One repository root as the change-scoped routes address it: the repository name of the
 * discovery key, and its `.corvi/actions` directory inside the checkout. */
const repositoryBlocks = (
  change: Change,
): Effect.Effect<readonly { readonly repository: string; readonly dir: string }[]> =>
  Effect.map(actionRootsFor(change), (roots) =>
    roots.repositories.map((one) => ({ repository: one.name, dir: one.dir })),
  );

/** The `.corvi/actions` directory of one named checkout. A repository the change does not carry
 * — or one not checked out — is refused, never invented. */
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

/** The change's repository actions, one block per checkout — what the Repositories view lists,
 * parsed exactly as the other scopes are. */
export const repositoryActionFiles = (
  change: Change,
): Effect.Effect<ActionRepositoryFilesResponseDto> =>
  Effect.gen(function* () {
    const repositories: { repository: string; files: readonly ActionFileDto[] }[] = [];
    for (const root of yield* repositoryBlocks(change)) {
      repositories.push({
        repository: root.repository,
        files: [...(yield* readScope(root.dir, "repository", { repository: root.repository }))],
      });
    }
    return { repositories };
  });

/** Write one repository action file, refusing anything that is not an action exactly as the
 * other scopes do. */
export const writeRepositoryActionFile = (
  change: Change,
  body: ActionRepositoryFileWriteDto,
): Effect.Effect<ActionRepositoryFilesResponseDto, BadRequestError> =>
  Effect.gen(function* () {
    const dir = yield* repositoryDirFor(change, body.repository);
    if (!FILE_ID.test(body.id)) {
      return yield* new BadRequestError({ message: `"${body.id}" is not a file name Corvi can use` });
    }
    const parsed = parseActionFile(body.text);
    if (Either.isLeft(parsed)) {
      return yield* new BadRequestError({ message: parsed.left.reasons.join("; ") });
    }
    yield* Effect.tryPromise({
      try: () =>
        mkdir(dir, { recursive: true }).then(() =>
          // Owner-only, like the config file: an action can run anything.
          writeFile(join(dir, `${body.id}.md`), body.text, { mode: 0o600 }),
        ),
      catch: (e) => new Error(String(e)),
    }).pipe(Effect.mapError((e) => new BadRequestError({ message: e.message })));
    return yield* repositoryActionFiles(change);
  });

/** Delete one repository action file from its checkout. */
export const deleteRepositoryActionFile = (
  change: Change,
  ref: ActionRepositoryFileRefDto,
): Effect.Effect<ActionRepositoryFilesResponseDto, BadRequestError> =>
  Effect.gen(function* () {
    const dir = yield* repositoryDirFor(change, ref.repository);
    if (!FILE_ID.test(ref.id)) {
      return yield* new BadRequestError({ message: `"${ref.id}" is not a file name Corvi can use` });
    }
    yield* Effect.tryPromise({
      try: () => rm(join(dir, `${ref.id}.md`), { force: true }),
      catch: (e) => new Error(String(e)),
    }).pipe(Effect.mapError((e) => new BadRequestError({ message: e.message })));
    return yield* repositoryActionFiles(change);
  });
