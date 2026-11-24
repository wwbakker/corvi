/** The file system half of harness generation: read the base agent directory, plan (pure), write
 * the generated agent directory.
 *
 * The base is what a plain Pi start would use: `PI_CODING_AGENT_DIR` (or `~/.pi/agent`), with
 * `~/.agents/skills` from HOME. The generated directory is
 * `<stateDir>/harnesses/<changeId>/<source>/<origin>/<id>` and is regenerated on every launch and
 * on every save; Pi's own writes inside it are not persisted.
 *
 * Writes are atomic per file (temporary file, then rename) and symlinks are swapped the same way,
 * so two regenerations can run at once and a Pi that is already running sees either the old or
 * the new file, never a half-written one. Shared state (credentials, models, trust, sessions,
 * packages) is a symlink into the base agent directory, so it stays shared across harnesses.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";

import type { ResolvedHarnessProfile } from "../harnessProfileDiscovery.ts";
import {
  generatedEnvironmentDir,
  harnessProfileScopeRoot,
  EnvironmentGenerationError,
  packageNameOf,
  planEnvironment,
  SHARED_STATE_NAMES,
  type EnvironmentBase,
  type EnvironmentDirectoryItem,
  type EnvironmentView,
  type EnvironmentGenerationPlan,
  type EnvironmentSharedState,
  type HarnessProfileScopeRoots,
} from "../environmentGeneration.ts";

/** The base Pi agent directory: the server's `PI_CODING_AGENT_DIR` when it has one, otherwise
 * `~/.pi/agent`. */
export const baseAgentDir = (): string => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

/** Where skills shared between agents live (`~/.agents/skills`), always discovered by Pi. */
export const homeSkillsDir = (homeDir: string = homedir()): string => join(homeDir, ".agents", "skills");

/** This checkout's Corvi extension, which every generated harness adds (unless it excludes
 * `corvi`). Resolved from this module so it works whatever the process's working directory is. */
export const corviExtensionDir = (): string =>
  fileURLToPath(new URL("../../../../integrations/pi/src", import.meta.url));

export type GenerateEnvironmentOptions = {
  readonly stateDir: string;
  readonly changeId: string;
  /** The resolved harness profile (its chain, fields, harness and warnings). */
  readonly harnessProfile: ResolvedHarnessProfile;
  /** The base agent directory; defaults to `baseAgentDir()`. */
  readonly agentDir?: string;
  /** The home directory skills hang off; defaults to `homedir()`. */
  readonly homeDir?: string;
  /** `~/.agents/skills`; defaults to `homeSkillsDir(homeDir)`. */
  readonly homeSkillsDir?: string;
  /** This checkout's `integrations/pi/src`; defaults to `corviExtensionDir()`. */
  readonly corviExtension?: string;
  /** The file's scope root for relative `include`/`exclude` paths. Takes precedence over
   * `scopeRoots`. */
  readonly scopeBase?: string;
  /** The change's scope roots; the harness's own scope selects the base. */
  readonly scopeRoots?: HarnessProfileScopeRoots;
  /** An explicit directory, for a pane whose environment is derived (a subagent's harness plus
   * its profile overlay). Defaults to the harness's own generated directory. */
  readonly dir?: string;
};

export type GeneratedEnvironment = {
  readonly dir: string;
  readonly view: EnvironmentView;
};

export type PreparedEnvironment = {
  readonly dir: string;
  readonly plan: EnvironmentGenerationPlan;
  readonly view: EnvironmentView;
};

const isNotFound = (cause: unknown): boolean =>
  cause instanceof Error && (cause as NodeJS.ErrnoException).code === "ENOENT";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readFailure = (path: string, message: string, cause?: unknown): EnvironmentGenerationError =>
  new EnvironmentGenerationError({
    operation: "read",
    path,
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const writeFailure = (path: string, message: string, cause?: unknown): EnvironmentGenerationError =>
  new EnvironmentGenerationError({
    operation: "write",
    path,
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const readText = (path: string): Effect.Effect<string | undefined, EnvironmentGenerationError> =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause) => cause,
    }).pipe(Effect.result);
    if (result._tag === "Success") return result.success;
    if (isNotFound(result.failure)) return undefined;
    return yield* readFailure(path, `cannot read ${path}`, result.failure);
  });

const readJsonObject = (
  path: string,
): Effect.Effect<Readonly<Record<string, unknown>> | undefined, EnvironmentGenerationError> =>
  Effect.gen(function* () {
    const text = yield* readText(path);
    if (text === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      return yield* readFailure(path, `${path} is not JSON`, cause);
    }
    if (!isRecord(parsed)) return yield* readFailure(path, `${path} is not a JSON object`);
    return parsed;
  });

