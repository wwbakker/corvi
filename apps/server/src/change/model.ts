import { CHANGE_STATES, isFinished, type Change, type ChangeState } from "@corvi/changes/record";
import { allowedTransition } from "@corvi/changes/rules";
import { InvalidChangeEdit } from "./errors.ts";

/**
 * The two fields you may edit by hand: what a change is called, and where it stands.
 *
 * Here rather than in the route, so what is allowed can be tested without a server — and so the
 * one rule that matters is stated once: a change ends by being completed or cancelled, which
 * merge, remove worktrees and archive. Setting the word by hand would do none of that and claim
 * it had happened. Every manual phase — `Ideation` included — moves freely to any other.
 *
 * Purely synchronous, so no Effect wrapper: the validation throws the change domain's own
 * refusals (`InvalidChangeEdit`); the route boundary decides the status and lifts the throw into
 * the Effect channel.
 */
export function applyPatch(
  change: Change,
  patch: {
    state?: string;
    title?: string;
    userHarness?: string | null;
    subagentHarness?: string | null;
  },
): Change {
  // `undefined` is "leave the phase alone"; every other value must be a phase, the empty string
  // included — treating it as absent would write a blank phase from a raw caller.
  if (patch.state !== undefined && !CHANGE_STATES.includes(patch.state as ChangeState)) {
    throw new InvalidChangeEdit({ message: `unknown state: ${patch.state}`, conflict: false });
  }
  // Naming the phase a change is already in is a no-op, not a conflict: `change phase` is printed
  // as a next step, and a retry must succeed. The capability store keeps its own refusal of
  // `from === to` for transitions.
  const requested =
    patch.state !== undefined && patch.state !== (change.state ?? "Implementation")
      ? (patch.state as ChangeState)
      : undefined;
  if (requested !== undefined && isFinished({ ...change, state: requested })) {
    throw new InvalidChangeEdit({
      message: `${requested} is what completing or cancelling a change sets`,
      conflict: true,
    });
  }
  // The matrix the lifecycle workflow uses, so an edit by hand cannot reach where completing or
  // cancelling would not: a terminal phase is entered by its workflow, never by a word.
  if (requested !== undefined && !allowedTransition(change.state ?? "Implementation", requested)) {
    throw new InvalidChangeEdit({
      message: `a change cannot move from ${change.state ?? "Implementation"} to ${requested}`,
      conflict: true,
    });
  }
  const title = patch.title?.trim();
  // `undefined` leaves a harness choice alone; `null` (or an empty value) stores nothing, which is
  // the "Default" selector: later default changes still apply.
  const harness = (value: string | null | undefined, current: string | undefined): string | undefined =>
    value === undefined ? current : value?.trim() ? value.trim() : undefined;
  return {
    ...change,
    state: requested ?? change.state,
    // An empty title hands the name back to the ticket; anything else is yours to keep.
    ...(patch.title === undefined
      ? {}
      : title
        ? { title, titleEdited: true }
        : { title: undefined, titleEdited: undefined }),
    userHarness: harness(patch.userHarness, change.userHarness),
    subagentHarness: harness(patch.subagentHarness, change.subagentHarness),
  };
}
