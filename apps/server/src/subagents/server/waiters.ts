/**
 * The long poll's parking lot: one `Deferred` per waiting request, keyed by change and subagent,
 * resolved directly by the route that appends a message or loses a window.
 *
 * Not the browser event bus. `capabilities/bus.ts` is SSE to `EventSource`s only, its events are
 * coarse pokes, and `announce` forgets them — none of which can wake a `wait` reliably. This is
 * the reliable wake: the append route calls `notify` and the parked effect resolves.
 *
 * Four event kinds, because `wait` and `next` await different halves of the conversation:
 * `reply` is a settled subagent turn (what `wait` returns), `inbound` is a message for the
 * subagent (what `next` returns), and `lost`/`interrupted` are the ways a turn can end without a
 * reply. Every waiter is removed when its fiber is interrupted (a timed-out long poll, a losing
 * `race`), so the registry does not grow.
 */
import { Deferred, Effect } from "effect";

import type { SubagentMessage } from "@corvi/agents/instance";

export type SubagentEvent =
  | { readonly kind: "inbound"; readonly id: string; readonly message: SubagentMessage }
  | { readonly kind: "reply"; readonly id: string; readonly message: SubagentMessage }
  | { readonly kind: "lost"; readonly id: string }
  | { readonly kind: "interrupted"; readonly id: string };

type Waiter = Deferred.Deferred<SubagentEvent>;

const waiters = new Map<string, Set<Waiter>>();

const keyOf = (changeId: string, id: string): string => `${changeId}\u0000${id}`;

/** Park until an event for one subagent arrives. The registration is removed whatever ends the
 * wait, so an interrupted long poll leaves nothing behind. */
export const awaitEvent = (changeId: string, id: string): Effect.Effect<SubagentEvent> =>
  Effect.gen(function* () {
    const deferred = yield* Deferred.make<SubagentEvent>();
    const key = keyOf(changeId, id);
    const set = waiters.get(key) ?? new Set<Waiter>();
    set.add(deferred);
    waiters.set(key, set);
    return yield* Deferred.await(deferred).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          set.delete(deferred);
          if (set.size === 0) waiters.delete(key);
        }),
      ),
    );
  });

/** Wake everyone waiting on one subagent. Resolving an already-resolved deferred is a no-op, so a
 * late duplicate is harmless. */
export const notify = (changeId: string, id: string, event: SubagentEvent): Effect.Effect<void> =>
  Effect.gen(function* () {
    const set = waiters.get(keyOf(changeId, id));
    if (set === undefined) return;
    for (const deferred of [...set]) yield* Deferred.succeed(deferred, event);
  });

/** For tests and diagnostics: how many requests are parked, across every key. */
export const waiterCount = (): number => {
  let count = 0;
  for (const set of waiters.values()) count += set.size;
  return count;
};
