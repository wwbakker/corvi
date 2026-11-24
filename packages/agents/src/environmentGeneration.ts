/** What a resolved profile becomes as a Pi agent directory — pure, over a base agent directory
 * already read.
 *
 * The plan is the single answer the launch writes and the Harnesses page shows: the same
 * `EnvironmentGenerationPlan` carries the generated `settings.json`, `mcp.json` and `AGENTS.md`, the
 * shared-state links, and the resolved view (chain, every extension/skill/package/MCP server with
 * its effective state and why, and the warnings). Page and launch cannot disagree because they
 * are one call.
 *
 * Pi 1.6.0 notes the generator encodes:
 *
 * - a generated agent directory discovers neither `<agent-dir>/extensions` nor
 *   `<agent-dir>/skills`; listing a directory or an item adds it;
 * - `~/.agents/skills` is always discovered from HOME, so an agent-directory-only selection
 *   turns it off with `!<home>/.agents/skills/*` and re-adds an included skill with `+<path>`;
 * - `-<absolute path>` removes an exact discovered item, `!<glob>` a set;
 * - `!**` followed by `+path` does not work, so the section is disabled with `!<dir>/*`.
 *
 * The base agent directory contributes what a default Pi start would: the entries under its
 * `extensions/` and `skills/`, the `packages` in its `settings.json`, the servers in its
 * `mcp.json`, and its `AGENTS.md`. Corvi's own extension is added by every profile unless the
 * file excludes it by the name `corvi`.
 *
 * Paths use `/` on purpose: Corvi's server runs on macOS and Linux, and this module stays free of
 * `node:path` so the browser can import the view types.
 */
import { Schema } from "effect";

import type { Harness, HarnessSectionMode } from "@corvi/contracts/harness-profiles";
import type { HarnessProfileFields, HarnessSection, HarnessSectionName } from "./harnessProfileFields.ts";
import type { HarnessProfileWarning, ResolvedHarnessProfile } from "./harnessProfileDiscovery.ts";

/** Corvi's extension, by the name a profile file excludes it with. */
export const CORVI_EXTENSION_NAME = "corvi";

/** The files and directories a generated agent directory links to the base agent directory, so
 * credentials, model configuration, trust, sessions and packages stay shared with every other
 * profile. */
export const SHARED_STATE_NAMES: readonly { readonly name: string; readonly kind: "file" | "directory" }[] = [
  { name: "auth.json", kind: "file" },
  { name: "mcp-auth.json", kind: "file" },
  { name: "models.json", kind: "file" },
  { name: "models-store.json", kind: "file" },
  { name: "trust.json", kind: "file" },
  { name: "keybindings.json", kind: "file" },
  { name: "SYSTEM.md", kind: "file" },
  { name: "APPEND_SYSTEM.md", kind: "file" },
  { name: "sessions", kind: "directory" },
  { name: "npm", kind: "directory" },
  { name: "themes", kind: "directory" },
  { name: "prompts", kind: "directory" },
  { name: "bin", kind: "directory" },
];

/** One entry under the base agent directory's `extensions/` or `skills/`. */
export type EnvironmentDirectoryItem = {
  readonly name: string;
  readonly path: string;
  readonly location: "extensions" | "skills" | "agents-skills";
};

/** One package declared by the base `settings.json`, with the entry as written so a selected
 * package keeps its object form. */
export type EnvironmentPackageItem = {
  readonly name: string;
  readonly source: string;
  readonly entry: string | Readonly<Record<string, unknown>>;
};

/** What the base agent directory offers, read before planning. */
export type EnvironmentCatalogs = {
  readonly extensions: readonly EnvironmentDirectoryItem[];
  readonly skills: readonly EnvironmentDirectoryItem[];
  readonly packages: readonly EnvironmentPackageItem[];
  readonly mcp: readonly string[];
};

/** The absolute paths the plan resolves names and relative entries against. `agentDir` is the
 * base `~/.pi/agent` (or `PI_CODING_AGENT_DIR`); `corviExtension` is this checkout's
 * `integrations/pi/src`. */
export type EnvironmentBasePaths = {
  readonly agentDir: string;
  readonly extensionsDir: string;
  readonly skillsDir: string;
  readonly homeDir: string;
  readonly homeSkillsDir: string;
  readonly corviExtension: string;
};

/** The base state the plan starts from. `present` says whether a directory could be listed, so
 * an agent directory that has none is not named in the generated settings. */
export type EnvironmentBase = {
  readonly paths: EnvironmentBasePaths;
  readonly present: {
    readonly extensionsDir: boolean;
    readonly skillsDir: boolean;
  };
  readonly settings: Readonly<Record<string, unknown>>;
  readonly mcp: Readonly<Record<string, unknown>>;
  readonly agentsMd?: string;
  /** Whether the base has an `AGENTS.override.md`; the link is only made when it does. */
  readonly agentsOverride?: boolean;
  readonly catalogs: EnvironmentCatalogs;
};

/** The scope roots a relative `include`/`exclude` path resolves against: the global config
 * directory, a workspace's config directory, or a checkout root. */
export type HarnessProfileScopeRoots = {
  readonly global: string;
  readonly workspaces: readonly { readonly id: string; readonly dir: string }[];
  readonly repositories: readonly { readonly name: string; readonly dir: string }[];
};

