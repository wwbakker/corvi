/** The file system half of profile and harness discovery: one reader for a scope's directory,
 * and the roots a change draws from. Read fresh on every call so an edit or a new file needs no
 * restart. OS access stays behind this adapter entrypoint; the vocabulary and the precedence
 * rules are pure (`../discovery`, `../profile`, `../harnessDiscovery`).
 *
 * A directory that is missing or unreadable is simply no files from it — the scopes a user has
 * not set up must not look like an error. A file that cannot be read is still returned, with
 * `readable: false`, so it is listed with a reason rather than hidden. */
import { fileURLToPath } from "node:url";
import { Effect } from "effect";

import { mergeHarnessFiles, type HarnessDiscovery, type HarnessFileInput } from "../harnessDiscovery.ts";
import { mergeProfileFiles, type ProfileDiscovery, type ProfileFileInput } from "../discovery.ts";
import { readMarkdownScope, type MarkdownScopeFile } from "./markdownScope.ts";

/** Where the shipped profiles live: the package's own `builtins/`, read-only files in the same
 * format as user files. */
export const builtinProfilesDir = (): string => fileURLToPath(new URL("../../builtins/", import.meta.url));

/** Where the built-in harnesses live: `pi`, `pi-bare` and `opencode`, the only chain ends. */
export const builtinHarnessesDir = (): string =>
  fileURLToPath(new URL("../../builtins/harnesses/", import.meta.url));

/** One `*.md` file on disk in a profile scope, before it is parsed. */
export type ProfileScopeFile = MarkdownScopeFile;

/** Every `*.md` directly in one profile directory. A directory that cannot be read is an empty
 * scope; a file that cannot be read is one unreadable entry. */
export const readProfileScope = readMarkdownScope;

/** One `*.md` file on disk in a harness scope, before it is parsed. */
export type HarnessScopeFile = MarkdownScopeFile;

/** Every `*.md` directly in one harness directory. */
export const readHarnessScope = readMarkdownScope;

/** Every scope a change draws from. Workspace and repository directories follow the change; the
 * global one follows the config file's directory so `CORVI_CONFIG` moves both. */
export type ScopeRoots = {
  readonly global: string;
  readonly workspaces: readonly {
    readonly id: string;
    readonly label: string;
    readonly dir: string;
  }[];
  readonly repositories: readonly {
    readonly name: string;
    readonly dir: string;
    /** The ids to offer from this repository: a wizard's tracked harness files. */
    readonly include?: readonly string[];
  }[];
};

export type ProfileRoots = ScopeRoots;
export type HarnessRoots = ScopeRoots;

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

const harnessInputOf = (
  file: HarnessScopeFile,
  source: HarnessFileInput["source"],
  origin?: string,
  originLabel?: string,
): HarnessFileInput => ({
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

/** Every harness a change can use: the built-ins, global files, its workspace's and its
 * checkouts'. Read per call; parsed and merged by the pure rules. */
export const discoverHarnesses = (roots: HarnessRoots): Effect.Effect<HarnessDiscovery> =>
  Effect.gen(function* () {
    const files: HarnessFileInput[] = [];
    files.push(...(yield* readHarnessScope(builtinHarnessesDir())).map((f) => harnessInputOf(f, "builtin")));
    files.push(...(yield* readHarnessScope(roots.global)).map((f) => harnessInputOf(f, "global")));
    for (const workspace of roots.workspaces) {
      files.push(
        ...(yield* readHarnessScope(workspace.dir)).map((f) =>
          harnessInputOf(f, "workspace", workspace.id, workspace.label),
        ),
      );
    }
    for (const repository of roots.repositories) {
      const allowed = repository.include === undefined ? undefined : new Set(repository.include);
      files.push(
        ...(yield* readHarnessScope(repository.dir))
          .filter((file) => allowed === undefined || allowed.has(file.id))
          .map((f) => harnessInputOf(f, "repository", repository.name, repository.name)),
      );
    }
    return mergeHarnessFiles(files);
  });

export * from "./instance.ts";
export {
  baseAgentDir,
  corviExtensionDir,
  generateHarness,
  homeSkillsDir,
  previewHarness,
  type GeneratedHarness,
  type GenerateHarnessOptions,
  type PreparedHarness,
} from "./harnessGeneration.ts";
export {
  nodeOpencodeCli,
  opencodeDatabase,
  opencodeIfUsed,
  piSessionRoots,
  transcriptsLayer,
  type OpencodeCli,
} from "./transcripts.ts";
