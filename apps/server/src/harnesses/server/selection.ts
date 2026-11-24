/** Which harness profile a change's panes use: discovery, the settings-chain defaults, and the
 * change's own selectors.
 *
 * Precedence, from the plan:
 *
 * - user panes: the change's `userHarnessProfile` → its workspace default → the global default →
 *   the built-in `pi`;
 * - subagents: the record's pin → the profile's `basedOnHarnessProfile` → the change's
 *   `subagentHarnessProfile` → the settings default → the built-in for the profile's `harness`.
 *
 * A profile's `harness:` names the program, never a profile. When the ambient default runs a
 * different program than the profile asks for, the built-in profile for that program answers
 * instead of failing: a template that says `harness: opencode` wants opencode, not an error about
 * the person's default.
 *
 * Stored values are discovery keys. A `basedOnHarnessProfile` may be an id or a key.
 */
import { Effect, Result } from "effect";

import {
  describeHarnessProfileError,
  resolveHarnessProfile,
  resolveHarnessProfileByKey,
  type HarnessProfileDiscovery,
  type HarnessProfileResolutionError,
  type ResolvedHarnessProfile,
} from "@corvi/agents/harness-profile-discovery";
import { harnessProfileScopeRoot, type HarnessProfileScopeRoots } from "@corvi/agents/environment-generation";
import { discoverHarnessProfiles } from "@corvi/agents/node";
import { harnessProfileFieldsOf, type SubagentProfile } from "@corvi/agents/subagent-profile";
import type { Harness, HarnessProfileSelectionDto } from "@corvi/contracts/harness-profiles";
import type { SubagentRecord } from "@corvi/agents/instance";
import type { Change } from "@corvi/changes/record";
import { fileRootsFor, type FileRoots } from "../../capabilities/fileRoots.ts";
import { settingsOf, workspaceOf } from "../../workspace/server/index.ts";

/** The harness profile a change's panes start when nothing else says. */
export const DEFAULT_HARNESS_PROFILE_KEY = "builtin:pi";

export type HarnessProfileKind = "user" | "subagents";

/** Where the chosen harness profile came from: the profile's own base, the change's selector, or
 * the settings chain. The card and the CLI show it, so a pane never has to be guessed at. */
export type HarnessProfileSource = "profile" | "change" | "default";

export const harnessProfileRootsFor = (change: Change): Effect.Effect<FileRoots> =>
  fileRootsFor(change, "harnesses");

export const harnessProfileDiscoveryFor = (change: Change): Effect.Effect<HarnessProfileDiscovery> =>
  Effect.flatMap(harnessProfileRootsFor(change), discoverHarnessProfiles);

/** The roots relative include/exclude paths resolve against, for this change. */
export const harnessProfileScopeRootsFor = (change: Change): Effect.Effect<HarnessProfileScopeRoots> =>
  Effect.map(harnessProfileRootsFor(change), (roots) => roots.bases);

export const harnessProfileScopeBaseFor = (
  change: Change,
  profile: Pick<ResolvedHarnessProfile, "source" | "origin">,
): Effect.Effect<string | undefined> =>
  Effect.map(harnessProfileScopeRootsFor(change), (roots) => harnessProfileScopeRoot(profile, roots));

/** The defaults exactly as the settings chain stores them: absent means "not configured". */
export const configuredHarnessProfileDefaults = (
  change: Change,
): {
  readonly user?: string;
  readonly subagents?: string;
} => {
  const defaults = settingsOf(workspaceOf(change)).harnessProfileDefaults ?? {};
  return {
    ...(defaults.user === undefined ? {} : { user: defaults.user }),
    ...(defaults.subagents === undefined ? {} : { subagents: defaults.subagents }),
  };
};

/** The defaults in effect: the configured values, or the built-in `pi` profile. */
export const harnessProfileDefaultsFor = (
  change: Change,
): {
  readonly user: string;
  readonly subagents: string;
} => {
  const defaults = configuredHarnessProfileDefaults(change);
  return {
    user: defaults.user ?? DEFAULT_HARNESS_PROFILE_KEY,
    subagents: defaults.subagents ?? DEFAULT_HARNESS_PROFILE_KEY,
  };
};

export const harnessProfileSelectionFor = (change: Change): HarnessProfileSelectionDto => {
  const defaults = harnessProfileDefaultsFor(change);
  return {
    ...(change.userHarnessProfile === undefined ? {} : { userHarnessProfile: change.userHarnessProfile }),
    ...(change.subagentHarnessProfile === undefined
      ? {}
      : { subagentHarnessProfile: change.subagentHarnessProfile }),
    userDefault: defaults.user,
    subagentDefault: defaults.subagents,
  };
};

/** The key a pane of this kind starts: the change's selector, else the default. */
export const selectedHarnessProfileKey = (change: Change, kind: HarnessProfileKind): string => {
  const defaults = harnessProfileDefaultsFor(change);
  return kind === "user"
    ? (change.userHarnessProfile ?? defaults.user)
    : (change.subagentHarnessProfile ?? defaults.subagents);
};

/** A pane's chosen harness profile: the key it selected, and what that key resolves to. The key
 * is answered even when resolution fails, so the refusal names the file the person chose. */
export type PaneHarnessProfileSelection = {
  readonly key: string;
  readonly resolved: Result.Result<ResolvedHarnessProfile, HarnessProfileResolutionError>;
};