/** The scope root of a discovered profile, or `undefined` for a built-in. */
export const harnessProfileScopeRoot = (
  profile: Pick<ResolvedHarnessProfile, "source" | "origin">,
  roots: HarnessProfileScopeRoots,
): string | undefined => {
  switch (profile.source) {
    case "global":
      return roots.global;
    case "workspace":
      return roots.workspaces.find((workspace) => workspace.id === profile.origin)?.dir;
    case "repository":
      return roots.repositories.find((repository) => repository.name === profile.origin)?.dir;
    case "builtin":
      return undefined;
  }
};

/** How one discovered item ends up in the generated environment. */
export type EnvironmentItemState = "included" | "excluded";
/** Why it is there, or not there. "added-by-corvi" is Corvi's own extension, which no base
 * directory declared. */
export type EnvironmentItemOrigin = "inherited" | "included" | "excluded" | "added-by-corvi";

export type EnvironmentItemLocation =
  "extensions" | "skills" | "agents-skills" | "settings" | "mcp" | "corvi" | "builtin" | "file";

/** One discovered item as the page shows it: what it is, its effective state, and where that
 * came from. A path entry that matched no base item is a `file` item. */
export type EnvironmentItem = {
  readonly name: string;
  readonly state: EnvironmentItemState;
  readonly origin: EnvironmentItemOrigin;
  readonly location: EnvironmentItemLocation;
  readonly path?: string;
  readonly source?: string;
  readonly byCorvi?: boolean;
};

export type EnvironmentSection = {
  readonly mode: HarnessSectionMode;
  readonly items: readonly EnvironmentItem[];
};

export type EnvironmentView = {
  readonly key: string;
  readonly id: string;
  readonly label: string;
  readonly source: ResolvedHarnessProfile["source"];
  readonly sourceLabel?: string;
  readonly harness: Harness;
  readonly chain: ResolvedHarnessProfile["chain"];
  readonly generatedDir: string;
  readonly model?: { readonly provider?: string; readonly id: string };
  readonly effort?: string;
  readonly enabledModels?: readonly string[];
  readonly instructions: {
    readonly origin: "profile" | "base" | "none";
    readonly text?: string;
  };
  readonly sections: {
    readonly extensions: EnvironmentSection;
    readonly skills: EnvironmentSection;
    readonly packages: EnvironmentSection;
    readonly mcp: EnvironmentSection;
  };
  readonly warnings: readonly HarnessProfileWarning[];
};

export type EnvironmentSharedState = {
  readonly name: string;
  readonly target: string;
  readonly kind: "file" | "directory";
};

/** Everything the writer needs, and the view the page shows. */
export type EnvironmentGenerationPlan = {
  readonly dir: string;
  readonly settingsJson: string;
  readonly mcpJson: string;
  /** The generated `AGENTS.md`; absent means the profile and the base both have none. */
  readonly agentsMd?: string;
  readonly sharedState: readonly EnvironmentSharedState[];
  readonly view: EnvironmentView;
};

export type EnvironmentGenerationOperation = "read" | "write" | "unsupported-harness";

/** A generation failure. `path` names the file for read/write failures; `agent` names the
 * unsupported agent when generation is asked for one. */
export class EnvironmentGenerationError extends Schema.TaggedError<EnvironmentGenerationError>()(
  "EnvironmentGenerationError",
  {
    operation: Schema.Literals(["read", "write", "unsupported-harness"]),
    path: Schema.optional(Schema.String),
    harness: Schema.optional(Schema.String),
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

// --- Path helpers ----------------------------------------------------------------------------

/** One directory name, with anything that could leave the tree or confuse a separator replaced.
 * A change id, workspace id, repository name and profile id are already file-shaped; this keeps a
 * foreign one from writing outside the state directory. */
const safeSegment = (value: string): string => {
  // A reversible escape: unsafe characters become `-x<codepoint>`, so two ids that differ only by
  // punctuation cannot land in the same directory. Leading dots are escaped too, so no segment is
  // `.` or `..` and nothing leaves the state tree.
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]/gu, (character) => `-x${character.codePointAt(0)?.toString(16) ?? "0"}`)
    .replace(/^\./u, "-x2e");
  return cleaned.length === 0 ? "unnamed" : cleaned;
};

/** A trailing slash never names anything. Stripped by hand rather than with `/\/+$/`: the regex
 * over a path a repository supplies is quadratic on a long run of slashes. */
const withoutTrailingSlashes = (path: string): string => {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 0x2f) end -= 1;
  return path.slice(0, end);
};

/** A ref suffix (`@v1.2.0`) is not part of a name. Removed only when the `@` follows the last
 * `/`, so a leading `@scope` and a path's own `@` stay: `/@[^/@]+$/` without the regex. */
const withoutRefSuffix = (source: string): string => {
  const at = source.lastIndexOf("@");
  if (at <= 0) return source;
  return source.lastIndexOf("/") < at ? source.slice(0, at) : source;
};

/** `<stateDir>/harnesses/<changeId>/<source>/<origin>/<id>` (no origin segment for built-in and
 * global harnesses). The path is stable across regenerations, which is what lets an existing
 * shell find the same profile on its next `pi` start. */
