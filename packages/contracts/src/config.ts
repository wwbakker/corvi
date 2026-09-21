/** The config boundary: the file as it is written, and the resolved shape the program reads.
 *
 * Moved here from the workspace server so the settings page and the browser client share the
 * one statement of the shape. Decode keeps unknown keys (`onExcessProperty: "preserve"` at the
 * decode sites): a hand-edited key Corvi does not know about belongs to a version that does.
 */
import { Schema } from "effect"

/** A context you work in: a client, or your own projects. Mirrors `@corvi/configuration/config`'s
 * `Workspace`. */
export const Workspace = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  repositoriesDirectory: Schema.optional(Schema.String),
  /** Which extensions exist here. Absent means all of them; an empty list means none. Names are
   * validated against what is included by the settings write, not here: the file may be edited
   * by hand before the integration it names exists. */
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
  env: Schema.optional(Schema.mutable(Schema.Record({ key: Schema.String, value: Schema.String }))),
})
export type WorkspaceDto = typeof Workspace.Type

/** A workspace id ends up in cache keys and in `?workspace=`, and a change records it forever:
 * it has to be a word. */
export const WorkspaceId = Schema.String.pipe(Schema.pattern(/^[\w.-]+$/))

/** A directory copied into a worktree is a name next to the code, not a path. */
export const DirectoryName = Schema.String.pipe(Schema.pattern(/^[^/\\]+$/))

/** An environment variable name, for a workspace's `env` map. */
export const EnvVarName = Schema.String.pipe(Schema.pattern(/^[A-Za-z_][A-Za-z0-9_]*$/))

/** The config file's own shape, as it is written. Everything is optional — an absent value means
 * "the default", which is what an empty file means. This is also the settings page's write shape
 * (`src/settings/model.ts`' `Settings`). `workspaces` passes through untouched and unvalidated,
 * garbage entries included: load() applies the per-item tolerance rather than losing the whole
 * file to one hand-mangled workspace. */
export const ConfigFile = Schema.Struct({
  changesRoot: Schema.optional(Schema.String),
  /** Where completed changes are moved; absent means `~/corvi/changes-archive`. */
  archiveRoot: Schema.optional(Schema.String),
  /** Directory the repository browser opens on; absent means `$HOME`. */
  repositoriesDirectory: Schema.optional(Schema.String),
  /** Whether a notification plays the system sound. Absent means yes. */
  notificationSound: Schema.optional(Schema.Boolean),
  /** Whether right-clicking shows the browser's own menu. Absent means yes. */
  contextMenu: Schema.optional(Schema.Boolean),
  /** The prompt that briefs an agent about an idea, `{id}`/`{title}`/`{plan}`/`{state}` filled
   * in. Free text, so nothing is validated; an empty value means the default. */
  ideationPrompt: Schema.optional(Schema.String),
  workspaces: Schema.optional(Schema.mutable(Schema.Array(Schema.Any))),
  worktreeCopy: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  /** Settings the integrations declared, under their own name: `extensionSettings[name][key]`,
   * one string or a list of strings per key. Not validated here — the fields are the
   * integration's own business; the core carries the bag without looking inside. */
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
})
export type ConfigFileDto = typeof ConfigFile.Type

/** The resolved shape: file, environment and defaults combined. Not a decoder of anything on
 * disk (the resolved config is computed, never read); it states the boundary a CLI/IPC surface
 * would emit, and pins the Workspace member to the contract. Unknown legacy keys ride the
 * preserve decode rather than this shape. */
export const Resolved = Schema.Struct({
  changesRoot: Schema.String,
  archiveRoot: Schema.String,
  repositoriesDirectory: Schema.String,
  notificationSound: Schema.Boolean,
  contextMenu: Schema.Boolean,
  ideationPrompt: Schema.String,
  workspaces: Schema.mutable(Schema.Array(Workspace)),
  worktreeCopy: Schema.mutable(Schema.Array(Schema.String)),
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
})
export type ResolvedDto = typeof Resolved.Type
