import {
  CHANGE_STATES,
  IDEATION,
  isFinished,
  type Change,
  type ChangeState,
} from "@corvi/changes/record";
import { allowedTransition } from "@corvi/changes/rules";
import { InvalidChangeEdit } from "./errors.ts";

/**
 * The two fields you may edit by hand: what a change is called, and where it stands.
 *
 * Here rather than in the route, so what is allowed can be tested without a server — and so the
 * one rule that matters is stated once: a change ends by being completed or cancelled, which
 * merge, remove worktrees and archive. Setting the word by hand would do none of that and claim
 * it had happened. `Ideation` is the same shape at the other end: it is set by creating an idea,
 * and leaving it is starting the work, which provisions the checkouts and moves the ticket.
 *
 * Purely synchronous, so no Effect wrapper: the validation throws the change domain's own
 * refusals (`InvalidChangeEdit`); the route boundary decides the status and lifts the throw into
 * the Effect channel.
 */
export function applyPatch(change: Change, patch: { state?: string; title?: string }): Change {
  if (patch.state && !CHANGE_STATES.includes(patch.state as ChangeState)) {
    throw new InvalidChangeEdit({ message: `unknown state: ${patch.state}`, conflict: false });
  }
  if (patch.state && isFinished({ ...change, state: patch.state as ChangeState })) {
    throw new InvalidChangeEdit({
      message: `${patch.state} is what completing or cancelling a change sets`,
      conflict: true,
    });
  }
  if (patch.state === IDEATION) {
    throw new InvalidChangeEdit({
      message: "Ideation is what creating an idea sets: use start work to leave it",
      conflict: true,
    });
  }
  // The matrix the lifecycle workflow uses, so an edit by hand cannot reach where starting,
  // completing or cancelling would not. `Ideation` is the case that matters: its only way out is
  // starting the work, which the UI's disabled select already encodes and this makes authoritative.
  if (patch.state && !allowedTransition(change.state ?? "Implementation", patch.state as ChangeState)) {
    throw new InvalidChangeEdit({
      message: `a change cannot move from ${change.state ?? "Implementation"} to ${patch.state}`,
      conflict: true,
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