export const generatedEnvironmentDir = (
  stateDir: string,
  changeId: string,
  profile: Pick<ResolvedHarnessProfile, "source" | "origin" | "id">,
): string => {
  const segments = [
    environmentStateDir(stateDir, changeId),
    safeSegment(profile.source),
    ...(profile.origin === undefined ? [] : [safeSegment(profile.origin)]),
    safeSegment(profile.id),
  ];
  return segments.join("/");
};

/** The generated state of one change: everything under it goes when the change is archived. */
export const environmentStateDir = (stateDir: string, changeId: string): string =>
  [withoutTrailingSlashes(stateDir), "harnesses", safeSegment(changeId)].join("/");

const joinPath = (base: string, entry: string): string => `${withoutTrailingSlashes(base)}/${entry}`;

const normalizePath = (path: string): string => {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push("..");
      continue;
    }
    parts.push(part);
  }
  const joined = parts.join("/");
  if (absolute) return `/${joined}`;
  return joined === "" ? "." : joined;
};

const isWithin = (directory: string, path: string): boolean => {
  const base = normalizePath(directory);
  const candidate = normalizePath(path);
  return candidate === base || candidate.startsWith(`${base}/`);
};

const lastSegment = (path: string): string => normalizePath(path).split("/").at(-1) ?? path;

/** Whether an entry names a path rather than an item in a base catalogue. */
const isPathEntry = (entry: string): boolean =>
  entry === "." ||
  entry === ".." ||
  entry === "~" ||
  entry.startsWith("./") ||
  entry.startsWith("../") ||
  entry.startsWith("~/") ||
  entry.startsWith("/") ||
  entry.includes("/") ||
  entry.includes("\\");

/** Resolve a path entry against the file's scope root, expanding `~` from the home directory.
 * `undefined` when a relative path has no scope root (a built-in profile). */
const resolvePathEntry = (
  entry: string,
  scopeBase: string | undefined,
  homeDir: string,
): string | undefined => {
  if (entry === "~") return normalizePath(homeDir);
  if (entry.startsWith("~/")) return normalizePath(joinPath(homeDir, entry.slice(2)));
  if (entry.startsWith("/")) return normalizePath(entry);
  return scopeBase === undefined ? undefined : normalizePath(joinPath(scopeBase, entry));
};

const effectiveMode = (section: HarnessSection): HarnessSectionMode => section.mode ?? "all";

const matchesDirectoryItem = (item: EnvironmentDirectoryItem, entry: string): boolean =>
  item.name === entry || lastSegment(item.path) === entry;

const dedupe = <T>(values: readonly T[]): readonly T[] => [...new Set(values)];

const warningKey = (warning: HarnessProfileWarning): string => {
  switch (warning.kind) {
    case "unknown-name":
      return `unknown:${warning.section}:${warning.name}`;
    case "unresolved-path":
      return `path:${warning.section}:${warning.entry}`;
    case "unsupported-field":
      return `unsupported:${warning.field}`;
  }
};

const dedupeWarnings = (warnings: readonly HarnessProfileWarning[]): readonly HarnessProfileWarning[] => {
  const seen = new Set<string>();
  const kept: HarnessProfileWarning[] = [];
  for (const warning of warnings) {
    const key = warningKey(warning);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(warning);
  }
  return kept;
};

// --- Sections --------------------------------------------------------------------------------

type PackageEntry = string | Readonly<Record<string, unknown>>;

type SectionPlan<T extends string | PackageEntry = string> = {
  readonly entries: readonly T[];
  readonly items: readonly EnvironmentItem[];
  readonly warnings: readonly HarnessProfileWarning[];
};

const SECTION_LABEL: Record<HarnessSectionName, { readonly one: string; readonly list: string }> = {
  extensions: { one: "extension", list: "extensions" },
  skills: { one: "skill", list: "skills" },
  packages: { one: "package", list: "packages" },
  mcp: { one: "MCP server", list: "mcp" },
};

/** Another section that does contain this name: the actionable half of an unknown-name warning.
 * A profile that put a skill under `extensions.include` is told where it belongs. */
const crossSectionHint = (
  section: HarnessSectionName,
  name: string,
  base: EnvironmentBase,
): string | undefined => {
  const inSection = (other: HarnessSectionName): boolean => {
    switch (other) {
      case "extensions":
        return base.catalogs.extensions.some((item) => item.name === name);
      case "skills":
        return base.catalogs.skills.some((item) => item.name === name);
      case "packages":
        return base.catalogs.packages.some((item) => item.name === name || item.source === name);
      case "mcp":
        return base.catalogs.mcp.includes(name);
    }
  };
  const other = (["extensions", "skills", "packages", "mcp"] as const).find(
    (candidate) => candidate !== section && inSection(candidate),
  );
  const article = (word: string): string => (/^[aeiou]/i.test(word) ? "an" : "a");
  return other === undefined
    ? undefined
    : `"${name}" is ${article(SECTION_LABEL[other].one)} ${SECTION_LABEL[other].one}, not ${article(SECTION_LABEL[section].one)} ${SECTION_LABEL[section].one} — list it under ${SECTION_LABEL[other].list}.include`;
};

const unknownName = (
  section: HarnessSectionName,
  name: string,
  where: string,
  hint?: string,
): HarnessProfileWarning => ({
  kind: "unknown-name",
  section,
  name,
  message: hint ?? `no ${section} named "${name}" in ${where}`,
});

