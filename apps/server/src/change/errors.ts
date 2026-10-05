import { Schema } from "effect";

/**
 * The change domain's own refusals: what creating a change and editing one by hand can say no
 * to, as typed values rather than HTTP statuses. The sentences are the ones the page shows; the
 * transport boundary (`apps/server/src/change/routes.ts`) decides whether a refusal is a 400 or a 409.
 */

/** A creation draft the core refuses: an invalid id, a state that is not a creation state, no
 * repository where one is needed, or two repositories sharing one name. */
export class InvalidChangeDraft extends Schema.TaggedError<InvalidChangeDraft>()(
  "InvalidChangeDraft",
  {
    message: Schema.String,
  },
) {}

/** A change with this id already exists. */
export class ChangeAlreadyExists extends Schema.TaggedError<ChangeAlreadyExists>()(
  "ChangeAlreadyExists",
  {
    changeId: Schema.String,
    message: Schema.String,
  },
) {}

/** A hand edit the core refuses. `conflict` marks the refusals that conflict with where the
 * change stands — a terminal state, or a return to Ideation — rather than an unknown value. */
export class InvalidChangeEdit extends Schema.TaggedError<InvalidChangeEdit>()(
  "InvalidChangeEdit",
  {
    message: Schema.String,
    conflict: Schema.Boolean,
  },
) {}
