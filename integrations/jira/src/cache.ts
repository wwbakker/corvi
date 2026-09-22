/** The Cache capability as this integration uses it: the host's answer cache when one is in
 * context, and the work itself when there is not. */
import { Cache } from "@corvi/contracts/capabilities";
import { Effect, Option } from "effect";

export const swr = <A, E, R>(
  key: string,
  ttlMs: number,
  work: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.flatMap(Effect.serviceOption(Cache), (cache) =>
    Option.isNone(cache) ? work : cache.value.swr(key, ttlMs, work),
  );

export const invalidate = (prefix: string): Effect.Effect<void> =>
  Effect.flatMap(Effect.serviceOption(Cache), (cache) =>
    Option.isNone(cache) ? Effect.void : cache.value.invalidate(prefix),
  );