type DirectoryEntry = { readonly name: string; readonly file: boolean };

const isDirectoryPath = (path: string): Effect.Effect<boolean | undefined, EnvironmentGenerationError> =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () => stat(path),
      catch: (cause) => cause,
    }).pipe(Effect.result);
    if (result._tag === "Success") return result.success.isDirectory();
    if (isNotFound(result.failure)) return undefined;
    return yield* readFailure(path, `cannot inspect ${path}`, result.failure);
  });

const readDirectory = (path: string): Effect.Effect<readonly DirectoryEntry[], EnvironmentGenerationError> =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () => readdir(path, { withFileTypes: true }),
      catch: (cause) => cause,
    }).pipe(Effect.result);
    if (result._tag === "Failure") {
      if (isNotFound(result.failure)) return [];
      return yield* readFailure(path, `cannot read ${path}`, result.failure);
    }
    const entries: DirectoryEntry[] = [];
    for (const entry of [...result.success].sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith(".")) continue;
      // A symlink is followed, because an installed skill or extension is commonly a link.
      const directory =
        entry.isDirectory() ||
        (entry.isSymbolicLink() && (yield* isDirectoryPath(join(path, entry.name))) === true);
      entries.push({ name: entry.name, file: !directory });
    }
    return entries;
  });

/** The extension entries Pi would discover in a directory: `*.ts`/`*.js` files and directories. */
const extensionItems = (
  directory: string,
  entries: readonly { readonly name: string; readonly file: boolean }[],
): readonly EnvironmentDirectoryItem[] =>
  entries.flatMap((entry) => {
    if (!entry.file) {
      return [{ name: entry.name, path: join(directory, entry.name), location: "extensions" as const }];
    }
    const match = /\.(?:[cm]?ts|[cm]?js)$/.exec(entry.name);
    if (match === null) return [];
    return [
      {
        name: entry.name.slice(0, -match[0].length),
        path: join(directory, entry.name),
        location: "extensions" as const,
      },
    ];
  });

/** The skill entries: directories and `*.md` files. */
const skillItems = (
  directory: string,
  location: EnvironmentDirectoryItem["location"],
  entries: readonly { readonly name: string; readonly file: boolean }[],
): readonly EnvironmentDirectoryItem[] =>
  entries.flatMap((entry) => {
    if (!entry.file) {
      return [{ name: entry.name, path: join(directory, entry.name), location }];
    }
    if (!entry.name.endsWith(".md")) return [];
    return [{ name: entry.name.slice(0, -3), path: join(directory, entry.name), location }];
  });

const packageItems = (
  settings: Readonly<Record<string, unknown>>,
): readonly {
  readonly name: string;
  readonly source: string;
  readonly entry: string | Readonly<Record<string, unknown>>;
}[] => {
  const raw = settings["packages"];
  if (!Array.isArray(raw)) return [];
  const items: {
    name: string;
    source: string;
    entry: string | Readonly<Record<string, unknown>>;
  }[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.trim() !== "") {
      items.push({ name: packageNameOf(entry), source: entry, entry });
      continue;
    }
    if (isRecord(entry) && typeof entry["source"] === "string" && entry["source"].trim() !== "") {
      const source = entry["source"];
      items.push({ name: packageNameOf(source), source, entry });
    }
  }
  return items;
};

const mcpNames = (
  path: string,
  mcp: Readonly<Record<string, unknown>>,
): Effect.Effect<readonly string[], EnvironmentGenerationError> => {
  const servers = mcp["mcpServers"];
  if (servers === undefined) return Effect.succeed([]);
  if (!isRecord(servers)) {
    return Effect.fail(readFailure(path, `${path}: mcpServers is not an object`));
  }
  return Effect.succeed(Object.keys(servers).sort());
};

/** Read the base agent directory into the plan's input. Missing files are an empty base; a
 * malformed JSON file is a read failure rather than a silently empty environment. */
