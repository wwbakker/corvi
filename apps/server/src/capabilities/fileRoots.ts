/** Where one change's scoped Markdown files live: the global and workspace directories beside the
 * config file (so `CORVI_CONFIG` moves both), and the repository scope inside each checkout.
 * Actions, subagent profiles and harnesses use the same layout with a different directory name. */
import { basename, dirname, join } from "node:path";
import { Effect } from "effect";

import type { Change } from "@corvi/changes/record";
import { checkoutFor } from "../vendors/git.ts";
import { configPath, workspaceOf } from "../workspace/server/index.ts";

export type FileRoots = {
  readonly global: string;
  readonly workspaces: readonly { readonly id: string; readonly label: string; readonly dir: string }[];
  readonly repositories: readonly { readonly name: string; readonly dir: string }[];
  /** The scope roots a relative `include`/`exclude` path resolves against, as a harness profile file
   * means it: the config directory, a workspace's config directory, a checkout root. */
  readonly bases: {
    readonly global: string;
    readonly workspaces: readonly { readonly id: string; readonly dir: string }[];
    readonly repositories: readonly { readonly name: string; readonly dir: string }[];
  };
};

export const fileRootsFor = (change: Change, dirName: string): Effect.Effect<FileRoots> =>
  Effect.gen(function* () {
    const base = dirname(configPath());
    const workspace = workspaceOf(change);
    const workspaceDir = join(base, "workspaces", workspace.id);
    const repositories: { name: string; dir: string }[] = [];
    const bases: { name: string; dir: string }[] = [];
    for (const spec of change.checkouts ?? []) {
      const checkout = yield* checkoutFor(change, spec.path);
      if (!checkout) continue;
      const name = basename(spec.path);
      repositories.push({ name, dir: join(checkout, ".corvi", dirName) });
      bases.push({ name, dir: checkout });
    }
    return {
      global: join(base, dirName),
      workspaces: [{ id: workspace.id, label: workspace.name, dir: join(workspaceDir, dirName) }],
      repositories,
      bases: {
        global: base,
        workspaces: [{ id: workspace.id, dir: workspaceDir }],
        repositories: bases,
      },
    };
  });
