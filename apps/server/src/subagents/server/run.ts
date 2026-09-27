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
import type { DiscoveredProfile } from "@corvi/agents/discovery";
import type { Change } from "../../domain/change.ts";
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

/** Every profile this change can run, resolved by the pure precedence rules. */
export const listProfilesFor = (change: Change): Effect.Effect<readonly DiscoveredProfile[]> =>
  Effect.map(Effect.flatMap(profileRootsFor(change), discoverProfiles), (discovery) => discovery.profiles);

/** The one profile a create named, or undefined. */
export const resolveProfileFor = (
  change: Change,
  key: string,
): Effect.Effect<DiscoveredProfile | undefined> =>
  Effect.map(listProfilesFor(change), (profiles) => profiles.find((profile) => profile.key === key));