const readEnvironmentBase = (input: {
  readonly agentDir: string;
  readonly homeDir: string;
  readonly homeSkillsDir: string;
  readonly corviExtension: string;
  readonly extensionsDir: string;
  readonly skillsDir: string;
}): Effect.Effect<EnvironmentBase, EnvironmentGenerationError> =>
  Effect.gen(function* () {
    const settings = (yield* readJsonObject(join(input.agentDir, "settings.json"))) ?? {};
    const mcpPath = join(input.agentDir, "mcp.json");
    const mcp = (yield* readJsonObject(mcpPath)) ?? {};
    const agentsMd = yield* readText(join(input.agentDir, "AGENTS.md"));
    const agentsOverride = (yield* readText(join(input.agentDir, "AGENTS.override.md"))) !== undefined;
    const extensionEntries = yield* readDirectory(input.extensionsDir);
    const skillEntries = yield* readDirectory(input.skillsDir);
    const agentsSkillEntries = yield* readDirectory(input.homeSkillsDir);
    const mcpServers = yield* mcpNames(mcpPath, mcp);
    return {
      paths: {
        agentDir: input.agentDir,
        extensionsDir: input.extensionsDir,
        skillsDir: input.skillsDir,
        homeDir: input.homeDir,
        homeSkillsDir: input.homeSkillsDir,
        corviExtension: input.corviExtension,
      },
      present: {
        extensionsDir: yield* directoryPresent(input.extensionsDir),
        skillsDir: yield* directoryPresent(input.skillsDir),
      },
      settings,
      mcp,
      ...(agentsMd === undefined ? {} : { agentsMd }),
      agentsOverride,
      catalogs: {
        extensions: extensionItems(input.extensionsDir, extensionEntries),
        skills: [
          ...skillItems(input.skillsDir, "skills", skillEntries),
          ...skillItems(input.homeSkillsDir, "agents-skills", agentsSkillEntries),
        ],
        packages: packageItems(settings),
        mcp: mcpServers,
      },
    };
  });

/** Whether a directory exists, kept separate from its entries so an empty directory is still
 * named in the generated settings (`present` is about existence, not contents). */
const directoryPresent = (path: string): Effect.Effect<boolean, EnvironmentGenerationError> =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () => stat(path),
      catch: (cause) => cause,
    }).pipe(Effect.result);
    if (result._tag === "Success") return result.success.isDirectory();
    if (isNotFound(result.failure)) return false;
    return yield* readFailure(path, `cannot inspect ${path}`, result.failure);
  });

const ensureDirectory = (path: string): Effect.Effect<void, EnvironmentGenerationError> =>
  Effect.tryPromise({
    try: () => mkdir(path, { recursive: true }),
    catch: (cause) => writeFailure(path, `cannot create ${path}`, cause),
  }).pipe(Effect.asVoid);

/** Write a file by writing a sibling and renaming it over the target: a concurrent reader sees a
 * complete old file or a complete new one. */
const removeQuietly = (path: string): Effect.Effect<void> =>
  Effect.tryPromise({ try: () => rm(path, { force: true }), catch: (cause) => cause }).pipe(
    Effect.catch(() => Effect.void),
  );

const writeFileAtomic = (path: string, content: string): Effect.Effect<void, EnvironmentGenerationError> =>
  Effect.gen(function* () {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const written = yield* Effect.tryPromise({
      try: () => writeFile(temporary, content, "utf8"),
      catch: (cause) => writeFailure(path, `cannot write ${path}`, cause),
    }).pipe(Effect.result);
    if (written._tag === "Failure") {
      yield* removeQuietly(temporary);
      return yield* written.failure;
    }
    const replaced = yield* Effect.tryPromise({
      try: () => rename(temporary, path),
      catch: (cause) => writeFailure(path, `cannot replace ${path}`, cause),
    }).pipe(Effect.result);
    if (replaced._tag === "Failure") {
      yield* removeQuietly(temporary);
      return yield* replaced.failure;
    }
  });

/** Point one shared-state name at the base agent directory. A real directory left there by an
 * older generation is replaced; the link itself is swapped by rename, so it is never absent. */
const ensureSharedState = (
  dir: string,
  state: EnvironmentSharedState,
): Effect.Effect<void, EnvironmentGenerationError> =>
  Effect.gen(function* () {
    if (state.kind === "directory") yield* ensureDirectory(state.target);
    const link = join(dir, state.name);
    const existing = yield* Effect.tryPromise({
      try: () => lstat(link),
      catch: (cause) => cause,
    }).pipe(Effect.result);
    if (existing._tag === "Success" && !existing.success.isSymbolicLink()) {
      yield* Effect.tryPromise({
        try: () => rm(link, { recursive: true, force: true }),
        catch: (cause) => writeFailure(link, `cannot replace ${link}`, cause),
      });
    }
    const temporary = `${link}.${randomUUID()}.tmp`;
    yield* Effect.tryPromise({
      try: () => symlink(state.target, temporary, state.kind === "directory" ? "dir" : "file"),
      catch: (cause) => writeFailure(link, `cannot link ${link}`, cause),
    });
    yield* Effect.tryPromise({
      try: () => rename(temporary, link),
      catch: (cause) => writeFailure(link, `cannot replace ${link}`, cause),
    });
  });

/** Links this generator owns. A conditional one (the base `AGENTS.override.md`, which only
 * applies when the harness leaves instructions alone) must not survive into a harness that no
 * longer wants it; a real file left by someone else is not ours to remove. */
