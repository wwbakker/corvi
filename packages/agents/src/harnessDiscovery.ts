/** Which harnesses a change can use, and what one resolves to — pure, over files already read.
 *
 * Discovery is the same four-scope rule as actions and subagent profiles (repository > workspace
 * > global > built-in, with the same id in two repositories kept apart). Resolution walks the
 * `harness:` chain from the selected file to a built-in end and merges the fields along the way:
 * scalars — nearest wins, absent inherits; sections — a mode replaces the section, include and
 * exclude append to the parent's lists.
 *
 * Two kinds of failure are reported separately, as the plan asks:
 *
 * - an error is a chain that cannot run at all: an unknown id, a cycle, a chain that switches
 *   agent, or an id several repositories define;
 * - a warning is a value that will not do what it says: an opencode harness setting fields only
 *   `pi` acts on. The generator adds unknown-name and unresolved-path warnings.
 *
 * The built-in ids (`pi`, `pi-bare`, `opencode`) are chain ends, so a user file may not take one:
 * it is skipped with that reason instead of breaking every chain that ends there.
 */
import { Result } from "effect";

import type { HarnessAgent, HarnessSource } from "@corvi/contracts/harnesses";
import { keyOf, mergeScopedFiles } from "@corvi/markdown/scoped";
import {
  emptyHarnessFields,
  mergeHarnessFields,
  type HarnessFields,
  type HarnessSectionName,
} from "./harnessFields.ts";
import { parseHarnessFile, BUILTIN_HARNESS_IDS, type Harness } from "./harnessFile.ts";

/** One file as discovery reads it: its id is the filename without `.md`. */
export type HarnessFileInput = {
  readonly id: string;
  readonly source: HarnessSource;
  /** The workspace id or repository name the file came from; part of the key. */
  readonly origin?: string;
  /** How the source is shown beside the label ("orders-api"). */
  readonly originLabel?: string;
  readonly text: string;
  /** False when the file could not be read: skipped with that reason rather than hidden. */
  readonly readable?: boolean;
};

/** One usable harness and where it came from. */
export type DiscoveredHarness = {
  /** Names the file's place, not its text: `repository:orders-api:reviewer`. */
  readonly key: string;
  readonly id: string;
  readonly source: HarnessSource;
  readonly origin?: string;
  readonly sourceLabel?: string;
  readonly harness: Harness;
};

export type SkippedHarnessFile = {
  readonly key: string;
  readonly reasons: readonly string[];
};

export type HarnessDiscovery = {
  readonly harnesses: readonly DiscoveredHarness[];
  /** Files that did not parse. They are skipped with their reasons and never hide the rest. */
  readonly skipped: readonly SkippedHarnessFile[];
};

export { keyOf };

/** Parse every file and apply the precedence rules. Order survives: files come in scope order
 * (built-in, global, workspace, repositories) and the list keeps it. */
export const mergeHarnessFiles = (files: readonly HarnessFileInput[]): HarnessDiscovery => {
  const builtinIds: readonly string[] = BUILTIN_HARNESS_IDS;
  const merged = mergeScopedFiles<HarnessFileInput, Harness>(files, (file) => {
    if (file.readable === false) return { reasons: ["cannot read this file"] };
    if (file.source !== "builtin" && builtinIds.includes(file.id)) {
      return {
        reasons: [
          `id "${file.id}" is a built-in harness: base a harness of your own on it instead of replacing it`,
        ],
      };
    }
    const result = parseHarnessFile(file.text);
    return Result.isSuccess(result) ? { value: result.success } : { reasons: result.failure.reasons };
  });
  return {
    harnesses: merged.entries.map(({ key, file, value }) => {
      const sourceLabel = file.originLabel ?? file.origin;
      return {
        key,
        id: file.id,
        source: file.source,
        ...(file.origin === undefined ? {} : { origin: file.origin }),
        ...(sourceLabel === undefined ? {} : { sourceLabel }),
        harness: value,
      };
    }),
    skipped: merged.skipped,
  };
};

// --- Resolution ------------------------------------------------------------------------------

/** One link of a resolved chain, nearest first, the built-in end last. */
export type HarnessChainLink = {
  readonly key: string;
  readonly id: string;
  readonly label: string;
  readonly source: HarnessSource;
  readonly sourceLabel?: string;
};