const unresolvedPath = (
  section: HarnessSectionName,
  entry: string,
  source: ResolvedHarnessProfile["source"],
): HarnessProfileWarning => ({
  kind: "unresolved-path",
  section,
  entry,
  message: `"${entry}" is a path, but a ${source} profile has no directory to resolve it from`,
});

type ClassifiedEntries = {
  readonly names: readonly string[];
  readonly paths: readonly string[];
};

/** Split one include/exclude list into catalogue names and resolved absolute paths, warning about
 * names nothing offers and paths no scope root can resolve. */
const classifyEntries = (
  section: HarnessSectionName,
  entries: readonly string[],
  matches: (name: string) => boolean,
  scopeBase: string | undefined,
  homeDir: string,
  source: ResolvedHarnessProfile["source"],
  where: string,
  hintFor?: (name: string) => string | undefined,
): { readonly classified: ClassifiedEntries; readonly warnings: readonly HarnessProfileWarning[] } => {
  const names: string[] = [];
  const paths: string[] = [];
  const warnings: HarnessProfileWarning[] = [];
  for (const entry of entries) {
    if (isPathEntry(entry)) {
      const path = resolvePathEntry(entry, scopeBase, homeDir);
      if (path === undefined) warnings.push(unresolvedPath(section, entry, source));
      else paths.push(path);
      continue;
    }
    if (matches(entry)) names.push(entry);
    else warnings.push(unknownName(section, entry, where, hintFor?.(entry)));
  }
  return { classified: { names, paths }, warnings };
};

/** A base settings resource entry keeps its meaning in the generated settings: a relative path
 * resolves from the agent directory, `~` from HOME, and a `builtin:` name is not a path at all. */
const absoluteResourcePath = (entry: string, base: EnvironmentBasePaths): string => {
  const prefix = entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-") ? entry[0] : "";
  const rest = prefix === "" ? entry : entry.slice(1);
  if (rest === "" || rest.startsWith("/") || rest.startsWith("builtin:")) return entry;
  if (rest === "~") return `${prefix}${normalizePath(base.homeDir)}`;
  if (rest.startsWith("~/")) return `${prefix}${normalizePath(joinPath(base.homeDir, rest.slice(2)))}`;
  return `${prefix}${normalizePath(joinPath(base.agentDir, rest))}`;
};

/** The base settings' own resource entries for one list, inherited by every profile. */
const baseResourceEntries = (
  settings: Readonly<Record<string, unknown>>,
  key: "extensions" | "skills",
): readonly string[] => {
  const raw = settings[key];
  return Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : [];
};

/** A `builtin:<name>` entry, with the one-letter Pi prefix (`-builtin:mcp` disables it). */
const builtinEntryOf = (entry: string): { readonly name: string; readonly excluded: boolean } | undefined => {
  const prefix = entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-") ? entry[0] : "";
  const name = prefix === "" ? entry : entry.slice(1);
  return name.startsWith("builtin:") ? { name, excluded: prefix === "-" || prefix === "!" } : undefined;
};

