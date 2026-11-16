/** Where one change's scoped Markdown files live: the global and workspace directories beside the
 * config file (so `CORVI_CONFIG` moves both), and the repository scope inside each checkout.
 * Actions and subagent profiles use the same layout with a different directory name. */
import { basename, dirname, join } from "node:path";
import { Effect } from "effect";

import type { Change } from "@corvi/changes/record";
import { checkoutFor } from "../vendors/git.ts";
import { configPath, workspaceOf } from "../workspace/server/index.ts";

export type FileRoots = {
  readonly global: string;
  readonly workspaces: readonly { readonly id: string; readonly label: string; readonly dir: string }[];
  readonly repositories: readonly { readonly name: string; readonly dir: string }[];
};

export const fileRootsFor = (change: Change, dirName: string): Effect.Effect<FileRoots> =>
  Effect.gen(function* () {
    const base = dirname(configPath());
    const workspace = workspaceOf(change);
    const repositories: { name: string; dir: string }[] = [];
    for (const spec of change.checkouts ?? []) {
      const checkout = yield* checkoutFor(change, spec.path);
      if (checkout) repositories.push({ name: basename(spec.path), dir: join(checkout, ".corvi", dirName) });
    }
    return {
      global: join(base, dirName),
      workspaces: [
        {
          id: workspace.id,
          label: workspace.name,
          dir: join(base, "workspaces", workspace.id, dirName),
        },
      ],
      repositories,
    };
  });
