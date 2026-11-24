/** Which harness profiles a change can use, and what one resolves to — pure, over files already
 * read.
 *
 * Discovery is the same four-scope rule as actions and subagent profiles (repository > workspace
 * > global > built-in, with the same id in two repositories kept apart). Resolution walks the
 * `basedOnHarnessProfile:` chain from the selected file to a built-in end and merges the fields
 * along the way: scalars — nearest wins, absent inherits; sections — a mode replaces the section,
 * include and exclude append to the parent's lists.
 *
 * Two kinds of failure are reported separately:
 *
 * - an error is a chain that cannot run at all: an unknown id, a cycle, a chain that switches
 *   harness, or an id several repositories define;
 * - a warning is a value that will not do what it says: an opencode profile setting fields only
 *   `pi` acts on. The generator adds unknown-name and unresolved-path warnings.
 *
 * The built-in ids (`pi`, `pi-bare`, `opencode`) are chain ends, so a user file may not take one:
 * it is skipped with that reason instead of breaking every chain that ends there.
 */
import { Result } from "effect";

import type { Harness, HarnessProfileSource } from "@corvi/contracts/harness-profiles";
import { keyOf, mergeScopedFiles } from "@corvi/markdown/scoped";
import {
  emptyHarnessProfileFields,
  mergeHarnessProfileFields,
  type HarnessProfileFields,
  type HarnessProfileSectionName,
} from "./harnessProfileFields.ts";
import {
  BUILTIN_HARNESS_PROFILE_IDS,
  parseHarnessProfileFile,
  type HarnessProfile,
} from "./harnessProfileFile.ts";

/** One file as discovery reads it: its id is the filename without `.md`. */
export type HarnessProfileFileInput = {
  readonly id: string;
  readonly source: HarnessProfileSource;
  /** The workspace id or repository name the file came from; part of the key. */
  readonly origin?: string;
  /** How the source is shown beside the label ("orders-api"). */
  readonly originLabel?: string;
  readonly text: string;
  /** False when the file could not be read: skipped with that reason rather than hidden. */
  readonly readable?: boolean;
};

/** One usable harness profile and where it came from. */
export type DiscoveredHarnessProfile = {
  /** Names the file's place, not its text: `repository:orders-api:reviewer`. */
  readonly key: string;
  readonly id: string;
  readonly source: HarnessProfileSource;
  readonly origin?: string;
  readonly sourceLabel?: string;
  readonly harnessProfile: HarnessProfile;
};

export type SkippedHarnessProfileFile = {
  readonly key: string;
  readonly reasons: readonly string[];
};

export type HarnessProfileDiscovery = {
  readonly profiles: readonly DiscoveredHarnessProfile[];
  /** Files that did not parse. They are skipped with their reasons and never hide the rest. */
  readonly skipped: readonly SkippedHarnessProfileFile[];
};

export { keyOf };

/** Whether a reference names a file by its stored key (`global:normaal`) rather than by id
 * (`normaal`). A key always starts with one of the four scopes and a colon. */
export const isHarnessProfileKey = (reference: string): boolean =>
  reference.startsWith("builtin:") ||
  reference.startsWith("global:") ||
  reference.startsWith("workspace:") ||
  reference.startsWith("repository:");

/** Parse every file and apply the precedence rules. Order survives: files come in scope order
 * (built-in, global, workspace, repositories) and the list keeps it. */
export const mergeHarnessProfileFiles = (
  files: readonly HarnessProfileFileInput[],
): HarnessProfileDiscovery => {
  const builtinIds: readonly string[] = BUILTIN_HARNESS_PROFILE_IDS;
  const merged = mergeScopedFiles<HarnessProfileFileInput, HarnessProfile>(files, (file) => {
    if (file.readable === false) return { reasons: ["cannot read this file"] };
    if (file.source !== "builtin" && builtinIds.includes(file.id)) {
      return {
        reasons: [
          `id "${file.id}" is a built-in harness profile: base a profile of your own on it instead of replacing it`,
        ],
      };
    }
    const result = parseHarnessProfileFile(file.text);
    return Result.isSuccess(result) ? { value: result.success } : { reasons: result.failure.reasons };
  });
  return {
    profiles: merged.entries.map(({ key, file, value }) => {
      const sourceLabel = file.originLabel ?? file.origin;
      return {
        key,
        id: file.id,
        source: file.source,
        ...(file.origin === undefined ? {} : { origin: file.origin }),
        ...(sourceLabel === undefined ? {} : { sourceLabel }),
        harnessProfile: value,
      };
    }),
    skipped: merged.skipped,
  };
};

// --- Resolution ------------------------------------------------------------------------------

/** One link of a resolved chain, nearest first, the built-in end last. */
export type HarnessProfileChainLink = {
  readonly key: string;
  readonly id: string;
  readonly label: string;
  readonly source: HarnessProfileSource;
  readonly sourceLabel?: string;
};

