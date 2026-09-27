/** The file system half of profile discovery: the directories a change's subagent profiles live
 * in, read fresh on every call so an edit or a new file needs no restart. OS access stays behind
 * this adapter entrypoint; the vocabulary and the precedence rules are pure (`../discovery`,
 * `../profile`).
 *
 * A directory that is missing or unreadable is simply no profiles from it — the scopes a user has
 * not set up must not look like an error. */
import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";

import { mergeProfileFiles, type ProfileDiscovery, type ProfileFileInput } from "../discovery.ts";

/** Where the shipped profiles live: the package's own `builtins/`, read-only files in the same
 * format as user files. */
export const builtinProfilesDir = (): string => new URL("../../builtins/", import.meta.url).pathname;

/** Every scope a change draws from. Workspace and repository directories follow the change; the
 * global one follows the config file's directory so `CORVI_CONFIG` moves both. */
export type ProfileRoots = {
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

/** Every `*.md` directly in one directory, as profile files. A directory that cannot be read is
 * an empty scope. */
const readScope = (
  dir: string,
  source: ProfileFileInput["source"],
  origin?: string,
  originLabel?: string,
): Effect.Effect<readonly ProfileFileInput[]> =>
  Effect.gen(function* () {
    const names = yield* Effect.tryPromise({
      try: () => readdir(dir),
      catch: () => new Error(`cannot read ${dir}`),
    }).pipe(Effect.catchAll(() => Effect.succeed([] as string[])));
    const files: ProfileFileInput[] = [];
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

/** Every profile a change can run: built-ins, global, its workspace, its checkouts. Read per
 * call; parsed and merged by the pure rules. */
export const discoverProfiles = (roots: ProfileRoots): Effect.Effect<ProfileDiscovery> =>
  Effect.gen(function* () {
    const files: ProfileFileInput[] = [];
    files.push(...(yield* readScope(builtinProfilesDir(), "builtin")));
    files.push(...(yield* readScope(roots.global, "global")));
    for (const workspace of roots.workspaces) {
      files.push(...(yield* readScope(workspace.dir, "workspace", workspace.id, workspace.label)));
    }
    for (const repository of roots.repositories) {
      files.push(...(yield* readScope(repository.dir, "repository", repository.name, repository.name)));
    }
    return mergeProfileFiles(files);
  });
