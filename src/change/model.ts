import {
  CHANGE_STATES,
  IDEATION,
  isFinished,
  type Change,
  type ChangeState,
} from "../domain/change.ts";
import { BadRequestError, ConflictError } from "../capabilities/effect/errors.ts";

/**
 * The two fields you may edit by hand: what a change is called, and where it stands.
 *
 * Here rather than in the route, so what is allowed can be tested without a server — and so the
 * one rule that matters is stated once: a change ends by being completed or cancelled, which
 * merge, remove worktrees and archive. Setting the word by hand would do none of that and claim
 * it had happened. `Ideation` is the same shape at the other end: it is set by creating an idea,
 * and leaving it is starting the work, which provisions the checkouts and moves the ticket.
 *
 * Purely synchronous, so no Effect wrapper: the validation throws the typed taxonomy
 * (BadRequestError / ConflictError). The server route converts those throws into failures at
 * the boundary (Effect.try).
 */
export function applyPatch(change: Change, patch: { state?: string; title?: string }): Change {
  if (patch.state && !CHANGE_STATES.includes(patch.state as ChangeState)) {
    throw new BadRequestError({ message: `unknown state: ${patch.state}` });
  }
  if (patch.state && isFinished({ ...change, state: patch.state as ChangeState })) {
    throw new ConflictError({
      message: `${patch.state} is what completing or cancelling a change sets`,
    });
  }
  if (patch.state === IDEATION) {
    throw new ConflictError({
      message: "Ideation is what creating an idea sets: use start work to leave it",
    });
  }
  const title = patch.title?.trim();
  return {
    ...change,
    state: (patch.state as ChangeState) ?? change.state,
    // An empty title hands the name back to the ticket; anything else is yours to keep.
    ...(patch.title === undefined
      ? {}
      : title
        ? { title, titleEdited: true }
        : { title: undefined, titleEdited: undefined }),
  };
}
