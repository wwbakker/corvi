/** A small in-memory limiter for pairing-code redemption.
 *
 * The redeem endpoint is the one route reachable without a token (a client has no device token
 * before it redeems a code), so on the external listener it is the only thing an unauthenticated
 * caller can reach. The code is 64 random bits, so guessing it is infeasible; this limiter is
 * defense in depth: a global attempts-per-window cap blunts a flood, and a per-code failure cap
 * stops repeated guesses once a real code is known.
 *
 * The state is in memory on purpose: a rate limit that survives a restart would have to be
 * persisted and reconciled, and losing it costs a moment of protection, never a correctness
 * property. The owner is the process runtime (`capabilities/runtime.ts`), so a test installs its
 * own limiter instead of reaching into module state.
 *
 * The global cap is also a denial-of-service lever: it is shared by every caller, so a flood can
 * exhaust it and lock out legitimate pairing for the rest of the window. That is the acceptable
 * trade — the window is short and the endpoint is only reachable on the external listener — but
 * it is why the cap must be checked before an unauthenticated body is parsed. Per-IP limiting is
 * not possible here: behind `tailscale serve` every request arrives from `127.0.0.1`, so the
 * peer address names the proxy, not the caller.
 */

/** Whether an attempt may proceed, and when it may try again if not. */
export type RedeemDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

export type RedeemLimiter = {
  /** Count one attempt and check the global window. Call before reading the request body, so a
   * malformed or oversized unauthenticated body cannot bypass the cap. */
  allowAttempt: () => RedeemDecision;
  /** Check the per-code failure cap once the code is known. Does not count an attempt (the
   * route already did), so one request is one attempt however many times the cap is consulted. */
  allowCode: (code: string) => RedeemDecision;
  /** Record that an attempt failed (an unknown or expired code). */
  failed: (code: string) => void;
  /** Record that a code redeemed, clearing its failure count. */
  succeeded: (code: string) => void;
};

export type RedeemLimiterOptions = {
  /** Attempts allowed per window across all codes. */
  readonly globalLimit?: number;
  readonly globalWindowMs?: number;
  /** Failed attempts allowed for one code before it is refused outright. */
  readonly codeFailureLimit?: number;
  /** The clock, injectable so a test can drive the window without sleeping. */
  readonly now?: () => number;
};

const DEFAULT_GLOBAL_LIMIT = 60;
const DEFAULT_GLOBAL_WINDOW_MS = 10 * 60_000;
const DEFAULT_CODE_FAILURE_LIMIT = 5;

export const createRedeemLimiter = (options: RedeemLimiterOptions = {}): RedeemLimiter => {
  const globalLimit = options.globalLimit ?? DEFAULT_GLOBAL_LIMIT;
  const globalWindowMs = options.globalWindowMs ?? DEFAULT_GLOBAL_WINDOW_MS;
  const codeFailureLimit = options.codeFailureLimit ?? DEFAULT_CODE_FAILURE_LIMIT;
  const now = options.now ?? Date.now;

  let windowStartedAt = 0;
  let attempts = 0;
  const failures = new Map<string, number>();

  /** Start a fresh window when the previous one has elapsed. */
  const rollWindow = (at: number): void => {
    if (at - windowStartedAt < globalWindowMs) return;
    windowStartedAt = at;
    attempts = 0;
    failures.clear();
  };

  const denied = (at: number): RedeemDecision => ({
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((globalWindowMs - (at - windowStartedAt)) / 1000)),
  });

  return {
    allowAttempt: () => {
      const at = now();
      rollWindow(at);
      if (attempts >= globalLimit) return denied(at);
      attempts += 1;
      return { allowed: true };
    },
    allowCode: (code) => {
      const at = now();
      rollWindow(at);
      if ((failures.get(code) ?? 0) >= codeFailureLimit) return denied(at);
      return { allowed: true };
    },
    failed: (code) => {
      rollWindow(now());
      failures.set(code, (failures.get(code) ?? 0) + 1);
    },
    succeeded: (code) => {
      failures.delete(code);
    },
  };
};
