import { Schema } from "effect";
import type { Workspace as WorkspaceShape } from "../../core/domain/config.ts";

/**
 * Effect Schemas for the config layer — the JSON boundary of the config file.
 *
 * The file is the hand-edited source of truth (see src/settings/server/settings.ts), so these schemas describe
 * *the file as it is written*: every key optional, because an absent value means "the default",
 * and unknown keys preserved on decode, because a key IWE does not know about was put there by
 * hand for a version of IWE that does and losing it silently would be rude.
 *
 * The resolved shape (`src/core/domain/config.ts`'s `Config`) is described by `Resolved`, which is what the
 * rest of the program reads and what a future CLI `--json` or IPC surface would emit.
 */

/** A context you work in: a client, or your own projects. Mirrors `src/core/domain/config.ts`'s `Workspace`. */
export const Workspace = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  reposStart: Schema.optional(Schema.String),
  /** Which extensions exist here. Absent means all of them; an empty list means none. Names
   * are validated against what is loaded by the settings write, not here: the file may be
   * edited by hand before the extension it names exists. */
  extensions: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  /** Per-workspace settings declared by the extensions: `extensionSettings[name][key]`. The core
   * carries it without looking inside; what belongs there is the extension's own declaration. */
  extensionSettings: Schema.optional(
    Schema.mutable(
      Schema.Record({
        key: Schema.String,
        value: Schema.mutable(Schema.Record({ key: Schema.String, value: Schema.String })),
      }),
    ),
  ),
  azure: Schema.optional(
    Schema.Union(
      Schema.Literal(false),
      Schema.Struct({
        organization: Schema.optional(Schema.String),
        project: Schema.optional(Schema.String),
      }),
    ),
  ),
  env: Schema.optional(Schema.mutable(Schema.Record({ key: Schema.String, value: Schema.String }))),
});

// The schema and the hand-written type must not drift: this line fails to compile if the
// schema stops describing exactly the Workspace every module reads.
const _workspaceMatchesType: Schema.Schema<WorkspaceShape> = Workspace;

/** The `azureDeploy` subshape as the file holds it: every key optional. */
export const AzureDeploy = Schema.Struct({
  pipeline: Schema.optional(Schema.Tuple(Schema.String, Schema.String)),
  versionParameter: Schema.optional(Schema.String),
  environmentParameter: Schema.optional(Schema.String),
  environments: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
});

/** A workspace id ends up in cache keys and in `?workspace=`, and a change records it forever:
 * it has to be a word. The same rule src/settings/server/settings.ts enforces, as a schema. */
export const WorkspaceId = Schema.String.pipe(Schema.pattern(/^[\w.-]+$/));

/** A directory copied into a worktree is a name next to the code, not a path (see src/settings/server/settings.ts). */
export const DirectoryName = Schema.String.pipe(Schema.pattern(/^[^/\\]+$/));

/** An environment variable name, for a workspace's `env` map. */
export const EnvVarName = Schema.String.pipe(Schema.pattern(/^[A-Za-z_][A-Za-z0-9_]*$/));

/** `workspacesFrom` skips a workspace without a truthy id and name rather than rejecting the
 * file — one hand-mangled entry must not cost the rest of the configuration. That tolerance is
 * applied here, not by the schema: rejecting the whole file over one entry would turn a
 * half-mangled config into "nothing configured". */
export const workspacesFrom = (items: unknown): WorkspaceShape[] =>
  Array.isArray(items) ? items.filter(hasIdAndName) : [];

const hasIdAndName = (w: unknown): w is WorkspaceShape =>
  typeof w === "object" &&
  w !== null &&
  Boolean((w as { id?: unknown }).id) &&
  Boolean((w as { name?: unknown }).name);

/** The config file's own shape, as it is written. Everything is optional — an absent value
 * means "the default", which is what an empty file means. This is also the settings
 * page's write shape (src/settings/server/settings.ts' `Settings`). */
export const ConfigFile = Schema.Struct({
  changesRoot: Schema.optional(Schema.String),
  reposRoot: Schema.optional(Schema.String),
  reposStart: Schema.optional(Schema.String),
  jiraAssignee: Schema.optional(Schema.String),
  /** Whether a notification plays the system sound. Absent means yes. */
  notificationSound: Schema.optional(Schema.Boolean),
  jiraStartTransition: Schema.optional(Schema.String),
  jiraDoneTransition: Schema.optional(Schema.String),
  azureOrganization: Schema.optional(Schema.String),
  azureProject: Schema.optional(Schema.String),
  // Passed through untouched, unvalidated, garbage entries included: dropping them here would
  // let one hand-mangled workspace cost the rest of the file. load() applies the per-item
  // tolerance via workspacesFrom.
  workspaces: Schema.optional(Schema.mutable(Schema.Array(Schema.Any))),
  worktreeCopy: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  /** Where out-of-tree extension modules live: .ts files or directories, `~` allowed. Not
   * validated here — a path that does not exist is logged and skipped by the loader, not a
   * reason to reject the file. */
  extensionPaths: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  /** Settings the extensions declared, under their own name: `extensionSettings[name][key]`,
   * one string or a list of strings per key. Not validated here — the fields are the
   * extension's own business; the core carries the bag without looking inside. */
  extensionSettings: Schema.optional(
    Schema.mutable(
      Schema.Record({
        key: Schema.String,
        value: Schema.mutable(
          Schema.Record({
            key: Schema.String,
            value: Schema.Union(Schema.String, Schema.mutable(Schema.Array(Schema.String))),
          }),
        ),
      }),
    ),
  ),
  azureDeploy: Schema.optional(AzureDeploy),
});

/** What the config file decodes to. Decode with `onExcessProperty: "preserve"` (readFile does)
 * so unknown keys survive into the settings merge. `workspaces` is typed as it is consumed
 * (after workspacesFrom) rather than as the schema sees it on the wire: the file may hold
 * entries load() will filter out, and that passthrough is deliberate. */
export type ConfigFile = Omit<Schema.Schema.Type<typeof ConfigFile>, "workspaces"> & {
  workspaces?: WorkspaceShape[];
};

/** The resolved shape: file, environment and defaults combined — `src/core/domain/config.ts`'s `Config`. Not a
 * decoder of anything on disk (the resolved config is computed, never read); it states the
 * boundary a future CLI/IPC surface would emit, and pins the Workspace member to the type. */
export const Resolved = Schema.Struct({
  changesRoot: Schema.String,
  reposRoot: Schema.String,
  reposStart: Schema.String,
  jiraAssignee: Schema.String,
  notificationSound: Schema.Boolean,
  jiraStartTransition: Schema.String,
  jiraDoneTransition: Schema.String,
  azureOrganization: Schema.String,
  azureProject: Schema.String,
  workspaces: Schema.Array(Workspace),
  worktreeCopy: Schema.Array(Schema.String),
  extensionPaths: Schema.Array(Schema.String),
  extensionSettings: Schema.optional(
    Schema.mutable(
      Schema.Record({
        key: Schema.String,
        value: Schema.mutable(
          Schema.Record({
            key: Schema.String,
            value: Schema.Union(Schema.String, Schema.mutable(Schema.Array(Schema.String))),
          }),
        ),
      }),
    ),
  ),
  azureDeploy: Schema.Struct({
    pipeline: Schema.Tuple(Schema.String, Schema.String),
    versionParameter: Schema.String,
    environmentParameter: Schema.String,
    environments: Schema.Array(Schema.String),
  }),
});
