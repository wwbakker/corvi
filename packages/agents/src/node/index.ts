/** The file system half of profile discovery: one reader for a scope's directory, and the roots
 * a change draws from. Read fresh on every call so an edit or a new file needs no restart. OS
 * access stays behind this adapter entrypoint; the vocabulary and the precedence rules are pure
 * (`../discovery`, `../profile`).
 *
 * A directory that is missing or unreadable is simply no profiles from it — the scopes a user has
 * not set up must not look like an error. A file that cannot be read is still returned, with
 * `readable: false`, so it is listed with a reason rather than hidden. */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";

import { mergeProfileFiles, type ProfileDiscovery, type ProfileFileInput } from "../discovery.ts";

/** Where the shipped profiles live: the package's own `builtins/`, read-only files in the same
 * format as user files. */
export const builtinProfilesDir = (): string =>
  fileURLToPath(new URL("../../builtins/", import.meta.url));

/** One `*.md` file on disk in a scope, before it is parsed. `readable` is false when the file
 * could not be read: it is still listed, so a permission problem is visible rather than a
 * missing profile. */
export type ProfileScopeFile = {
  readonly id: string;
  readonly path: string;
  readonly text: string;
  readonly readable: boolean;
};

/** Every `*.md` directly in one directory. A directory that cannot be read is an empty scope; a
 * file that cannot be read is one unreadable entry. */
export const readProfileScope = (dir: string): Effect.Effect<readonly ProfileScopeFile[]> =>
  Effect.gen(function* () {
    const names = yield* Effect.tryPromise({
      try: () => readdir(dir),
      catch: () => new Error(`cannot read ${dir}`),
    }).pipe(Effect.catch(() => Effect.succeed([] as string[])));
    const files: ProfileScopeFile[] = [];
    for (const name of names.filter((n) => n.endsWith(".md")).sort()) {
      const path = join(dir, name);
      const read = yield* Effect.tryPromise({
        try: () => readFile(path, "utf8"),
        catch: () => new Error(`cannot read ${path}`),
      }).pipe(Effect.result);
      files.push({
        id: name.slice(0, -3),
        path,
        text: read._tag === "Success" ? read.success : "",
        readable: read._tag === "Success",
      });
    }
    return files;
  });

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

const inputOf = (
  file: ProfileScopeFile,
  source: ProfileFileInput["source"],
  origin?: string,
  originLabel?: string,
): ProfileFileInput => ({
  id: file.id,
  source,
  origin,
  originLabel,
  text: file.text,
  readable: file.readable,
});

/** Every profile a change can run: built-ins, global, its workspace, its checkouts. Read per
 * call; parsed and merged by the pure rules. */
export const discoverProfiles = (roots: ProfileRoots): Effect.Effect<ProfileDiscovery> =>
  Effect.gen(function* () {
    const files: ProfileFileInput[] = [];
    files.push(...(yield* readProfileScope(builtinProfilesDir())).map((f) => inputOf(f, "builtin")));
    files.push(...(yield* readProfileScope(roots.global)).map((f) => inputOf(f, "global")));
    for (const workspace of roots.workspaces) {
      files.push(
        ...(yield* readProfileScope(workspace.dir)).map((f) =>
          inputOf(f, "workspace", workspace.id, workspace.label),
        ),
      );
    }
    for (const repository of roots.repositories) {
      files.push(
        ...(yield* readProfileScope(repository.dir)).map((f) =>
          inputOf(f, "repository", repository.name, repository.name),
        ),
      );
    }
    return mergeProfileFiles(files);
  });

export * from "./instance.ts";