/** A value that resolves but will not do what the file says. */
export type HarnessProfileWarning =
  | {
      /** A name an include or exclude list expects to find in the base agent directory. */
      readonly kind: "unknown-name";
      readonly section: HarnessProfileSectionName;
      readonly name: string;
      readonly message: string;
    }
  | {
      /** A path entry no scope root can resolve (a built-in harness has no directory). */
      readonly kind: "unresolved-path";
      readonly section: HarnessProfileSectionName;
      readonly entry: string;
      readonly message: string;
    }
  | {
      /** A field only `pi` acts on, set on an opencode profile. */
      readonly kind: "unsupported-field";
      readonly field: "effort" | "enabledModels" | "instructions" | HarnessProfileSectionName;
      readonly message: string;
    };

/** Why a chain cannot be resolved. Every variant names the chain, so a log line is useful. */
export type HarnessProfileResolutionError =
  | { readonly kind: "unknown-harness-profile"; readonly id: string; readonly chain: readonly string[] }
  | {
      readonly kind: "ambiguous-harness-profile";
      readonly id: string;
      readonly keys: readonly string[];
      readonly chain: readonly string[];
    }
  | { readonly kind: "cycle"; readonly chain: readonly string[] }
  | {
      /** The built-in end does not say which harness runs it. */
      readonly kind: "missing-harness";
      readonly chain: readonly string[];
    }
  | {
      /** Two files in the chain name different harnesses. */
      readonly kind: "harness-switch";
      readonly chain: readonly string[];
      readonly harnesses: readonly [Harness, Harness];
    };

/** A resolved harness profile: the environment it names, its harness, its chain and its warnings. */
export type ResolvedHarnessProfile = {
  /** The discovery key of the selected file (`repository:orders-api:reviewer`). */
  readonly key: string;
  readonly id: string;
  readonly label: string;
  readonly source: HarnessProfileSource;
  readonly origin?: string;
  readonly sourceLabel?: string;
  readonly harness: Harness;
  /** The effective fields, merged from the built-in end outwards. */
  readonly fields: HarnessProfileFields;
  /** The selected file first, the built-in end last. */
  readonly chain: readonly HarnessProfileChainLink[];
  readonly warnings: readonly HarnessProfileWarning[];
};

const chainOf = (links: readonly DiscoveredHarnessProfile[]): string[] => links.map((link) => link.id);

const linkOf = (found: DiscoveredHarnessProfile): HarnessProfileChainLink => ({
  key: found.key,
  id: found.id,
  label: found.harnessProfile.label,
  source: found.source,
  ...(found.sourceLabel === undefined ? {} : { sourceLabel: found.sourceLabel }),
});

/** The one file an id names, given the scope of the file that referred to it. Several
 * repositories may define the same id — then the referring repository's own file wins, and an
 * otherwise ambiguous reference is an error naming the keys rather than a silent pick. */
const lookupHarnessProfile = (
  discovery: HarnessProfileDiscovery,
  id: string,
  chain: readonly string[],
  referrer: DiscoveredHarnessProfile | undefined,
): Result.Result<DiscoveredHarnessProfile, HarnessProfileResolutionError> => {
  const candidates = discovery.profiles.filter((found) => found.id === id);
  if (candidates.length === 0) {
    return Result.fail({ kind: "unknown-harness-profile", id, chain: [...chain, id] });
  }
  const only = candidates.length === 1 ? candidates[0] : undefined;
  if (only !== undefined) return Result.succeed(only);
  const ownRepository =
    referrer?.source === "repository" && referrer.origin !== undefined
      ? candidates.find((found) => found.source === "repository" && found.origin === referrer.origin)
      : undefined;
  if (ownRepository !== undefined) return Result.succeed(ownRepository);
  return Result.fail({
    kind: "ambiguous-harness-profile",
    id,
    keys: candidates.map((found) => found.key),
    chain: [...chain, id],
  });
};

const SECTION_NAMES: readonly HarnessProfileSectionName[] = ["extensions", "skills", "packages", "mcp"];

/** What an opencode profile cannot act on. `model` is the one field it does apply. */
const warningsFor = (harness: Harness, fields: HarnessProfileFields): readonly HarnessProfileWarning[] => {
  if (harness !== "opencode") return [];
  const warnings: HarnessProfileWarning[] = [];
  if (fields.effort !== undefined) {
    warnings.push({
      kind: "unsupported-field",
      field: "effort",
      message: "effort is not supported for opencode yet",
    });
  }
  if (fields.enabledModels !== undefined) {
    warnings.push({
      kind: "unsupported-field",
      field: "enabledModels",
      message: "enabledModels is not supported for opencode yet",
    });
  }
  if (fields.instructions !== undefined) {
    warnings.push({
      kind: "unsupported-field",
      field: "instructions",
      message: "instructions are not supported for opencode yet",
    });
  }
  for (const section of SECTION_NAMES) {
    const value = fields[section];
    if (value.mode !== undefined || value.include.length > 0 || value.exclude.length > 0) {
      warnings.push({
        kind: "unsupported-field",
        field: section,
        message: `${section} are not supported for opencode yet`,
      });
    }
  }
  return warnings;
};

