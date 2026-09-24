/** The config boundary: the file as it is written, and the resolved shape the program reads.
 *
 * One settings shape runs through it: `SettingsOverrides` is the whole set of settings, at the
 * global level and again inside a workspace where every key overrides the global one. Decode
 * keeps unknown keys (`onExcessProperty: "preserve"` at the decode sites): a hand-edited key
 * Corvi does not know about belongs to a version that does.
 */
import { Schema } from "effect"

/** One extension's settings bag: `extensionSettings[name][key]`, where a value is one string or a
 * list of strings. Shared by both levels; the core carries it without looking inside. */
const ExtensionBag = Schema.mutable(
  Schema.Record({
    key: Schema.String,
    value: Schema.mutable(
      Schema.Record({
        key: Schema.String,
        value: Schema.Union(Schema.String, Schema.mutable(Schema.Array(Schema.String))),
      }),
    ),
  }),
)

/** A map of environment variables added to every CLI run: `env[name] = value`. */
const EnvMap = Schema.mutable(Schema.Record({ key: Schema.String, value: Schema.String }))

/** The settings, complete: every setting Corvi knows, at any level. Each key is optional — an
 * absent value means "not set", and the next level down answers (inside a workspace: the global
 * setting; at the global level: the default). This one shape is the config file's top level and
 * a workspace's `settings`, so "any setting, at both levels" is stated by the type. */
const settingsFields = {
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
  /** The starting text of a new idea's PLAN.md, seeded into the wizard's plan editor. Literal
   * Markdown with nothing filled in — the scaffold the user edits away. An empty or absent
   * value means no template: the plan starts empty. */
  planTemplate: Schema.optional(Schema.String),
  worktreeCopy: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  /** Which extensions exist here, by name. Absent means all of them; an empty list means none.
   * Names are validated against what is included by the settings write, not here: the file may
   * be edited by hand before the integration it names exists. */
  extensions: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  /** Settings the extensions declared, under their own name: `extensionSettings[name][key]`,
   * one string or a list of strings per key. Not validated here — the fields are the
   * integration's own business. */
  extensionSettings: Schema.optional(ExtensionBag),
  /** The environment added to every CLI run here. Entries resolve per key: a workspace entry
   * beats the global one for its key and leaves the others inherited. */
  env: Schema.optional(EnvMap),
}

export const SettingsOverrides = Schema.Struct(settingsFields)
export type SettingsOverridesDto = typeof SettingsOverrides.Type

/** A context you work in: a client, or your own projects — an identity (`id`, `name`) and a
 * scope over the settings. Mirrors `@corvi/configuration/config`'s `Workspace`. */
export const Workspace = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** This workspace's settings: the same shape as the global level, overriding it key by key. */
  settings: Schema.optional(SettingsOverrides),
})
export type WorkspaceDto = typeof Workspace.Type

/** The workspace a change without one belongs to: the first one, which for everybody who has
 * not configured any is the only one. There is no such thing as no workspaces: a machine that
 * has not configured any gets this one. */
export const DEFAULT_WORKSPACE: WorkspaceDto = { id: "default", name: "Default workspace" }

/** A workspace id ends up in cache keys and in `?workspace=`, and a change records it forever:
 * it has to be a word. */
export const WorkspaceId = Schema.String.pipe(Schema.pattern(/^[\w.-]+$/))

/** A directory copied into a worktree is a name next to the code, not a path. */
export const DirectoryName = Schema.String.pipe(Schema.pattern(/^[^/\\]+$/))

/** An environment variable name, for an `env` map. */
export const EnvVarName = Schema.String.pipe(Schema.pattern(/^[A-Za-z_][A-Za-z0-9_]*$/))

/** The config file's own shape, as it is written: the settings at the top level (where they are
 * the defaults every workspace inherits) and the workspaces beside them. Everything is optional
 * — an absent value means "the default", which is what an empty file means. This is also the
 * settings page's write shape (`apps/server/src/settings/model.ts`' `Settings`). `workspaces`
 * passes through untouched and unvalidated, garbage entries included: load() applies the
 * per-item tolerance rather than losing the whole file to one hand-mangled workspace. */
export const ConfigFile = Schema.Struct({
  ...settingsFields,
  workspaces: Schema.optional(Schema.mutable(Schema.Array(Schema.Any))),
})
export type ConfigFileDto = typeof ConfigFile.Type

/** The resolved shape: file, environment and defaults combined. Not a decoder of anything on
 * disk (the resolved config is computed, never read); it states the boundary a CLI/IPC surface
 * would emit, and pins the Workspace member to the contract. The global fields carry the global
 * scope's answer (environment → file → default); each workspace's `settings` holds its overrides
 * as written, and `@corvi/configuration/settings`' `settingsFor` resolves one scope from the two.
 * Unknown legacy keys ride the preserve decode rather than this shape. */
export const Resolved = Schema.Struct({
  changesRoot: Schema.String,
  archiveRoot: Schema.String,
  repositoriesDirectory: Schema.String,
  notificationSound: Schema.Boolean,
  contextMenu: Schema.Boolean,
  ideationPrompt: Schema.String,
  /** The plan template in effect: literal Markdown, or the empty string for none. */
  planTemplate: Schema.String,
  worktreeCopy: Schema.mutable(Schema.Array(Schema.String)),
  extensions: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  extensionSettings: Schema.optional(ExtensionBag),
  env: EnvMap,
  workspaces: Schema.mutable(Schema.Array(Workspace)),
})
export type ResolvedDto = typeof Resolved.Type
