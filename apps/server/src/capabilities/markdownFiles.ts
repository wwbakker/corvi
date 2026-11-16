/** The file operations behind the Actions and Subagents pages: what each scope holds, and writing
 * one Markdown file at a time.
 *
 * Files are the source of truth — saving writes its own file, and there is no page-wide draft.
 * Built-in files stay in the listing (they are the templates the create flow copies); a user file
 * shadows the shipped one while it exists. A file that does not parse is listed with its reasons
 * rather than hidden — the page is where it gets fixed.
 *
 * The two pages differ only in their directory name, their shipped directory and their parser; the
 * scope layout, the file-name rule, the owner-only write and the repository addressing are here.
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect } from "effect";

import { BadRequestError, InternalError } from "@corvi/contracts/errors";
import type { Change } from "@corvi/changes/record";
import { configPath, runtimeConfig } from "../workspace/server/index.ts";

/** The scopes a page lists, most specific first for discovery; this module only reads and writes. */
export type MarkdownScope = "builtin" | "global" | "workspace" | "repository";

type FileOrigin = {
  readonly workspace?: string;
  readonly workspaceLabel?: string;
  readonly repository?: string;
};

export type MarkdownFileEntry = {
  readonly scope: MarkdownScope;
  readonly workspace?: string;
  readonly workspaceLabel?: string;
  readonly repository?: string;
  readonly id: string;
  readonly path: string;
  readonly text: string;
  readonly label?: string;
  readonly problems?: readonly string[];
};

export type MarkdownFilesPage = {
  readonly workspaces: readonly { readonly id: string; readonly name: string }[];
  readonly files: readonly MarkdownFileEntry[];
};

export type MarkdownRepositoriesPage = {
  readonly repositories: readonly {
    readonly repository: string;
    readonly files: readonly MarkdownFileEntry[];
  }[];
};

/** What one document kind supplies: where its files live and how a file reads. */
export type MarkdownFilesOptions = {
  /** The directory under the config root and a checkout's `.corvi` ("actions", "subagents"). */
  readonly dirName: string;
  readonly builtinDir: () => string;
  /** What a well-formed file is: its label, or the reasons it is not one. */
  readonly parse: (text: string) => { readonly label?: string; readonly problems?: readonly string[] };
  /** A file that cannot be read: skip it (actions) or list it with that reason (profiles). */
  readonly unreadable: "skip" | "problem";
  /** Whether an empty file is skipped or listed as unparsed. */
  readonly empty: "skip" | "list";
  readonly repositoryRoots: (
    change: Change,
  ) => Effect.Effect<readonly { readonly name: string; readonly dir: string }[]>;
};

export type MarkdownFileStore = {
  readonly list: () => Effect.Effect<MarkdownFilesPage>;
  readonly write: (
    scope: "global" | "workspace",
    workspace: string | undefined,
    id: string,
    text: string,
  ) => Effect.Effect<MarkdownFilesPage, BadRequestError>;
  readonly remove: (
    scope: "global" | "workspace",
    workspace: string | undefined,
    id: string,
  ) => Effect.Effect<MarkdownFilesPage, BadRequestError>;
  readonly listRepositories: (change: Change) => Effect.Effect<MarkdownRepositoriesPage>;
  readonly writeRepository: (
    change: Change,
    repository: string,
    id: string,
    text: string,
  ) => Effect.Effect<MarkdownRepositoriesPage, BadRequestError>;
  readonly removeRepository: (
    change: Change,
    repository: string,
    id: string,
  ) => Effect.Effect<MarkdownRepositoriesPage, BadRequestError>;
};

/** The id is the filename: one word-shaped name, no path tricks. */
const FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const nameProblem = (id: string): BadRequestError =>
  new BadRequestError({ message: `"${id}" is not a file name Corvi can use` });

