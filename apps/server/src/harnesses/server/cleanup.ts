/** The generated harness state of a change: everything under
 * `<stateDir>/harnesses/<changeId>`. Removed when the change is archived or deleted — a reopened
 * change regenerates what it needs. Best-effort: a failed cleanup is logged, not turned into a
 * failed archive. */
import { rm } from "node:fs/promises";
import { Effect } from "effect";

import { environmentStateDir } from "@corvi/agents/environment-generation";
import { stateDir } from "@corvi/configuration/node";

export const removeEnvironmentState = (changeId: string): Effect.Effect<void> => {
  const path = environmentStateDir(stateDir(), changeId);
  return Effect.tryPromise(() => rm(path, { recursive: true, force: true })).pipe(
    Effect.catch((error) =>
      Effect.sync(() => console.error(`could not remove generated harnesses at ${path}:`, error)),
    ),
  );
};
