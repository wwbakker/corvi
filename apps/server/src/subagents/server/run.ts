/** Resolving the profiles a change can run: the roots its files live in, and the one a create
 * names by key.
 *
 * The same scope wiring as actions (`apps/server/src/actions/server/run.ts`): the global and
 * workspace directories beside the config file (so `CORVI_CONFIG` moves both), the repository
 * scope inside each checkout. Discovery is per request — a small directory read — so an edit or a
 * new file needs no restart. */
import { basename, dirname, join } from "node:path";
import { Effect } from "effect";

import { discoverProfiles, type ProfileRoots } from "@corvi/agents/node";
import type { DiscoveredProfile, ProfileDiscovery } from "@corvi/agents/discovery";
import type { SubagentProfilesResponseDto } from "@corvi/contracts/subagents";
import type { Change } from "@corvi/changes/record";
import { checkoutFor } from "../../vendors/git.ts";
import { configPath, workspaceOf } from "../../workspace/server/index.ts";

export const profileRootsFor = (change: Change): Effect.Effect<ProfileRoots> =>
  Effect.gen(function* () {
    const base = dirname(configPath());
    const workspace = workspaceOf(change);
    const repositories: { name: string; dir: string }[] = [];
    for (const spec of change.checkouts ?? []) {
      const checkout = yield* checkoutFor(change, spec.path);
      if (checkout) {
        repositories.push({ name: basename(spec.path), dir: join(checkout, ".corvi", "subagents") });
      }
    }
    return {
      global: join(base, "subagents"),
      workspaces: [
        {
          id: workspace.id,
          label: workspace.name,
          dir: join(base, "workspaces", workspace.id, "subagents"),
        },
      ],
      repositories,
    };
  });

/** The full discovery — runnable profiles and the skipped files with their reasons. */
export const discoveryFor = (change: Change): Effect.Effect<ProfileDiscovery> =>
  Effect.flatMap(profileRootsFor(change), discoverProfiles);

/** Every profile this change can run, resolved by the pure precedence rules. */
export const listProfilesFor = (change: Change): Effect.Effect<readonly DiscoveredProfile[]> =>
  Effect.map(discoveryFor(change), (discovery) => discovery.profiles);

/** The same answer on the wire, for the CLI: what `subagent create` accepts, keyed as it keys
 * them, plus the files that did not make it and why. */
export const profilesFor = (change: Change): Effect.Effect<SubagentProfilesResponseDto> =>
  Effect.map(discoveryFor(change), (discovery) => ({
    profiles: discovery.profiles.map((found) => ({
      key: found.key,
      id: found.id,
      source: found.source,
      ...(found.sourceLabel === undefined ? {} : { sourceLabel: found.sourceLabel }),
      label: found.profile.label,
      harness: found.profile.harness,
      ...(found.profile.model === undefined ? {} : { model: found.profile.model }),
      ...(found.profile.effort === undefined ? {} : { effort: found.profile.effort }),
      body: found.profile.body,
    })),
    skipped: discovery.skipped.map((file) => ({ key: file.key, reasons: [...file.reasons] })),
  }));

/** The one profile a create named, or undefined. */
export const resolveProfileFor = (
  change: Change,
  key: string,
): Effect.Effect<DiscoveredProfile | undefined> =>
  Effect.map(listProfilesFor(change), (profiles) => profiles.find((profile) => profile.key === key));
