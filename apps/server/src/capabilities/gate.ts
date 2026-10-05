/** The one gate for changes to this machine's external surface: the listener's reconcile (a
 * settings save) and the Tailscale publish/unpublish routes. They read and write the same tracked
 * port and the same `tailscale serve` configuration, so a click during a save must not interleave
 * a command with the reconcile's. One shared semaphore rather than a private one per caller.
 *
 * A caller that is already inside the gate must not take it again — the reconcile calls the
 * publish/unpublish operations directly, not through their routes, which is what keeps the
 * semaphore non-reentrant-safe.
 *
 * A settings save reaches this gate through the remote-access reconcile, and that reconcile runs
 * `tailscale` commands on the way. A hung `tailscale` CLI therefore delays a save by the shell's
 * own timeout: waiting for the gate is the intended trade, and the timeout is what bounds it.
 */
import { Effect, Semaphore } from "effect";

const gate = Semaphore.makeUnsafe(1);

/** Run `effect` with the gate held: callers run one at a time, in the order they arrive. */
export const inExternalGate = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  gate.withPermits(1)(effect);
