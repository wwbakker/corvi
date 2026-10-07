/** The gateway's bounded waits, built by the entrypoint (and injectable in tests).
 *
 * Neither is a total-duration timeout. `readHeadersMs` bounds only the time to the remote's
 * response headers for a read (GET/HEAD): once headers arrive the body or SSE stream is passed
 * through unbounded, so a legitimately slow read is reported rather than silently cut, and a
 * slow command (a mutation, which has no bound at all) is never terminated. `upgradeHandshakeMs`
 * bounds only the WebSocket handshake; the bridged stream after it has no bound. */
export type GatewayTimeouts = {
  readonly readHeadersMs: number;
  readonly upgradeHandshakeMs: number;
};

export const DEFAULT_GATEWAY_TIMEOUTS: GatewayTimeouts = {
  readHeadersMs: 15_000,
  upgradeHandshakeMs: 15_000,
};
