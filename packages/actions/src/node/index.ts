/** The file system half of discovery: the directories a change's actions live in, read fresh on
 * every call so an edit or a new file needs no restart. OS access stays behind this adapter
 * entrypoint; the vocabulary and the precedence rules are pure (`../discovery`, `../model`).
 *
 * A directory that is missing or unreadable is simply no actions from it — the three scopes a
 * user has not set up must not look like an error. */
import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";

import {
  mergeActionFiles,
  type ActionFileInput,
  type Discovery,
} from "../discovery.ts";
import { splitFrontmatter } from "../model.ts";

/** Where the shipped default actions live: the package's own `builtins/`, read-only files in
 * the same format as user files. */
export const builtinActionsDir = (): string => new URL("../../builtins/", import.meta.url).pathname;

/** The body of a shipped action (`brief`), as the legacy `ideationPrompt` fallback chain needs
 * it. Synchronous and tiny: it is read when a setting is composed, not per request. */
export const builtinActionBody = (id: string): string => {
  const text = readFileSync(join(builtinActionsDir(), `${id}.md`), "utf8");
  return splitFrontmatter(text)?.body ?? "";
};

/** Every scope a change draws from. Workspace and repository directories follow the change;
 * the global one follows the config file's directory so `CORVI_CONFIG` moves both. */
export type ActionRoots = {
  readonly global: string;
  readonly workspaces: readonly {
    readonly id: string;
    readonly label: string;
    readonly dir: string;
  }[];
  readonly repositories: readonly {
    readonly name: string;
    readonly dir: string;
  }[];
};

/** Every `*.md` directly in one directory, as action files. A directory that cannot be read is
 * an empty scope. */
const readScope = (
  dir: string,
  source: ActionFileInput["source"],
  origin?: string,
  originLabel?: string,
): Effect.Effect<readonly ActionFileInput[]> =>
  Effect.gen(function* () {
    const names = yield* Effect.tryPromise({
      try: () => readdir(dir),
      catch: () => new Error(`cannot read ${dir}`),
    }).pipe(Effect.catchAll(() => Effect.succeed([] as string[])));
    const files: ActionFileInput[] = [];
    for (const name of names.filter((n) => n.endsWith(".md")).sort()) {
      const text = yield* Effect.tryPromise({
        try: () => readFile(join(dir, name), "utf8"),
        catch: () => new Error(`cannot read ${join(dir, name)}`),
      }).pipe(Effect.catchAll(() => Effect.succeed("")));
      if (text === "") continue;
      files.push({ id: name.slice(0, -3), source, origin, originLabel, text });
    }
    return files;
  });

/** Every action a change can run: built-ins, global, its workspace, its checkouts. Read per
 * call; parsed and merged by the pure rules. */
export const discoverActions = (roots: ActionRoots): Effect.Effect<Discovery> =>
  Effect.gen(function* () {
    const files: ActionFileInput[] = [];
    files.push(...(yield* readScope(builtinActionsDir(), "builtin")));
    files.push(...(yield* readScope(roots.global, "global")));
    for (const workspace of roots.workspaces) {
      files.push(...(yield* readScope(workspace.dir, "workspace", workspace.id, workspace.label)));
    }
    for (const repository of roots.repositories) {
      files.push(...(yield* readScope(repository.dir, "repository", repository.name, repository.name)));
    }
    return mergeActionFiles(files);
  });
