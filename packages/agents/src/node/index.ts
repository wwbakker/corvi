/** The file system half of profile and harness discovery: one reader for a scope's directory,
 * and the roots a change draws from. Read fresh on every call so an edit or a new file needs no
 * restart. OS access stays behind this adapter entrypoint; the vocabulary and the precedence
 * rules are pure (`../discovery`, `../profile`, `../harnessProfileDiscovery`).
 *
 * A directory that is missing or unreadable is simply no files from it — the scopes a user has
 * not set up must not look like an error. A file that cannot be read is still returned, with
 * `readable: false`, so it is listed with a reason rather than hidden. */
import { fileURLToPath } from "node:url";
import { Effect } from "effect";

import {
  mergeHarnessProfileFiles,
  type HarnessProfileDiscovery,
  type HarnessProfileFileInput,
} from "../harnessProfileDiscovery.ts";
import {
  mergeSubagentProfileFiles,
  type SubagentProfileDiscovery,
  type SubagentProfileFileInput,
} from "../subagentProfileDiscovery.ts";
import { readMarkdownScope, type MarkdownScopeFile } from "./markdownScope.ts";

/** Where the shipped profiles live: the package's own `builtins/`, read-only files in the same
 * format as user files. */
export const builtinSubagentProfilesDir = (): string =>
  fileURLToPath(new URL("../../builtins/", import.meta.url));

/** Where the built-in harnesses live: `pi`, `pi-bare` and `opencode`, the only chain ends. */
export const builtinHarnessProfilesDir = (): string =>
  fileURLToPath(new URL("../../builtins/harnesses/", import.meta.url));

/** One `*.md` file on disk in a profile scope, before it is parsed. */
export type SubagentProfileScopeFile = MarkdownScopeFile;

/** Every `*.md` directly in one profile directory. A directory that cannot be read is an empty
 * scope; a file that cannot be read is one unreadable entry. */
export const readSubagentProfileScope = readMarkdownScope;

/** One `*.md` file on disk in a harness scope, before it is parsed. */
export type HarnessProfileScopeFile = MarkdownScopeFile;

/** Every `*.md` directly in one harness directory. */
export const readHarnessProfileScope = readMarkdownScope;

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
    /** The ids to offer from this repository: a wizard's tracked harness profile files. */
    readonly include?: readonly string[];
  }[];
};

export type SubagentProfileRoots = ScopeRoots;
export type HarnessProfileRoots = ScopeRoots;

const inputOf = (
  file: SubagentProfileScopeFile,
  source: SubagentProfileFileInput["source"],
  origin?: string,
  originLabel?: string,
): SubagentProfileFileInput => ({
  id: file.id,
  source,
  origin,
  originLabel,
  text: file.text,
  readable: file.readable,
});

const harnessProfileInputOf = (
  file: HarnessProfileScopeFile,
  source: HarnessProfileFileInput["source"],
  origin?: string,
  originLabel?: string,
): HarnessProfileFileInput => ({
  id: file.id,
  source,
  origin,
  originLabel,
  text: file.text,
  readable: file.readable,
});

/** Every profile a change can run: built-ins, global, its workspace, its checkouts. Read per
 * call; parsed and merged by the pure rules. */
export const discoverSubagentProfiles = (
  roots: SubagentProfileRoots,
): Effect.Effect<SubagentProfileDiscovery> =>
  Effect.gen(function* () {
    const files: SubagentProfileFileInput[] = [];
    files.push(
      ...(yield* readSubagentProfileScope(builtinSubagentProfilesDir())).map((f) => inputOf(f, "builtin")),
    );
    files.push(...(yield* readSubagentProfileScope(roots.global)).map((f) => inputOf(f, "global")));
    for (const workspace of roots.workspaces) {
      files.push(
        ...(yield* readSubagentProfileScope(workspace.dir)).map((f) =>
          inputOf(f, "workspace", workspace.id, workspace.label),
        ),
      );
    }
    for (const repository of roots.repositories) {
      files.push(
        ...(yield* readSubagentProfileScope(repository.dir)).map((f) =>
          inputOf(f, "repository", repository.name, repository.name),
        ),
      );
    }
    return mergeSubagentProfileFiles(files);
  });

/** Every harness a change can use: the built-ins, global files, its workspace's and its
 * checkouts'. Read per call; parsed and merged by the pure rules. */
export const discoverHarnessProfiles = (roots: HarnessProfileRoots): Effect.Effect<HarnessProfileDiscovery> =>
  Effect.gen(function* () {
    const files: HarnessProfileFileInput[] = [];
    files.push(
      ...(yield* readHarnessProfileScope(builtinHarnessProfilesDir())).map((f) =>
        harnessProfileInputOf(f, "builtin"),
      ),
    );
    files.push(
      ...(yield* readHarnessProfileScope(roots.global)).map((f) => harnessProfileInputOf(f, "global")),
    );
    for (const workspace of roots.workspaces) {
      files.push(
        ...(yield* readHarnessProfileScope(workspace.dir)).map((f) =>
          harnessProfileInputOf(f, "workspace", workspace.id, workspace.label),
        ),
      );
    }
    for (const repository of roots.repositories) {
      const allowed = repository.include === undefined ? undefined : new Set(repository.include);
      files.push(
        ...(yield* readHarnessProfileScope(repository.dir))
          .filter((file) => allowed === undefined || allowed.has(file.id))
          .map((f) => harnessProfileInputOf(f, "repository", repository.name, repository.name)),
      );
    }
    return mergeHarnessProfileFiles(files);
  });

export * from "./instance.ts";
export {
  baseAgentDir,
  corviExtensionDir,
  generateEnvironment,
  homeSkillsDir,
  previewEnvironment,
  type GeneratedEnvironment,
  type GenerateEnvironmentOptions,
  type PreparedEnvironment,
} from "./environmentGeneration.ts";
export {
  nodeOpencodeCli,
  opencodeDatabase,
  opencodeIfUsed,
  piSessionRoots,
  transcriptsLayer,
  type OpencodeCli,
} from "./transcripts.ts";
