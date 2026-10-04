/**
 * The app-update journal: `stateDir()/app-update.json`, on the shared operation-progress shape.
 *
 * The update is about the application, not about a change, so its journal lives in the app's own
 * state directory rather than beside a change record — but it is the same shape a completion
 * writes (`@corvi/contracts/api`'s `OperationProgressDto`), so one step list reads both. A
 * half-written or malformed record reads as no record: the update that was interrupted rewrites
 * it from where it got to. Writes go through a temp file and a rename, so a crash leaves the old
 * journal rather than half of the new one.
 */
import { Effect, Schema } from "effect";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { OperationProgressSchema, type OperationProgressDto } from "@corvi/contracts/api";
import { stateDir } from "@corvi/configuration/node";

const FILE = "app-update.json";

export class UpdateJournalError extends Schema.TaggedError<UpdateJournalError>()(
  "UpdateJournalError",
  {
    message: Schema.String,
    // The cause is an opaque in-process throwable that is never serialized; `Schema.Unknown`
    // preserves it exactly (on decode `Schema.Defect()` is lossy).
    cause: Schema.optional(Schema.Unknown),
  },
) {}

const isNotFound = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && (cause as { code?: string }).code === "ENOENT";

const path = (): string => join(stateDir(), FILE);

/** The journal as it stands, or null when there is none to read. */
export const readJournal = (): Effect.Effect<OperationProgressDto | null, UpdateJournalError> =>
  Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: () => readFile(path(), "utf8"),
      catch: (cause: unknown) => cause,
    }).pipe(
      Effect.catch((cause: unknown) =>
        isNotFound(cause)
          ? Effect.succeed(null)
          : Effect.fail(
              new UpdateJournalError({ message: `could not read ${path()}`, cause }),
            ),
      ),
    );
    if (text === null) return null;
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OperationProgressSchema))(text).pipe(
      Effect.orElseSucceed(() => null),
    );
  });

export const writeJournal = (
  progress: OperationProgressDto,
): Effect.Effect<void, UpdateJournalError> =>
  Effect.tryPromise({
    try: async () => {
      const target = path();
      const temp = `${target}.tmp`;
      await mkdir(stateDir(), { recursive: true });
      await writeFile(temp, JSON.stringify(progress, null, 2) + "\n");
      await rename(temp, target);
    },
    catch: (cause: unknown) =>
      new UpdateJournalError({ message: `could not write ${path()}`, cause }),
  });