/** The harness profile a pane of this kind starts: the change's selector, else the default. */
export const resolvePaneHarnessProfile = (
  change: Change,
  discovery: HarnessProfileDiscovery,
  kind: HarnessProfileKind,
): PaneHarnessProfileSelection => {
  const key = selectedHarnessProfileKey(change, kind);
  return { key, resolved: resolveHarnessProfileByKey(discovery, key) };
};

/** A subagent's harness profile, and why it is that one. */
export type SubagentHarnessProfileDecision = {
  readonly resolved: ResolvedHarnessProfile;
  readonly source: HarnessProfileSource;
  /** Why the program's built-in profile answered instead of the ambient default, when it did. */
  readonly note?: string;
};

const builtinKeyFor = (harness: Harness): string => `builtin:${harness}`;

/** The built-in profile of the program a profile names, or the failure that sent us there. */
const builtinFallback = (
  discovery: HarnessProfileDiscovery,
  harness: Harness,
  overlay: ReturnType<typeof harnessProfileFieldsOf> | undefined,
  original: HarnessProfileResolutionError,
): Result.Result<ResolvedHarnessProfile, HarnessProfileResolutionError> => {
  const fallback = resolveHarnessProfileByKey(discovery, builtinKeyFor(harness), overlay);
  return Result.isFailure(fallback) ? Result.fail(original) : fallback;
};

/**
 * Resolve the harness profile a subagent runs in, from what is known at creation and at reopen.
 *
 * - the record's pin wins, and its provenance is reported as stored;
 * - otherwise the profile's own base, then the change's selector, then the settings default;
 * - a default that runs a different program than the profile asks for is replaced by that
 *   program's built-in profile, with a note;
 * - a profile whose file is gone falls back to the record's program.
 */
export const resolveSubagentHarnessProfile = (input: {
  readonly change: Change;
  readonly discovery: HarnessProfileDiscovery;
  /** The discovered profile, when its file is still there. */
  readonly profile?: SubagentProfile;
  /** The record, on a reopen: its pin, the provenance stored with it, and its program. */
  readonly record?: Pick<SubagentRecord, "harnessProfileKey" | "harnessProfileFrom" | "harness">;
  /** The fields the profile overlays on the chosen harness profile. */
  readonly overlay?: ReturnType<typeof harnessProfileFieldsOf>;
}): Result.Result<SubagentHarnessProfileDecision, HarnessProfileResolutionError> => {
  const { change, discovery, profile, record, overlay } = input;
  const pin = record?.harnessProfileKey;
  const pinSource = record?.harnessProfileFrom;
  const program = record?.harness;
  if (pin !== undefined) {
    const resolved = resolveHarnessProfileByKey(discovery, pin, overlay);
    return Result.isFailure(resolved)
      ? Result.fail(resolved.failure)
      : Result.succeed({ resolved: resolved.success, source: pinSource ?? "profile" });
  }

  if (profile?.basedOnHarnessProfile !== undefined) {
    const resolved = resolveHarnessProfile(discovery, profile.basedOnHarnessProfile, overlay);
    return Result.isFailure(resolved)
      ? Result.fail(resolved.failure)
      : Result.succeed({ resolved: resolved.success, source: "profile" });
  }

  if (change.subagentHarnessProfile !== undefined) {
    const resolved = resolveHarnessProfileByKey(discovery, change.subagentHarnessProfile, overlay);
    return Result.isFailure(resolved)
      ? Result.fail(resolved.failure)
      : Result.succeed({ resolved: resolved.success, source: "change" });
  }

  const configured = configuredHarnessProfileDefaults(change).subagents;
  const wanted = profile?.harness ?? program;
  if (configured !== undefined) {
    const resolved = resolveHarnessProfileByKey(discovery, configured, overlay);
    if (Result.isSuccess(resolved)) {
      // A chain that cannot take the profile's program is the default's business, not the
      // profile's: answer with the built-in for the program it asked for.
      return Result.succeed({ resolved: resolved.success, source: "default" });
    }
    if (wanted !== undefined && resolved.failure.kind === "harness-switch") {
      return Result.map(builtinFallback(discovery, wanted, overlay, resolved.failure), (fallback) => ({
        resolved: fallback,
        source: "default" as const,
        note: `default harness profile "${configured}" runs a different harness; "${builtinKeyFor(
          wanted,
        )}" answers instead`,
      }));
    }
    return Result.fail(resolved.failure);
  }

  // Nothing configured: the built-in pi profile, unless the profile names another program.
  if (wanted !== undefined && wanted !== "pi") {
    return Result.map(
      builtinFallback(discovery, wanted, overlay, {
        kind: "unknown-harness-profile",
        id: builtinKeyFor(wanted),
        chain: [builtinKeyFor(wanted)],
      }),
      (fallback) => ({
        resolved: fallback,
        source: "default" as const,
        note: `no subagent default is configured; "${builtinKeyFor(wanted)}" answers instead`,
      }),
    );
  }
  const pi = resolveHarnessProfileByKey(discovery, DEFAULT_HARNESS_PROFILE_KEY, overlay);
  return Result.map(pi, (resolved) => ({ resolved, source: "default" as const }));
};

export const harnessProfileErrorText = (error: HarnessProfileResolutionError): string =>
  describeHarnessProfileError(error);