const MANAGED_LINKS: readonly string[] = [
  ...SHARED_STATE_NAMES.map((state) => state.name),
  "AGENTS.override.md",
];

const removeStaleLink = (path: string): Effect.Effect<void, EnvironmentGenerationError> =>
  Effect.gen(function* () {
    const existing = yield* Effect.tryPromise({
      try: () => lstat(path),
      catch: (cause) => cause,
    }).pipe(Effect.result);
    if (existing._tag === "Failure") {
      if (isNotFound(existing.failure)) return;
      return yield* writeFailure(path, `cannot inspect ${path}`, existing.failure);
    }
    if (!existing.success.isSymbolicLink()) return;
    yield* Effect.tryPromise({
      try: () => rm(path, { force: true }),
      catch: (cause) => writeFailure(path, `cannot remove ${path}`, cause),
    });
  });

const writeEnvironment = (plan: EnvironmentGenerationPlan): Effect.Effect<void, EnvironmentGenerationError> =>
  Effect.gen(function* () {
    yield* ensureDirectory(plan.dir);
    yield* writeFileAtomic(join(plan.dir, "settings.json"), plan.settingsJson);
    yield* writeFileAtomic(join(plan.dir, "mcp.json"), plan.mcpJson);
    if (plan.agentsMd === undefined) {
      yield* Effect.tryPromise({
        try: () => rm(join(plan.dir, "AGENTS.md"), { force: true }),
        catch: (cause) => writeFailure(join(plan.dir, "AGENTS.md"), "cannot remove AGENTS.md", cause),
      });
    } else {
      yield* writeFileAtomic(join(plan.dir, "AGENTS.md"), plan.agentsMd);
    }
    const kept = new Set<string>();
    for (const state of plan.sharedState) {
      // Every file link points at a real file: a missing base file is absent, not a dangling
      // path. Directory targets are created by ensureSharedState and always linked.
      if (state.kind === "file") {
        const present = yield* Effect.tryPromise({
          try: () => lstat(state.target),
          catch: (cause) => cause,
        }).pipe(Effect.result);
        if (present._tag === "Failure") continue;
      }
      yield* ensureSharedState(plan.dir, state);
      kept.add(state.name);
    }
    for (const name of MANAGED_LINKS) {
      if (!kept.has(name)) yield* removeStaleLink(join(plan.dir, name));
    }
  });

/** Read the base and plan one harness profile's agent directory without writing anything. The page uses
 * this for its resolved view; `generateEnvironment` writes the same plan for the launch. */
export const previewEnvironment = (
  options: GenerateEnvironmentOptions,
): Effect.Effect<PreparedEnvironment, EnvironmentGenerationError> =>
  Effect.gen(function* () {
    if (options.harnessProfile.harness !== "pi") {
      return yield* new EnvironmentGenerationError({
        operation: "unsupported-harness",
        harness: options.harnessProfile.harness,
        message: `harness profile "${options.harnessProfile.key}" runs ${options.harnessProfile.harness}: only pi profiles generate an agent directory`,
      });
    }
    const agentDir = options.agentDir ?? baseAgentDir();
    const homeDir = options.homeDir ?? homedir();
    const skillsDir = options.homeSkillsDir ?? homeSkillsDir(homeDir);
    const corviExtension = options.corviExtension ?? corviExtensionDir();
    const scopeBase =
      options.scopeBase ??
      (options.scopeRoots === undefined
        ? undefined
        : harnessProfileScopeRoot(options.harnessProfile, options.scopeRoots));
    const base = yield* readEnvironmentBase({
      agentDir,
      homeDir,
      homeSkillsDir: skillsDir,
      corviExtension,
      extensionsDir: join(agentDir, "extensions"),
      skillsDir: join(agentDir, "skills"),
    });
    const dir =
      options.dir ?? generatedEnvironmentDir(options.stateDir, options.changeId, options.harnessProfile);
    const plan = planEnvironment({
      harnessProfile: options.harnessProfile,
      dir,
      ...(scopeBase === undefined ? {} : { scopeBase }),
      base,
    });
    return { dir, plan, view: plan.view };
  });

/** Generate the Pi agent directory for one resolved harness profile and return its resolved view. The
 * view is the plan's own, so the page and the launch read one answer. */
export const generateEnvironment = (
  options: GenerateEnvironmentOptions,
): Effect.Effect<GeneratedEnvironment, EnvironmentGenerationError> =>
  Effect.gen(function* () {
    const prepared = yield* previewEnvironment(options);
    yield* writeEnvironment(prepared.plan);
    return { dir: prepared.dir, view: prepared.view };
  });
