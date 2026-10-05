import { Schema } from "effect";
import {
  ConfigFile as ConfigFileSchema,
  DEFAULT_REMOTE_ACCESS,
  DirectoryName,
  EnvVarName,
  RemoteAccess as RemoteAccessSchema,
  RemoteWorkspace as RemoteWorkspaceSchema,
  Resolved as ResolvedSchema,
  Workspace as WorkspaceSchema,
  WorkspaceId,
} from "@corvi/contracts/config";
import type { RemoteAccessDto, RemoteWorkspaceDto } from "@corvi/contracts/config";
import { DeviceSchema } from "@corvi/contracts/devices";
import type { DeviceDto } from "@corvi/contracts/devices";
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

/** The remote half of a workspace, validated per item: a malformed `remote` is dropped rather
 * than taking the workspace (or the file) with it. The workspace itself is kept — an entry with
 * an id and a name is a context the user made, whatever its remote target looks like.
 *
 * The `url` is only structurally a string here; the write path (`problems()`) requires http(s),
 * and the 2.2 gateway must re-validate the scheme before it fetches a hand-edited value. */
export const remoteFrom = (value: unknown): RemoteWorkspaceDto | undefined =>
  Schema.is(RemoteWorkspaceSchema)(value) ? value : undefined;

/** `workspacesFrom` skips a workspace without a truthy id and name rather than rejecting the
 * file — one hand-mangled entry must not cost the rest of the configuration. That tolerance is
 * applied here, not by the schema: rejecting the whole file over one entry would turn a
 * half-mangled config into "nothing configured". A malformed `remote` is dropped; the workspace
 * it belonged to is kept. */
export const workspacesFrom = (items: unknown): WorkspaceShape[] =>
  Array.isArray(items)
    ? items.filter(hasIdAndName).map((workspace) => {
        const remote = remoteFrom((workspace as { remote?: unknown }).remote);
        const normalized = workspace as { remote?: RemoteWorkspaceDto };
        if (remote === undefined) delete normalized.remote;
        else normalized.remote = remote;
        return workspace;
      })
    : [];

const hasIdAndName = (w: unknown): w is WorkspaceShape =>
  typeof w === "object" &&
  w !== null &&
  Boolean((w as { id?: unknown }).id) &&
  Boolean((w as { name?: unknown }).name);

/** The same per-item tolerance, for devices: the schema decodes the array loosely
 * (`Schema.Any`), and a malformed entry is skipped rather than taking the whole file with it.
 * A device is a record with a token hash; `DeviceSchema` is the one statement of its shape. */
export const devicesFrom = (items: unknown): DeviceDto[] =>
  Array.isArray(items) ? items.filter((item): item is DeviceDto => Schema.is(DeviceSchema)(item)) : [];

/** The remote-access setting, validated at the boundary: an object with a boolean `enabled` and
 * a real TCP port. Anything else means "not configured" (off, default port) rather than a
 * decode failure that would empty the file. */
export const remoteAccessFrom = (value: unknown): RemoteAccessDto =>
  Schema.is(RemoteAccessSchema)(value) ? value : DEFAULT_REMOTE_ACCESS;

/** The config file's own shape, as it is written. Everything is optional — an absent value
 * means "the default", which is what an empty file means. This is also the settings page's
 * write shape (`@corvi/contracts/settings-view`'s `Settings`), and the two must not drift: the
 * compile-time guards below pin this schema to @corvi/configuration/config' hand-written `ConfigFile`. */
export const ConfigFile = ConfigFileSchema;

/** What the config file decodes to. Decode with the shared decode-then-merge
 * (`@corvi/contracts/body`'s `decodePreserving`, which readFile uses) so unknown keys survive
 * into the settings merge. `workspaces` and `devices` are typed as they
 * are consumed (after the per-item tolerance) rather than as the schema sees them on the wire:
 * the file may hold entries load() will filter out, and that passthrough is deliberate. */
export type ConfigFile = Omit<
  Schema.Schema.Type<typeof ConfigFile>,
  "workspaces" | "devices" | "remoteAccess"
> & {
  devices?: DeviceDto[];
  remoteAccess?: RemoteAccessDto;
  workspaces?: WorkspaceShape[];
};

// The hand-written file vocabulary in @corvi/configuration/config and this schema must not drift:
// both directions fail to compile if the schema stops describing exactly the file shape.
const _configFileMatchesVocabulary: ConfigFileVocabulary = {} as ConfigFile;
const _configFileVocabularyMatchesSchema: ConfigFile = {} as ConfigFileVocabulary;

/** The resolved shape: file, environment and defaults combined — `@corvi/configuration/config`'s
 * `Config`. Not a decoder of anything on disk (the resolved config is computed, never read); it
 * states the boundary a future CLI/IPC surface would emit, and pins the Workspace member to the
 * type. Fields a previous core owned ride the preserve decode as unknown keys rather than this
 * shape. */
export const Resolved = ResolvedSchema;
