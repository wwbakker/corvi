/** The generated harness state of a change: everything under
 * `<stateDir>/harnesses/<changeId>`. Removed when the change is archived or deleted — a reopened
 * change regenerates what it needs. Best-effort: a failed cleanup is logged, not turned into a
 * failed archive. */
import { rm } from "node:fs/promises";
import { Effect } from "effect";

import { harnessStateDir } from "@corvi/agents/harness-generation";
import { stateDir } from "@corvi/configuration/node";

export const removeHarnessState = (changeId: string): Effect.Effect<void> => {
  const path = harnessStateDir(stateDir(), changeId);
  return Effect.tryPromise(() => rm(path, { recursive: true, force: true })).pipe(
    Effect.catch((error) =>
      Effect.sync(() => console.error(`could not remove generated harnesses at ${path}:`, error)),
    ),
  );
};