/** Walk one selected file's chain, merge it and derive its harness. */
const resolveChain = (
  discovery: HarnessProfileDiscovery,
  start: DiscoveredHarnessProfile,
  overlay: HarnessProfileFields | undefined,
): Result.Result<ResolvedHarnessProfile, HarnessProfileResolutionError> => {
  const links: DiscoveredHarnessProfile[] = [start];
  const seen = new Set<string>([start.key]);
  let current = start;
  for (;;) {
    // A user file without `basedOnHarnessProfile:` is based on the built-in `pi`: the plan calls
    // pi the default environment, and a chain still has to end at a built-in.
    const basedOn =
      current.harnessProfile.basedOnHarnessProfile ?? (current.source === "builtin" ? undefined : "pi");
    if (basedOn === undefined) break;
    const found = lookupHarnessProfile(discovery, basedOn, chainOf(links), current);
    if (Result.isFailure(found)) return Result.fail(found.failure);
    if (seen.has(found.success.key)) {
      return Result.fail({ kind: "cycle", chain: [...chainOf(links), basedOn] });
    }
    current = found.success;
    links.push(current);
    seen.add(current.key);
  }

  // The built-in end is the last link; it must name the harness, and every link that names one
  // has to agree with it. A chain that switches harness is an error rather than a silent
  // last-wins.
  const end = links[links.length - 1];
  if (end === undefined || end.harnessProfile.harness === undefined) {
    return Result.fail({ kind: "missing-harness", chain: chainOf(links) });
  }
  const declared = [...links.map((link) => link.harnessProfile.harness), overlay?.harness].filter(
    (harness): harness is Harness => harness !== undefined,
  );
  const harnesses = [...new Set(declared)];
  const first = harnesses[0];
  const conflicting = harnesses.find((harness) => harness !== first);
  if (first === undefined) return Result.fail({ kind: "missing-harness", chain: chainOf(links) });
  if (conflicting !== undefined) {
    return Result.fail({ kind: "harness-switch", chain: chainOf(links), harnesses: [first, conflicting] });
  }

  let fields = emptyHarnessProfileFields;
  for (const link of [...links].reverse()) fields = mergeHarnessProfileFields(fields, link.harnessProfile);
  if (overlay !== undefined) fields = mergeHarnessProfileFields(fields, overlay);

  return Result.succeed({
    key: start.key,
    id: start.id,
    label: start.harnessProfile.label,
    source: start.source,
    ...(start.origin === undefined ? {} : { origin: start.origin }),
    ...(start.sourceLabel === undefined ? {} : { sourceLabel: start.sourceLabel }),
    harness: first,
    fields,
    chain: links.map(linkOf),
    warnings: warningsFor(first, fields),
  });
};

/** Resolve the profile a reference names — an id (`normaal`) or a key (`global:normaal`) — as
 * `basedOnHarnessProfile:` spells it. `overlay` is the referencing file's own fields (a subagent
 * profile's model, sections and instructions), merged on top of the named profile. */
export const resolveHarnessProfile = (
  discovery: HarnessProfileDiscovery,
  reference: string,
  overlay?: HarnessProfileFields,
): Result.Result<ResolvedHarnessProfile, HarnessProfileResolutionError> => {
  if (isHarnessProfileKey(reference)) return resolveHarnessProfileByKey(discovery, reference, overlay);
  const found = lookupHarnessProfile(discovery, reference, [], undefined);
  return Result.isFailure(found)
    ? Result.fail(found.failure)
    : resolveChain(discovery, found.success, overlay);
};

/** Resolve the file a stored selection key names (`global:reviewer`,
 * `repository:orders-api:reviewer`). A key that is no longer discovered is an unknown profile,
 * which is how a pinned profile that disappeared fails with a clear error. */
export const resolveHarnessProfileByKey = (
  discovery: HarnessProfileDiscovery,
  key: string,
  overlay?: HarnessProfileFields,
): Result.Result<ResolvedHarnessProfile, HarnessProfileResolutionError> => {
  const found = discovery.profiles.find((candidate) => candidate.key === key);
  if (found === undefined) {
    return Result.fail({ kind: "unknown-harness-profile", id: key, chain: [key] });
  }
  return resolveChain(discovery, found, overlay);
};

/** One sentence for a log line, the pane or the Harness profiles page. */
export const describeHarnessProfileError = (error: HarnessProfileResolutionError): string => {
  const chain = error.chain.join(" → ");
  switch (error.kind) {
    case "unknown-harness-profile":
      return `unknown harness profile "${error.id}" (chain: ${chain})`;
    case "ambiguous-harness-profile":
      return `harness profile "${error.id}" is defined by several repositories (${error.keys.join(", ")}); name one by its key`;
    case "cycle":
      return `harness profile chain loops: ${chain}`;
    case "missing-harness":
      return `the built-in end of ${chain} does not name a harness (pi or opencode)`;
    case "harness-switch":
      // The usual way to see this is a file that declares a program instead of basing itself on
      // the built-in that runs it, so the sentence says what to write instead.
      return `harness profile chain ${chain} mixes harnesses ${error.harnesses[0]} and ${error.harnesses[1]}; a file inherits the program from what it is based on, so base it on the built-in for ${error.harnesses[1]} instead of declaring harness:`;
  }
};