const planExtensions = (
  profile: ResolvedHarnessProfile,
  base: EnvironmentBase,
  scopeBase: string | undefined,
): SectionPlan => {
  const section = profile.fields.extensions;
  const mode = effectiveMode(section);
  const baseItems = base.catalogs.extensions;
  const corviPath = normalizePath(base.paths.corviExtension);
  const known = (name: string): boolean =>
    name === CORVI_EXTENSION_NAME || baseItems.some((item) => matchesDirectoryItem(item, name));
  // A `builtin:` name is Pi's own extension namespace (`builtin:mcp`), not a base file: it is
  // passed through and never reported as an unknown base name.
  const builtinOf = (entries: readonly string[]): readonly string[] =>
    entries.filter((entry) => entry.startsWith("builtin:"));
  const baseEntries = (entries: readonly string[]): readonly string[] =>
    entries.filter((entry) => !entry.startsWith("builtin:"));
  const includeBuiltins = builtinOf(section.include).filter(
    (entry) => !builtinOf(section.exclude).includes(entry),
  );
  const excludeBuiltins = builtinOf(section.exclude);
  const includes = classifyEntries(
    "extensions",
    baseEntries(section.include),
    known,
    scopeBase,
    base.paths.homeDir,
    profile.source,
    "the base agent directory",
    (name) => crossSectionHint("extensions", name, base),
  );
  const excludes = classifyEntries(
    "extensions",
    baseEntries(section.exclude),
    known,
    scopeBase,
    base.paths.homeDir,
    profile.source,
    "the base agent directory",
    (name) => crossSectionHint("extensions", name, base),
  );

  const inherited = baseResourceEntries(base.settings, "extensions").map((entry) =>
    absoluteResourcePath(entry, base.paths),
  );
  const inheritedBuiltins = inherited
    .map((entry) => builtinEntryOf(entry))
    .filter((entry): entry is { readonly name: string; readonly excluded: boolean } => entry !== undefined);
  const inheritedOthers = inherited.filter((entry) => builtinEntryOf(entry) === undefined);

  const includedItems = new Set(
    baseItems.filter((item) => includes.classified.names.some((name) => matchesDirectoryItem(item, name))),
  );
  const excludedItems = new Set(
    baseItems.filter((item) => excludes.classified.names.some((name) => matchesDirectoryItem(item, name))),
  );
  const includePaths = new Set(includes.classified.paths);
  const excludePaths = new Set(excludes.classified.paths);
  const corviExcluded =
    excludes.classified.names.includes(CORVI_EXTENSION_NAME) ||
    [...excludePaths].some((path) => isWithin(path, corviPath));
  const corviIncluded = !corviExcluded;

  const coveredByExclude = (path: string): boolean =>
    [...excludePaths].some((excluded) => isWithin(excluded, path));
  const excludedItem = (item: (typeof baseItems)[number]): boolean =>
    excludedItems.has(item) || coveredByExclude(item.path);

  const entries: string[] = [];
  // Inherited settings entries keep their order and their prefixes. Mode none drops the non-builtin
  // ones, but a base `-builtin:mcp` (or `+builtin:...`) always survives.
  if (mode === "all") entries.push(...inheritedOthers);
  entries.push(...inheritedBuiltins.map((entry) => (entry.excluded ? `-${entry.name}` : `+${entry.name}`)));
  if (mode === "all" && base.present.extensionsDir) entries.push(normalizePath(base.paths.extensionsDir));
  if (mode === "none") {
    for (const item of includedItems) {
      if (!excludedItem(item)) entries.push(normalizePath(item.path));
    }
  }
  for (const path of includePaths) {
    if (path === corviPath) continue;
    if (mode === "all" && isWithin(base.paths.extensionsDir, path)) continue;
    if (coveredByExclude(path)) continue;
    entries.push(path);
  }
  if (corviIncluded) entries.push(corviPath);
  // Built-ins load regardless of the section mode, so including or excluding one is always an
  // entry. A profile include after a base exclusion re-enables it.
  for (const builtin of includeBuiltins) entries.push(`+${builtin}`);
  for (const builtin of excludeBuiltins) entries.push(`-${builtin}`);
  if (mode === "all") {
    for (const item of excludedItems) entries.push(`-${normalizePath(item.path)}`);
    for (const path of excludePaths) if (path !== corviPath) entries.push(`-${path}`);
  }

  const items: EnvironmentItem[] = baseItems.map((item) => {
    const explicitlyExcluded =
      excludedItems.has(item) || [...excludePaths].some((path) => isWithin(path, item.path));
    const includedByEntry =
      includedItems.has(item) || [...includePaths].some((path) => isWithin(path, item.path));
    const included = !explicitlyExcluded && (mode === "all" || includedByEntry);
    return {
      name: item.name,
      path: normalizePath(item.path),
      state: included ? "included" : "excluded",
      origin: included ? (includedByEntry ? "included" : "inherited") : "excluded",
      location: item.location,
    };
  });
  for (const path of includePaths) {
    if (path === corviPath || baseItems.some((item) => normalizePath(item.path) === path)) continue;
    items.push({
      name: lastSegment(path),
      path,
      state: "included",
      origin: "included",
      location: "file",
    });
  }
  const builtinStates = new Map<string, EnvironmentItem>();
  const rememberBuiltin = (name: string, excluded: boolean): void => {
    builtinStates.set(name, {
      name,
      state: excluded ? "excluded" : "included",
      origin: excluded ? "excluded" : "included",
      location: "builtin",
    });
  };
  for (const entry of inheritedBuiltins) rememberBuiltin(entry.name, entry.excluded);
  for (const builtin of includeBuiltins) rememberBuiltin(builtin, false);
  for (const builtin of excludeBuiltins) rememberBuiltin(builtin, true);
  items.push(...[...builtinStates.values()].sort((left, right) => left.name.localeCompare(right.name)));
  items.push({
    name: CORVI_EXTENSION_NAME,
    path: corviPath,
    state: corviIncluded ? "included" : "excluded",
    origin: corviIncluded ? "added-by-corvi" : "excluded",
    location: "corvi",
    byCorvi: true,
  });

  return {
    entries: dedupe(entries),
    items,
    warnings: dedupeWarnings([...includes.warnings, ...excludes.warnings]),
  };
};

