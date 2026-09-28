/**
 * The long poll's parking lot: one `Deferred` per waiting request, keyed by change and subagent,
 * resolved directly by the route that appends a message or loses a window.
 *
 * Not the browser event bus. `capabilities/bus.ts` is SSE to `EventSource`s only, its events are
 * coarse pokes, and `announce` forgets them — none of which can wake a `wait` reliably. This is
 * the reliable wake: the append route calls `notify` and the parked effect resolves.
 *
 * `subscribe` registers the waiter and hands back the `/await`, so a caller can **subscribe, then
 * read state, then await**. That order is what closes the lost-wake race: an event that fires
 * between the earlier read and the registration is missed, but one that fires after the
 * registration resolves the deferred, and one that fired before is seen by the read. Every
 * subscription is closed by its caller (an interrupted long poll, a losing `race`), so the
 * registry does not grow.
 *
 * Four event kinds, because `wait` and `next` await different halves of the conversation: `reply`
 * is a settled subagent turn (what `wait` returns), `inbound` is a message for the subagent (what
 * `next` returns), and `lost`/`interrupted` are the ways a turn can end without a reply.
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

export type Subscription = {
  /** The next event for this subagent. Resolves at most once. */
  readonly await: Effect.Effect<SubagentEvent>;
  /** Stop waiting and forget the registration. Idempotent. */
  readonly close: Effect.Effect<void>;
};

/** Register a waiter. Call `close` when done — it removes the registration whatever ended the
 * wait, including interruption. */
export const subscribe = (changeId: string, id: string): Effect.Effect<Subscription> =>
  Effect.gen(function* () {
    const deferred = yield* Deferred.make<SubagentEvent>();
    const key = keyOf(changeId, id);
    const set = waiters.get(key) ?? new Set<Waiter>();
    set.add(deferred);
    waiters.set(key, set);
    const close = Effect.sync(() => {
      if (!set.delete(deferred)) return;
      if (set.size === 0) waiters.delete(key);
    });
    return { await: Deferred.await(deferred), close };
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
