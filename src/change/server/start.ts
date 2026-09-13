import { Effect } from "effect";
import { IDEATION, type Change } from "../../domain/change.ts";
import { ConflictError } from "../../capabilities/effect/errors.ts";
import { writeChange } from "./store.ts";

/**
 * Start an idea's work: leave `Ideation` for `In Progress`.
 *
 * The state move is all this does. What a start implies — creating each repository's checkout,
 * moving the ticket to In Progress — belongs to the `change:started` hooks, so the core never
 * learns what a ticket is, and a failure there is reported rather than undoing the start. That is
 * the same bargain creating a change makes: the record is written first and always survives.
 */
export const startChange = (change: Change): Effect.Effect<Change, ConflictError> =>
  Effect.gen(function* () {
    if (change.state !== IDEATION) {
      return yield* new ConflictError({
        message: `${change.id} has already started (${change.state ?? "In Progress"})`,
      });
    }
    const started: Change = { ...change, state: "In Progress" };
    yield* writeChange(started);
    return started;
  });