const planSkills = (
  profile: ResolvedHarnessProfile,
  base: EnvironmentBase,
  scopeBase: string | undefined,
): SectionPlan => {
  const section = profile.fields.skills;
  const mode = effectiveMode(section);
  const items = base.catalogs.skills;
  const known = (name: string): boolean => items.some((item) => matchesDirectoryItem(item, name));
  const includes = classifyEntries(
    "skills",
    section.include,
    known,
    scopeBase,
    base.paths.homeDir,
    profile.source,
    "the base agent directory or ~/.agents/skills",
    (name) => crossSectionHint("skills", name, base),
  );
  const excludes = classifyEntries(
    "skills",
    section.exclude,
    known,
    scopeBase,
    base.paths.homeDir,
    profile.source,
    "the base agent directory or ~/.agents/skills",
    (name) => crossSectionHint("skills", name, base),
  );

  const inherited = baseResourceEntries(base.settings, "skills").map((entry) =>
    absoluteResourcePath(entry, base.paths),
  );
  const inheritedBuiltins = inherited.filter((entry) => builtinEntryOf(entry) !== undefined);
  const inheritedOthers = inherited.filter((entry) => builtinEntryOf(entry) === undefined);

  const includedItems = new Set(
    items.filter((item) => includes.classified.names.some((name) => matchesDirectoryItem(item, name))),
  );
  const excludedItems = new Set(
    items.filter((item) => excludes.classified.names.some((name) => matchesDirectoryItem(item, name))),
  );
  const includePaths = new Set(includes.classified.paths);
  const excludePaths = new Set(excludes.classified.paths);
  const homeSkills = normalizePath(base.paths.homeSkillsDir);

  const coveredByExclude = (path: string): boolean =>
    [...excludePaths].some((excluded) => isWithin(excluded, path));
  const excludedItem = (item: (typeof items)[number]): boolean =>
    excludedItems.has(item) || coveredByExclude(item.path);

  const entries: string[] = [];
  if (mode === "all") entries.push(...inheritedOthers);
  // Mode none drops the base skills entries except any `builtin:` ones, as promised for every
  // section; Pi has no built-in skills today, but the rule must not silently lose a future one.
  entries.push(...inheritedBuiltins);
  if (mode === "all" && base.present.skillsDir) entries.push(normalizePath(base.paths.skillsDir));
  if (mode === "none") entries.push(`!${homeSkills}/*`);
  for (const item of includedItems) {
    if (mode === "all" || excludedItem(item)) continue;
    const path = normalizePath(item.path);
    entries.push(item.location === "agents-skills" ? `+${path}` : path);
  }
  for (const path of includePaths) {
    if (coveredByExclude(path)) continue;
    const knownItem = items.find((item) => normalizePath(item.path) === path);
    const fromHome = isWithin(homeSkills, path) || knownItem?.location === "agents-skills";
    if (mode === "all" && (knownItem !== undefined || fromHome)) continue;
    entries.push(fromHome ? `+${path}` : path);
  }
  if (mode === "all") {
    for (const item of excludedItems) entries.push(`-${normalizePath(item.path)}`);
    for (const path of excludePaths) entries.push(`-${path}`);
  }

  const resolved: EnvironmentItem[] = items.map((item) => {
    const explicitlyExcluded =
      excludedItems.has(item) || [...excludePaths].some((path) => isWithin(path, item.path));
    const includedByEntry =
      includedItems.has(item) || [...includePaths].some((path) => isWithin(path, item.path));
    const included = !explicitlyExcluded && (mode === "all" || includedByEntry);
    return {
      name: item.name,
      path: normalizePath(item.path),
      state: included ? "included" : "excluded",
      origin: included ? (includedByEntry ? "included" : "inherited") : "excluded",
      location: item.location,
    };
  });
  for (const path of includePaths) {
    if (items.some((item) => normalizePath(item.path) === path)) continue;
    resolved.push({
      name: lastSegment(path),
      path,
      state: "included",
      origin: "included",
      location: "file",
    });
  }
  return {
    entries: dedupe(entries),
    items: resolved,
    warnings: dedupeWarnings([...includes.warnings, ...excludes.warnings]),
  };
};

/** The package name the page and a `packages:` entry use: the npm name without a version, the
 * repository's last path segment, or a local directory's name. */
