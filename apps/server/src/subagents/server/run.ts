/** Resolving the profiles a change can run: the roots its files live in, and the one a create
 * names by key.
 *
 * The same scope wiring as actions (`apps/server/src/actions/server/run.ts`): the global and
 * workspace directories beside the config file (so `CORVI_CONFIG` moves both), the repository
 * scope inside each checkout. Discovery is per request — a small directory read — so an edit or a
 * new file needs no restart. */
import { Effect } from "effect";

import { discoverSubagentProfiles, type SubagentProfileRoots } from "@corvi/agents/node";
import type {
  DiscoveredSubagentProfile,
  SubagentProfileDiscovery,
} from "@corvi/agents/subagent-profile-discovery";
import type { SubagentProfilesResponseDto } from "@corvi/contracts/subagents";
import type { Change } from "@corvi/changes/record";
import { fileRootsFor } from "../../capabilities/fileRoots.ts";

export const profileRootsFor = (change: Change): Effect.Effect<SubagentProfileRoots> =>
  fileRootsFor(change, "subagents");

/** The full discovery — runnable profiles and the skipped files with their reasons. */
export const discoveryFor = (change: Change): Effect.Effect<SubagentProfileDiscovery> =>
  Effect.flatMap(profileRootsFor(change), discoverSubagentProfiles);

/** A profile that names its phases is offered only in them; one that names none in every phase. */
const offeredIn = (phases: readonly string[] | undefined, state: string): boolean =>
  phases === undefined || phases.some((phase) => phase === state);

/** The state the change is in, as the phase filter reads it. */
const stateOf = (change: Change): string => change.state ?? "Implementation";

/** Every profile this change may run now, resolved by the pure precedence rules. */
export const listProfilesFor = (change: Change): Effect.Effect<readonly DiscoveredSubagentProfile[]> =>
  Effect.map(discoveryFor(change), (discovery) => {
    const state = stateOf(change);
    return discovery.profiles.filter((found) => offeredIn(found.profile.phases, state));
  });

/** The same answer on the wire, for the CLI: what `subagent create` accepts, keyed as it keys
 * them, plus the files that did not make it and why. */
export const profilesFor = (change: Change): Effect.Effect<SubagentProfilesResponseDto> =>
  Effect.map(discoveryFor(change), (discovery) => ({
    profiles: discovery.profiles
      .filter((found) => offeredIn(found.profile.phases, stateOf(change)))
      .map((found) => ({
        key: found.key,
        id: found.id,
        source: found.source,
        ...(found.sourceLabel === undefined ? {} : { sourceLabel: found.sourceLabel }),
        label: found.profile.label,
        ...(found.profile.harness === undefined ? {} : { harness: found.profile.harness }),
        ...(found.profile.model === undefined ? {} : { model: found.profile.model }),
        ...(found.profile.effort === undefined ? {} : { effort: found.profile.effort }),
        body: found.profile.body,
      })),
    skipped: discovery.skipped.map((file) => ({ key: file.key, reasons: [...file.reasons] })),
  }));

/** The one profile a create named, or undefined. Searched across every phase, so a profile that
 * is not offered right now is named as such rather than reported missing. */
export const resolveProfileFor = (
  change: Change,
  key: string,
): Effect.Effect<DiscoveredSubagentProfile | undefined> =>
  Effect.map(discoveryFor(change), (discovery) => discovery.profiles.find((profile) => profile.key === key));

/** Whether a profile is offered in the change's current phase. */
export const profileOfferedIn = (change: Change, profile: DiscoveredSubagentProfile): boolean =>
  offeredIn(profile.profile.phases, stateOf(change));