/** A value that resolves but will not do what the file says. */
export type HarnessWarning =
  | {
      /** A name an include or exclude list expects to find in the base agent directory. */
      readonly kind: "unknown-name";
      readonly section: HarnessSectionName;
      readonly name: string;
      readonly message: string;
    }
  | {
      /** A path entry no scope root can resolve (a built-in harness has no directory). */
      readonly kind: "unresolved-path";
      readonly section: HarnessSectionName;
      readonly entry: string;
      readonly message: string;
    }
  | {
      /** A field only `pi` acts on, set on an opencode harness. */
      readonly kind: "unsupported-field";
      readonly field: "effort" | "enabledModels" | "instructions" | HarnessSectionName;
      readonly message: string;
    };

/** Why a chain cannot be resolved. Every variant names the chain, so a log line is useful. */
export type HarnessResolutionError =
  | { readonly kind: "unknown-harness"; readonly id: string; readonly chain: readonly string[] }
  | {
      readonly kind: "ambiguous-harness";
      readonly id: string;
      readonly keys: readonly string[];
      readonly chain: readonly string[];
    }
  | { readonly kind: "cycle"; readonly chain: readonly string[] }
  | {
      /** The built-in end does not say which agent runs it. */
      readonly kind: "missing-agent";
      readonly chain: readonly string[];
    }
  | {
      /** Two files in the chain name different agents. */
      readonly kind: "agent-switch";
      readonly chain: readonly string[];
      readonly agents: readonly [HarnessAgent, HarnessAgent];
    };

/** A resolved harness: the environment it names, its agent, its chain and its warnings. */
export type ResolvedHarness = {
  /** The discovery key of the selected file (`repository:orders-api:reviewer`). */
  readonly key: string;
  readonly id: string;
  readonly label: string;
  readonly source: HarnessSource;
  readonly origin?: string;
  readonly sourceLabel?: string;
  readonly agent: HarnessAgent;
  /** The effective fields, merged from the built-in end outwards. */
  readonly fields: HarnessFields;
  /** The selected file first, the built-in end last. */
  readonly chain: readonly HarnessChainLink[];
  readonly warnings: readonly HarnessWarning[];
};

const chainOf = (links: readonly DiscoveredHarness[]): string[] => links.map((link) => link.id);

const linkOf = (found: DiscoveredHarness): HarnessChainLink => ({
  key: found.key,
  id: found.id,
  label: found.harness.label,
  source: found.source,
  ...(found.sourceLabel === undefined ? {} : { sourceLabel: found.sourceLabel }),
});

/** The one file an id names, given the scope of the file that referred to it. Several
 * repositories may define the same id — then the referring repository's own file wins, and an
 * otherwise ambiguous reference is an error naming the keys rather than a silent pick. */
const lookupHarness = (
  discovery: HarnessDiscovery,
  id: string,
  chain: readonly string[],
  referrer: DiscoveredHarness | undefined,
): Result.Result<DiscoveredHarness, HarnessResolutionError> => {
  const candidates = discovery.harnesses.filter((found) => found.id === id);
  if (candidates.length === 0) {
    return Result.fail({ kind: "unknown-harness", id, chain: [...chain, id] });
  }
  const only = candidates.length === 1 ? candidates[0] : undefined;
  if (only !== undefined) return Result.succeed(only);
  const ownRepository =
    referrer?.source === "repository" && referrer.origin !== undefined
      ? candidates.find((found) => found.source === "repository" && found.origin === referrer.origin)
      : undefined;
  if (ownRepository !== undefined) return Result.succeed(ownRepository);
  return Result.fail({
    kind: "ambiguous-harness",
    id,
    keys: candidates.map((found) => found.key),
    chain: [...chain, id],
  });
};

const SECTION_NAMES: readonly HarnessSectionName[] = ["extensions", "skills", "packages", "mcp"];

