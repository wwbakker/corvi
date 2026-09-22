import { homedir } from "node:os";
import { readFileSync as readFileNodeSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { Effect, Schema } from "effect";
import { DEFAULT_IDEATION_PROMPT, DEFAULT_WORKSPACE, type Config } from "@corvi/configuration/config";
import { ConfigFile, workspacesFrom } from "./schema.ts";
import { ENV_OVERRIDES } from "../../settings/server/legacySettings.ts";
import { resolveSetting } from "@corvi/configuration/settings";
import { TOOLING } from "../../capabilities/os.ts";
import {
  configDir,
  defaultArchiveRoot,
  defaultChangesRoot,
  env,
} from "@corvi/configuration/node";

// Pure sync path logic; nothing to wrap in an Effect.
export const configPath = (): string =>
  process.env[env("CONFIG")] ?? join(configDir(), "config.json");

export const expandTilde = (path: string): string =>
  path.startsWith("~") ? join(homedir(), path.slice(1)) : path;

const defaults: Pick<Config, "changesRoot" | "archiveRoot" | "repositoriesDirectory"> = {
  changesRoot: defaultChangesRoot(),
  archiveRoot: defaultArchiveRoot(),
  repositoriesDirectory: homedir(),
};

/**
 * The config file, decoded through its Schema (apps/server/src/workspace/server/schema.ts).
 *
 * Reconciling the synchronous startup read with Effect: the read and decode are built as an
 * Effect so the file boundary has exactly one implementation, but it is run with
 * `Effect.runSync` at startup — config is needed before the first request, this is one small
 * local file, and an async dance here would only move the await into the server's first request.
 * Everything async (the settings page's write path) composes the same Effect.
 */
const decodeConfigFile = (text: string): Effect.Effect<ConfigFile> =>
  Schema.decodeUnknown(Schema.parseJson(ConfigFile), { onExcessProperty: "preserve" })(text).pipe(
    // Tolerance the manual documents: an invalid config file reads as "nothing configured".
    Effect.orElseSucceed(() => ({})),
  );

/** The file's contents as an Effect: unreadable or undecodable means "nothing configured". */
export const readFile = (path: string = configPath()): Effect.Effect<ConfigFile> =>
  Effect.gen(function* () {
    const text = yield* Effect.try(() => readFileNodeSync(path, "utf8"));
    return yield* decodeConfigFile(text);
  }).pipe(
    // Same tolerance, for a file that cannot be read at all: nothing configured.
    Effect.catchAll(() => Effect.succeed({})),
  );

/** What is in the file, as it is written. Invalid JSON reads as "nothing configured", which is
 * how a machine with no config at all starts.
 *
 * Sync sibling of readFile (run with Effect.runSync; see the note above): config is needed
 * synchronously at startup. */
export function readFileSync(): ConfigFile {
  // Sync on purpose: config is needed before the first request, and this is one small file.
  return Effect.runSync(readFile());
}

const resolvePath = (value: string): string => {
  const path = expandTilde(value);
  if (!isAbsolute(path)) throw new Error(`config path must be absolute: ${path}`);
  return path;
};

/**
 * The file and the environment, resolved into what the rest of the code reads. The precedence
 * chain — environment wins over file, file over defaults, the bag over both — is stated once,
 * in @corvi/configuration/settings. The per-workspace tolerance (skip entries without a truthy id and
 * name) is applied by workspacesFrom.
 */
export function readConfig(): Config {
  const file = readFileSync();
  const workspaces = workspacesFrom(file.workspaces);
  return {
    // The file's unknown keys ride along into the resolved config: every boundary that decodes a
    // file keeps the keys it does not know about, and an extension's legacy fallback (the jira
    // extension's `legacy.ts`, the azure-devops extension's `legacy.ts`) reads a field the core
    // used to own from here. Every known field below overrides its raw counterpart — and the
    // retired top-level keys are deleted after spreading, so `in` checks and `Object.keys`
    // cannot mistake a legacy field for a live one.
    ...file,
    ...({ azureOrganization: undefined, azureProject: undefined, azureDeploy: undefined } as {
      azureOrganization?: undefined;
      azureProject?: undefined;
      azureDeploy?: undefined;
    }),
    changesRoot: resolvePath(
      resolveSetting({
        env: ENV_OVERRIDES.changesRoot,
        file: file.changesRoot,
        fallback: defaults.changesRoot,
      }),
    ),
    archiveRoot: resolvePath(
      resolveSetting({
        env: ENV_OVERRIDES.archiveRoot,
        file: file.archiveRoot,
        fallback: defaults.archiveRoot,
      }),
    ),
    repositoriesDirectory: resolvePath(
      resolveSetting({
        env: ENV_OVERRIDES.repositoriesDirectory,
        file: file.repositoriesDirectory,
        fallback: defaults.repositoriesDirectory,
      }),
    ),
    notificationSound: resolveSetting({ file: file.notificationSound, fallback: true }),
    contextMenu: resolveSetting({ file: file.contextMenu, fallback: true }),
    ideationPrompt: resolveSetting({ file: file.ideationPrompt, fallback: DEFAULT_IDEATION_PROMPT }),
    workspaces: workspaces.length ? workspaces : [DEFAULT_WORKSPACE],
    // The extensions' own settings, passed through untouched: the core does not look inside.
    // Always a key, absent or not — the refill is Object.assign over the one config object, and
    // a key left out here would survive a settings write that emptied the bag.
    extensionSettings: file.extensionSettings,
    worktreeCopy: resolveSetting({      env: ENV_OVERRIDES.worktreeCopy,
      file: file.worktreeCopy,
      fallback: TOOLING,
      parse: (raw) =>
        raw
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean),
    }),
  };
}


/**
 * The settings snapshot: the file and the environment resolved into what the rest of the code
 * reads. Read by the runtime (apps/server/src/capabilities/runtime.ts), which owns the one snapshot every
 * module sees; `reloadInto` refills it in place when the settings page writes.
 *
 * The retired extension names fold into the extensions' own settings here rather than in the
 * host: the config owns the workspaces, and importing the host from the config would close a
 * module cycle. The migration lives in apps/server/src/integrations/migrate.ts and is injected by
 * setMigrator, which the host calls once its composed list — the source of the loaded names —
 * exists.
 */

/** The workspace migration the host injects once its list is composed. Unset in tests that
 * import the config without the host: no migration then, only the file as written. */
let migrator: ((workspaces: Config["workspaces"]) => void) | undefined;

export const setMigrator = (
  migrate: ((workspaces: Config["workspaces"]) => void) | undefined,
): void => {
  migrator = migrate;
}

/** Refill `target` in place. Sync, because every caller of the settings write is synchronous
 * today and the object identity must not change.
 *
 * Keys the new file no longer has are removed first: the refill is Object.assign onto the one
 * object, and assign alone would leave whatever the previous file carried — a legacy field the
 * settings page emptied, say — readable for ever. */
export function reloadInto(target: Config): Config {
  const next = readConfig();
  for (const key of Object.keys(target)) {
    if (!(key in next)) delete (target as Record<string, unknown>)[key];
  }
  const reloaded = Object.assign(target, next);
  migrator?.(reloaded.workspaces);
  return reloaded;
}
