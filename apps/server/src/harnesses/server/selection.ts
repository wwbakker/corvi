/** Which harness a change's panes use: discovery, the settings-chain defaults, and the change's
 * own selectors.
 *
 * Precedence, from the plan: a change's `userHarness` (or a subagent's profile) wins, then the
 * change's `subagentHarness` for new subagents, then the workspace default, then the global
 * default, then the built-in `pi`. The stored values are discovery keys; a subagent profile names
 * a harness id, which resolves through the same discovery.
 */
import { Effect, Result } from "effect";

import {
  describeHarnessError,
  resolveHarness,
  resolveHarnessByKey,
  type HarnessDiscovery,
  type HarnessResolutionError,
  type ResolvedHarness,
} from "@corvi/agents/harness-discovery";
import { harnessScopeRoot, type HarnessScopeRoots } from "@corvi/agents/harness-generation";
import { discoverHarnesses } from "@corvi/agents/node";
import type { HarnessSelectionDto } from "@corvi/contracts/harnesses";
import type { Change } from "@corvi/changes/record";
import { fileRootsFor, type FileRoots } from "../../capabilities/fileRoots.ts";
import { settingsOf, workspaceOf } from "../../workspace/server/index.ts";

/** The harness a change's user panes start when nothing else says. */
export const DEFAULT_HARNESS_KEY = "builtin:pi";

export type HarnessKind = "user" | "subagents";

export const harnessRootsFor = (change: Change): Effect.Effect<FileRoots> =>
  fileRootsFor(change, "harnesses");

export const harnessDiscoveryFor = (change: Change): Effect.Effect<HarnessDiscovery> =>
  Effect.flatMap(harnessRootsFor(change), discoverHarnesses);

/** The roots relative include/exclude paths resolve against, for this change. */
export const harnessScopeRootsFor = (change: Change): Effect.Effect<HarnessScopeRoots> =>
  Effect.map(harnessRootsFor(change), (roots) => roots.bases);

export const harnessScopeBaseFor = (
  change: Change,
  harness: Pick<ResolvedHarness, "source" | "origin">,
): Effect.Effect<string | undefined> =>
  Effect.map(harnessScopeRootsFor(change), (roots) => harnessScopeRoot(harness, roots));

/** The settings-chain defaults: the workspace's `harnessDefaults`, then the global one. */
export const harnessDefaultsFor = (change: Change): { readonly user: string; readonly subagents: string } => {
  const defaults = settingsOf(workspaceOf(change)).harnessDefaults ?? {};
  return {
    user: defaults.user ?? DEFAULT_HARNESS_KEY,
    subagents: defaults.subagents ?? DEFAULT_HARNESS_KEY,
  };
};

export const harnessSelectionFor = (change: Change): HarnessSelectionDto => {
  const defaults = harnessDefaultsFor(change);
  return {
    ...(change.userHarness === undefined ? {} : { userHarness: change.userHarness }),
    ...(change.subagentHarness === undefined ? {} : { subagentHarness: change.subagentHarness }),
    userDefault: defaults.user,
    subagentDefault: defaults.subagents,
  };
};

/** The key a pane of this kind starts: the change's selector, else the default. */
export const selectedHarnessKey = (change: Change, kind: HarnessKind): string => {
  const defaults = harnessDefaultsFor(change);
  return kind === "user"
    ? (change.userHarness ?? defaults.user)
    : (change.subagentHarness ?? defaults.subagents);
};

export const resolveSelection = (
  change: Change,
  discovery: HarnessDiscovery,
  kind: HarnessKind,
): Result.Result<ResolvedHarness, HarnessResolutionError> =>
  resolveHarnessByKey(discovery, selectedHarnessKey(change, kind));

/** Resolve a subagent's harness: its pinned key when it has one, otherwise the profile's id (or,
 * for a record from before either existed, its stored agent's built-in id). The profile's harness
 * fields overlay the named harness. */
export const resolveSubagentHarness = (
  discovery: HarnessDiscovery,
  input: {
    readonly pinnedKey?: string;
    readonly profileHarness?: string;
    /** The change's `subagentHarness`, when the profile names none. */
    readonly changeKey?: string;
    /** The workspace/global subagent default key. */
    readonly defaultKey?: string;
    readonly agent?: string;
    readonly overlay?: Parameters<typeof resolveHarness>[2];
  },
): Result.Result<ResolvedHarness, HarnessResolutionError> => {
  if (input.pinnedKey !== undefined) return resolveHarnessByKey(discovery, input.pinnedKey, input.overlay);
  if (input.profileHarness !== undefined)
    return resolveHarness(discovery, input.profileHarness, input.overlay);
  if (input.changeKey !== undefined) return resolveHarnessByKey(discovery, input.changeKey, input.overlay);
  if (input.defaultKey !== undefined) return resolveHarnessByKey(discovery, input.defaultKey, input.overlay);
  return resolveHarness(discovery, input.agent ?? "pi", input.overlay);
};

export const harnessErrorText = (error: HarnessResolutionError): string => describeHarnessError(error);