/** What an opencode harness cannot act on. `model` is the one field it does apply. */
const warningsFor = (agent: HarnessAgent, fields: HarnessFields): readonly HarnessWarning[] => {
  if (agent !== "opencode") return [];
  const warnings: HarnessWarning[] = [];
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

/** Walk one selected file's chain, merge it and derive its agent. */
const resolveChain = (
  discovery: HarnessDiscovery,
  start: DiscoveredHarness,
  overlay: HarnessFields | undefined,
): Result.Result<ResolvedHarness, HarnessResolutionError> => {
  const links: DiscoveredHarness[] = [start];
  const seen = new Set<string>([start.key]);
  let current = start;
  for (;;) {
    // A user file without `harness:` is based on the built-in `pi`: the plan calls pi the default
    // environment, and a chain still has to end at a built-in.
    const basedOn = current.harness.harness ?? (current.source === "builtin" ? undefined : "pi");
    if (basedOn === undefined) break;
    const found = lookupHarness(discovery, basedOn, chainOf(links), current);
    if (Result.isFailure(found)) return Result.fail(found.failure);
    if (seen.has(found.success.key)) {
      return Result.fail({ kind: "cycle", chain: [...chainOf(links), basedOn] });
    }
    current = found.success;
    links.push(current);
    seen.add(current.key);
  }

  // The built-in end is the last link; it must name the agent, and every link that names one has
  // to agree with it. A chain that switches agent is an error rather than a silent last-wins.
  const end = links[links.length - 1];
  if (end === undefined || end.harness.agent === undefined) {
    return Result.fail({ kind: "missing-agent", chain: chainOf(links) });
  }
  const declared = [...links.map((link) => link.harness.agent), overlay?.agent].filter(
    (agent): agent is HarnessAgent => agent !== undefined,
  );
  const agents = [...new Set(declared)];
  const first = agents[0];
  const conflicting = agents.find((agent) => agent !== first);
  if (first === undefined) return Result.fail({ kind: "missing-agent", chain: chainOf(links) });
  if (conflicting !== undefined) {
    return Result.fail({ kind: "agent-switch", chain: chainOf(links), agents: [first, conflicting] });
  }

  let fields = emptyHarnessFields;
  for (const link of [...links].reverse()) fields = mergeHarnessFields(fields, link.harness);
  if (overlay !== undefined) fields = mergeHarnessFields(fields, overlay);

  return Result.succeed({
    key: start.key,
    id: start.id,
    label: start.harness.label,
    source: start.source,
    ...(start.origin === undefined ? {} : { origin: start.origin }),
    ...(start.sourceLabel === undefined ? {} : { sourceLabel: start.sourceLabel }),
    agent: first,
    fields,
    chain: links.map(linkOf),
    warnings: warningsFor(first, fields),
  });
};

/** Resolve a harness by id, as a `harness:` field names it. `overlay` is the referencing file's
 * own harness fields (a subagent file's model, sections and instructions), merged on top of the
 * named harness. */
export const resolveHarness = (
  discovery: HarnessDiscovery,
  id: string,
  overlay?: HarnessFields,
): Result.Result<ResolvedHarness, HarnessResolutionError> => {
  const found = lookupHarness(discovery, id, [], undefined);
  return Result.isFailure(found)
    ? Result.fail(found.failure)
    : resolveChain(discovery, found.success, overlay);
};

/** Resolve the file a stored selection key names (`global:reviewer`,
 * `repository:orders-api:reviewer`). A key that is no longer discovered is an unknown harness,
 * which is how a pinned harness that disappeared fails with a clear error. */
export const resolveHarnessByKey = (
  discovery: HarnessDiscovery,
  key: string,
  overlay?: HarnessFields,
): Result.Result<ResolvedHarness, HarnessResolutionError> => {
  const found = discovery.harnesses.find((candidate) => candidate.key === key);
  if (found === undefined) {
    return Result.fail({ kind: "unknown-harness", id: key, chain: [key] });
  }
  return resolveChain(discovery, found, overlay);
};

/** One sentence for a log line, the pane or the Harnesses page. */
export const describeHarnessError = (error: HarnessResolutionError): string => {
  const chain = error.chain.join(" → ");
  switch (error.kind) {
    case "unknown-harness":
      return `unknown harness "${error.id}" (chain: ${chain})`;
    case "ambiguous-harness":
      return `harness "${error.id}" is defined by several repositories (${error.keys.join(", ")}); name one by its key`;
    case "cycle":
      return `harness chain loops: ${chain}`;
    case "missing-agent":
      return `the built-in end of ${chain} does not name an agent (pi or opencode)`;
    case "agent-switch":
      return `harness chain ${chain} mixes agents ${error.agents[0]} and ${error.agents[1]}`;
  }
};