export const packageNameOf = (source: string): string => {
  const stripped = source.replace(/^(npm|git):/, "");
  if (/^https?:\/\//.test(stripped)) {
    const noRef = withoutRefSuffix(stripped);
    const path = noRef
      .replace(/^https?:\/\//, "")
      .split("/")
      .slice(1)
      .join("/");
    return lastSegment(path === "" ? noRef : path);
  }
  if (stripped.startsWith("@")) {
    const at = stripped.lastIndexOf("@");
    return at > 0 ? stripped.slice(0, at) : stripped;
  }
  if (stripped.startsWith(".") || stripped.startsWith("/") || stripped.startsWith("~")) {
    return lastSegment(withoutTrailingSlashes(stripped));
  }
  if (stripped.includes("/")) {
    return lastSegment(withoutTrailingSlashes(withoutRefSuffix(stripped)));
  }
  const at = stripped.indexOf("@");
  return at > 0 ? stripped.slice(0, at) : stripped;
};

/** A local package source is made absolute because the generated `settings.json` lives elsewhere;
 * npm, git and URL sources are identity and stay as written. */
const absolutePackageSource = (source: string, paths: EnvironmentBasePaths): string => {
  if (source === "~") return normalizePath(paths.homeDir);
  if (source.startsWith("~/")) return normalizePath(joinPath(paths.homeDir, source.slice(2)));
  if (source === "." || source === ".." || source.startsWith("./") || source.startsWith("../")) {
    return normalizePath(joinPath(paths.agentDir, source));
  }
  return source;
};

const packageEntryOf = (
  item: EnvironmentPackageItem,
  paths: EnvironmentBasePaths,
): string | Readonly<Record<string, unknown>> =>
  typeof item.entry === "string"
    ? absolutePackageSource(item.entry, paths)
    : { ...item.entry, source: absolutePackageSource(item.source, paths) };

const isPackagePathEntry = (entry: string): boolean =>
  entry === "." ||
  entry === ".." ||
  entry.startsWith("./") ||
  entry.startsWith("../") ||
  entry.startsWith("/") ||
  entry.startsWith("~/") ||
  entry === "~";

const planPackages = (
  profile: ResolvedHarnessProfile,
  base: EnvironmentBase,
  scopeBase: string | undefined,
): SectionPlan<PackageEntry> => {
  const section = profile.fields.packages;
  const mode = effectiveMode(section);
  const items = base.catalogs.packages;
  const matches = (item: EnvironmentPackageItem, entry: string): boolean =>
    item.name === entry || item.source === entry;
  const resolvePackagePaths = (
    entries: readonly string[],
  ): { readonly paths: ReadonlySet<string>; readonly warnings: readonly HarnessProfileWarning[] } => {
    const paths = new Set<string>();
    const warnings: HarnessProfileWarning[] = [];
    for (const entry of entries.filter(isPackagePathEntry)) {
      const path = resolvePathEntry(entry, scopeBase, base.paths.homeDir);
      if (path === undefined) warnings.push(unresolvedPath("packages", entry, profile.source));
      else paths.add(path);
    }
    return { paths, warnings };
  };
  const includes = resolvePackagePaths(section.include);
  const excludes = resolvePackagePaths(section.exclude);
  const includePaths = includes.paths;
  const excludePaths = excludes.paths;
  const includedNames = section.include
    .filter((entry) => !isPackagePathEntry(entry))
    .filter((entry) => items.some((item) => matches(item, entry)));
  const unknownIncludes = section.include
    .filter((entry) => !isPackagePathEntry(entry))
    .filter((entry) => !items.some((item) => matches(item, entry)))
    .map((entry) =>
      unknownName("packages", entry, "the base settings.json", crossSectionHint("packages", entry, base)),
    );
  const excludedNames = section.exclude
    .filter((entry) => !isPackagePathEntry(entry))
    .filter((entry) => items.some((item) => matches(item, entry)));
  const unknownExcludes = section.exclude
    .filter((entry) => !isPackagePathEntry(entry))
    .filter((entry) => !items.some((item) => matches(item, entry)))
    .map((entry) =>
      unknownName("packages", entry, "the base settings.json", crossSectionHint("packages", entry, base)),
    );
  const included = new Set(items.filter((item) => includedNames.some((name) => matches(item, name))));
  const excluded = new Set(items.filter((item) => excludedNames.some((name) => matches(item, name))));
  const selected = items.filter(
    (item) =>
      !excluded.has(item) &&
      ![...excludePaths].some((path) => absolutePackageSource(item.source, base.paths) === path) &&
      (mode === "all" || included.has(item)),
  );
  // A path in both lists is excluded: exclusion wins, as in every other section.
  const pathEntries = [...includePaths].filter((path) => !excludePaths.has(path));

  return {
    entries: [...selected.map((item) => packageEntryOf(item, base.paths)), ...pathEntries],
    items: [
      ...items.map((item): EnvironmentItem => {
        const isExcluded = excluded.has(item) || (mode === "none" && !included.has(item));
        return {
          name: item.name,
          source: absolutePackageSource(item.source, base.paths),
          state: isExcluded ? "excluded" : "included",
          origin: isExcluded ? "excluded" : included.has(item) ? "included" : "inherited",
          location: "settings",
        };
      }),
      ...pathEntries.map((path): EnvironmentItem => ({
        name: lastSegment(path),
        path,
        state: "included",
        origin: "included",
        location: "file",
      })),
    ],
    warnings: dedupeWarnings([
      ...unknownIncludes,
      ...unknownExcludes,
      ...includes.warnings,
      ...excludes.warnings,
    ]),
  };
};

const planMcp = (profile: ResolvedHarnessProfile, base: EnvironmentBase): SectionPlan => {
  const section = profile.fields.mcp;
  const mode = effectiveMode(section);
  const items = base.catalogs.mcp;
  const included = new Set(items.filter((item) => section.include.includes(item)));
  const excluded = new Set(items.filter((item) => section.exclude.includes(item)));
  const unknownIncludes = section.include
    .filter((entry) => !items.includes(entry))
    .map((entry) => unknownName("mcp", entry, "the base mcp.json", crossSectionHint("mcp", entry, base)));
  const unknownExcludes = section.exclude
    .filter((entry) => !items.includes(entry))
    .map((entry) => unknownName("mcp", entry, "the base mcp.json", crossSectionHint("mcp", entry, base)));
  const selected = items.filter((item) => !excluded.has(item) && (mode === "all" || included.has(item)));

  return {
    entries: selected,
    items: items.map((item) => {
      const isExcluded = excluded.has(item) || (mode === "none" && !included.has(item));
      return {
        name: item,
        state: isExcluded ? "excluded" : "included",
        origin: isExcluded ? "excluded" : included.has(item) ? "included" : "inherited",
        location: "mcp",
      };
    }),
    warnings: dedupeWarnings([...unknownIncludes, ...unknownExcludes]),
  };
};

// --- The plan --------------------------------------------------------------------------------

const splitModel = (model: string): { readonly provider?: string; readonly id: string } => {
  const slash = model.indexOf("/");
  return slash > 0 ? { provider: model.slice(0, slash), id: model.slice(slash + 1) } : { id: model };
};

const mcpServersOf = (mcp: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const servers = mcp["mcpServers"];
  return typeof servers === "object" && servers !== null && !Array.isArray(servers)
    ? (servers as Readonly<Record<string, unknown>>)
    : {};
};

export type PlanEnvironmentInput = {
  readonly harnessProfile: ResolvedHarnessProfile;
  readonly dir: string;
  /** The file's scope root for relative `include`/`exclude` paths. */
  readonly scopeBase?: string;
  readonly base: EnvironmentBase;
};

/** Plan the generated agent directory and its resolved view. Pure: the same inputs always answer
 * the same settings, files and view, which is what keeps the page and the launch in agreement. */
/** Resource lists copied from the base settings (`prompts`, `themes`) keep their meaning: their
 * relative paths resolved from the base agent directory, not from the generated one. */
const absoluteResourceList = (value: unknown, base: EnvironmentBasePaths): unknown =>
  Array.isArray(value)
    ? value.map((entry) => (typeof entry === "string" ? absoluteResourcePath(entry, base) : entry))
    : value;

export const planEnvironment = (input: PlanEnvironmentInput): EnvironmentGenerationPlan => {
  const { harnessProfile: profile, base, dir } = input;
  const extensions = planExtensions(profile, base, input.scopeBase);
  const skills = planSkills(profile, base, input.scopeBase);
  const packages = planPackages(profile, base, input.scopeBase);
  const mcp = planMcp(profile, base);

  const settings: Record<string, unknown> = { ...base.settings };
  for (const key of ["prompts", "themes"] as const) {
    if (settings[key] !== undefined) settings[key] = absoluteResourceList(settings[key], base.paths);
  }
  const model = profile.fields.model === undefined ? undefined : splitModel(profile.fields.model);
  if (model !== undefined) {
    if (model.provider !== undefined) settings["defaultProvider"] = model.provider;
    settings["defaultModel"] = model.id;
  }
  if (profile.fields.effort !== undefined) settings["defaultThinkingLevel"] = profile.fields.effort;
  if (profile.fields.enabledModels !== undefined) {
    settings["enabledModels"] = [...profile.fields.enabledModels];
  }
  settings["extensions"] = [...extensions.entries];
  settings["skills"] = [...skills.entries];
  settings["packages"] = [...packages.entries];

  const baseServers = mcpServersOf(base.mcp);
  const selectedServers = Object.fromEntries(mcp.entries.map((name) => [name, baseServers[name]]));
  const mcpJson = { ...base.mcp, mcpServers: selectedServers };

  const instructions =
    profile.fields.instructions !== undefined
      ? { origin: "profile" as const, text: profile.fields.instructions }
      : base.agentsMd !== undefined
        ? { origin: "base" as const, text: base.agentsMd }
        : { origin: "none" as const };

  const warnings = dedupeWarnings([
    ...profile.warnings,
    ...extensions.warnings,
    ...skills.warnings,
    ...packages.warnings,
    ...mcp.warnings,
  ]);

  return {
    dir,
    settingsJson: `${JSON.stringify(settings, null, 2)}\n`,
    mcpJson: `${JSON.stringify(mcpJson, null, 2)}\n`,
    ...(instructions.text === undefined ? {} : { agentsMd: instructions.text }),
    sharedState: [
      ...SHARED_STATE_NAMES.map(({ name, kind }) => ({
        name,
        kind,
        target: normalizePath(joinPath(base.paths.agentDir, name)),
      })),
      // The base's override applies only when the profile leaves instructions to the base.
      ...(instructions.origin === "profile" || base.agentsOverride !== true
        ? []
        : [
            {
              name: "AGENTS.override.md",
              kind: "file" as const,
              target: normalizePath(joinPath(base.paths.agentDir, "AGENTS.override.md")),
            },
          ]),
    ],
    view: {
      key: profile.key,
      id: profile.id,
      label: profile.label,
      source: profile.source,
      ...(profile.sourceLabel === undefined ? {} : { sourceLabel: profile.sourceLabel }),
      harness: profile.harness,
      chain: profile.chain,
      generatedDir: dir,
      ...(model === undefined ? {} : { model }),
      ...(profile.fields.effort === undefined ? {} : { effort: profile.fields.effort }),
      ...(profile.fields.enabledModels === undefined ? {} : { enabledModels: profile.fields.enabledModels }),
      instructions,
      sections: {
        extensions: { mode: effectiveMode(profile.fields.extensions), items: extensions.items },
        skills: { mode: effectiveMode(profile.fields.skills), items: skills.items },
        packages: { mode: effectiveMode(profile.fields.packages), items: packages.items },
        mcp: { mode: effectiveMode(profile.fields.mcp), items: mcp.items },
      },
      warnings,
    },
  };
};

/** Resolve a subagent profile's relative include/exclude paths against the profile file's scope,
 * leaving names alone. The merged profile keeps its own paths relative to the profile file. */
export const resolveOverlayPaths = (
  fields: HarnessProfileFields,
  scopeBase: string | undefined,
  homeDir: string,
): HarnessProfileFields => {
  const section = (value: HarnessSection, pathLike: (entry: string) => boolean): HarnessSection => ({
    ...(value.mode === undefined ? {} : { mode: value.mode }),
    include: value.include.map((entry) =>
      pathLike(entry) ? (resolvePathEntry(entry, scopeBase, homeDir) ?? entry) : entry,
    ),
    exclude: value.exclude.map((entry) =>
      pathLike(entry) ? (resolvePathEntry(entry, scopeBase, homeDir) ?? entry) : entry,
    ),
  });
  return {
    ...fields,
    extensions: section(fields.extensions, isPathEntry),
    skills: section(fields.skills, isPathEntry),
    packages: section(fields.packages, isPackagePathEntry),
  };
};