export const makeMarkdownFiles = (options: MarkdownFilesOptions): MarkdownFileStore => {
  const globalDir = (): string => join(dirname(configPath()), options.dirName);
  const workspaceDir = (id: string): string => join(dirname(configPath()), "workspaces", id, options.dirName);

  /** The directory a writable scope lives in; an unknown workspace is refused, not invented. */
  const dirFor = (
    scope: "global" | "workspace",
    workspace?: string,
  ): Effect.Effect<string, BadRequestError> =>
    Effect.gen(function* () {
      if (scope === "global") return globalDir();
      const found = runtimeConfig().workspaces.find((one) => one.id === workspace);
      if (!found) return yield* new BadRequestError({ message: `no such workspace: ${workspace ?? ""}` });
      return workspaceDir(found.id);
    });

  const parsedEntry = (
    text: string,
    base: { readonly scope: MarkdownScope; readonly id: string; readonly path: string } & FileOrigin,
  ): MarkdownFileEntry => {
    const parsed = options.parse(text);
    return {
      ...base,
      text,
      ...(parsed.label === undefined ? {} : { label: parsed.label }),
      ...(parsed.problems === undefined ? {} : { problems: parsed.problems }),
    };
  };

  /** Every `*.md` directly in one scope's directory. */
  const readScope = (
    dir: string,
    scope: MarkdownScope,
    origin: FileOrigin = {},
  ): Effect.Effect<readonly MarkdownFileEntry[]> =>
    Effect.gen(function* () {
      const names = yield* Effect.tryPromise({
        try: () => readdir(dir),
        catch: () => new InternalError({ message: `cannot read ${dir}` }),
      }).pipe(Effect.orElseSucceed(() => [] as string[]));
      const files: MarkdownFileEntry[] = [];
      for (const name of names.filter((one) => one.endsWith(".md")).sort()) {
        const path = join(dir, name);
        const read = yield* Effect.tryPromise({
          try: () => readFile(path, "utf8"),
          catch: () => new InternalError({ message: `cannot read ${path}` }),
        }).pipe(Effect.result);
        const id = name.slice(0, -3);
        if (read._tag === "Failure") {
          if (options.unreadable === "problem") {
            files.push({
              scope,
              ...origin,
              id,
              path,
              text: "",
              problems: ["cannot read this file"],
            });
          }
          continue;
        }
        if (read.success === "" && options.empty === "skip") continue;
        files.push(parsedEntry(read.success, { scope, ...origin, id, path }));
      }
      return files;
    });

  const list = (): Effect.Effect<MarkdownFilesPage> =>
    Effect.gen(function* () {
      const config = runtimeConfig();
      const files: MarkdownFileEntry[] = [];
      files.push(...(yield* readScope(options.builtinDir(), "builtin")));
      files.push(...(yield* readScope(globalDir(), "global")));
      for (const workspace of config.workspaces) {
        files.push(
          ...(yield* readScope(workspaceDir(workspace.id), "workspace", {
            workspace: workspace.id,
            workspaceLabel: workspace.name,
          })),
        );
      }
      return {
        workspaces: config.workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name })),
        files,
      };
    });

  const check = (id: string, text: string): Effect.Effect<void, BadRequestError> =>
    Effect.gen(function* () {
      if (!FILE_ID.test(id)) return yield* nameProblem(id);
      const parsed = options.parse(text);
      if (parsed.problems !== undefined && parsed.problems.length > 0) {
        return yield* new BadRequestError({ message: parsed.problems.join("; ") });
      }
    });

  const writeFileAt = (dir: string, id: string, text: string): Effect.Effect<void, BadRequestError> =>
    Effect.tryPromise({
      try: () =>
        mkdir(dir, { recursive: true }).then(() =>
          // Owner-only, like the config file: a file here can run anything or brief an agent.
          writeFile(join(dir, `${id}.md`), text, { mode: 0o600 }),
        ),
      catch: (error) => new BadRequestError({ message: String(error) }),
    });

  const removeFileAt = (dir: string, id: string): Effect.Effect<void, BadRequestError> =>
    Effect.tryPromise({
      try: () => rm(join(dir, `${id}.md`), { force: true }),
      catch: (error) => new BadRequestError({ message: String(error) }),
    });

  const write = (
    scope: "global" | "workspace",
    workspace: string | undefined,
    id: string,
    text: string,
  ): Effect.Effect<MarkdownFilesPage, BadRequestError> =>
    Effect.gen(function* () {
      const dir = yield* dirFor(scope, workspace);
      yield* check(id, text);
      yield* writeFileAt(dir, id, text);
      return yield* list();
    });

  const remove = (
    scope: "global" | "workspace",
    workspace: string | undefined,
    id: string,
  ): Effect.Effect<MarkdownFilesPage, BadRequestError> =>
    Effect.gen(function* () {
      const dir = yield* dirFor(scope, workspace);
      if (!FILE_ID.test(id)) return yield* nameProblem(id);
      yield* removeFileAt(dir, id);
      return yield* list();
    });

  /** One repository root as the change-scoped routes address it. */
  const repositoryBlocks = (
    change: Change,
  ): Effect.Effect<readonly { readonly repository: string; readonly dir: string }[]> =>
    Effect.map(options.repositoryRoots(change), (roots) =>
      roots.map((one) => ({ repository: one.name, dir: one.dir })),
    );

  const repositoryDirFor = (change: Change, repository: string): Effect.Effect<string, BadRequestError> =>
    Effect.gen(function* () {
      const found = (yield* repositoryBlocks(change)).find((one) => one.repository === repository);
      if (found === undefined) {
        return yield* new BadRequestError({
          message: `no such repository in this change: ${repository}`,
        });
      }
      return found.dir;
    });

  const listRepositories = (change: Change): Effect.Effect<MarkdownRepositoriesPage> =>
    Effect.gen(function* () {
      const repositories: { repository: string; files: readonly MarkdownFileEntry[] }[] = [];
      for (const root of yield* repositoryBlocks(change)) {
        repositories.push({
          repository: root.repository,
          files: yield* readScope(root.dir, "repository", { repository: root.repository }),
        });
      }
      return { repositories };
    });

  const writeRepository = (
    change: Change,
    repository: string,
    id: string,
    text: string,
  ): Effect.Effect<MarkdownRepositoriesPage, BadRequestError> =>
    Effect.gen(function* () {
      const dir = yield* repositoryDirFor(change, repository);
      yield* check(id, text);
      yield* writeFileAt(dir, id, text);
      return yield* listRepositories(change);
    });

  const removeRepository = (
    change: Change,
    repository: string,
    id: string,
  ): Effect.Effect<MarkdownRepositoriesPage, BadRequestError> =>
    Effect.gen(function* () {
      const dir = yield* repositoryDirFor(change, repository);
      if (!FILE_ID.test(id)) return yield* nameProblem(id);
      yield* removeFileAt(dir, id);
      return yield* listRepositories(change);
    });

  return { list, write, remove, listRepositories, writeRepository, removeRepository };
};
