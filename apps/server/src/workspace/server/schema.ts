import { Schema } from "effect";
import {
  ConfigFile as ConfigFileSchema,
  DirectoryName,
  EnvVarName,
  Resolved as ResolvedSchema,
  Workspace as WorkspaceSchema,
  WorkspaceId,
} from "@corvi/contracts/config";
import type {
  ConfigFile as ConfigFileVocabulary,
  Workspace as WorkspaceShape,
} from "@corvi/configuration/config";

/**
 * Effect Schemas for the config layer — the JSON boundary of the config file.
 *
 * The schemas themselves are the canonical wire contract (`@corvi/contracts/config`): the file
 * the settings page edits and the shape a CLI/IPC surface would emit are described once. What
 * stays here is the tolerance this layer applies — the per-item filtering a hand-mangled file
 * deserves — and the compile-time checks that the app vocabulary and the contract do not drift.
 */

export { DirectoryName, EnvVarName, WorkspaceId };

/** A context you work in: a client, or your own projects. Mirrors `@corvi/configuration/config`'s `Workspace`. */
export const Workspace = WorkspaceSchema;

// The schema and the hand-written type must not drift: this line fails to compile if the
// schema stops describing exactly the Workspace every module reads.
const _workspaceMatchesType: Schema.Schema<WorkspaceShape> = Workspace;

/**
 * Fold a workspace written before `settings` existed into the one shape: its top-level
 * `repositoriesDirectory`, `extensions`, `extensionSettings` and `env` become its `settings`,
 * and a value `settings` already speaks is never overwritten. The old keys are decisions, not
 * unknown keys, so they move rather than ride the preserve decode along. Idempotent, and pure
 * but for its argument: the decode boundary and `workspacesFrom` both apply it, so a file
 * hand-edited in either shape resolves and round-trips the same.
 */
export function foldWorkspaceSettings(workspace: unknown): void {
  if (typeof workspace !== "object" || workspace === null) return;
  const item = workspace as Record<string, unknown> & { settings?: Record<string, unknown> };
  const moved: Record<string, unknown> = {};
  for (const key of ["repositoriesDirectory", "extensions", "extensionSettings", "env"] as const) {
    if (item[key] !== undefined) {
      moved[key] = item[key];
      delete item[key];
    }
  }
  if (Object.keys(moved).length === 0) return;
  item.settings = { ...moved, ...(item.settings ?? {}) };
}

/** `workspacesFrom` skips a workspace without a truthy id and name rather than rejecting the
 * file — one hand-mangled entry must not cost the rest of the configuration. That tolerance is
 * applied here, not by the schema: rejecting the whole file over one entry would turn a
 * half-mangled config into "nothing configured". The kept entries come back in the one shape
 * (`foldWorkspaceSettings`), old keys folded into `settings`. */
export const workspacesFrom = (items: unknown): WorkspaceShape[] =>
  Array.isArray(items)
    ? items.filter(hasIdAndName).map((workspace) => {
        foldWorkspaceSettings(workspace);
        return workspace;
      })
    : [];

const hasIdAndName = (w: unknown): w is WorkspaceShape =>
  typeof w === "object" &&
  w !== null &&
  Boolean((w as { id?: unknown }).id) &&
  Boolean((w as { name?: unknown }).name);

/** The config file's own shape, as it is written. Everything is optional — an absent value
 * means "the default", which is what an empty file means. This is also the settings page's
 * write shape (apps/server/src/settings/model.ts' `Settings`), and the two must not drift: the
 * compile-time guards below pin this schema to @corvi/configuration/config' hand-written `ConfigFile`. */
export const ConfigFile = ConfigFileSchema;

/** What the config file decodes to. Decode with `onExcessProperty: "preserve"` (readFile does)
 * so unknown keys survive into the settings merge. `workspaces` is typed as it is consumed
 * (after workspacesFrom) rather than as the schema sees it on the wire: the file may hold
 * entries load() will filter out, and that passthrough is deliberate. */
export type ConfigFile = Omit<Schema.Schema.Type<typeof ConfigFile>, "workspaces"> & {
  workspaces?: WorkspaceShape[];
};

// The hand-written file vocabulary in @corvi/configuration/config and this schema must not drift:
// both directions fail to compile if the schema stops describing exactly the file shape.
const _configFileMatchesVocabulary: ConfigFileVocabulary = {} as ConfigFile;
const _configFileVocabularyMatchesSchema: ConfigFile = {} as ConfigFileVocabulary;

/** The resolved shape: file, environment and defaults combined — `@corvi/configuration/config`'s
 * `Config`. Not a decoder of anything on disk (the resolved config is computed, never read); it
 * states the boundary a future CLI/IPC surface would emit, and pins the Workspace member to the
 * type. The azure-devops fields the core used to own are unknown keys now: the extension reads
 * them through its own legacy.ts, so they ride the preserve decode rather than this shape. */
export const Resolved = ResolvedSchema;
