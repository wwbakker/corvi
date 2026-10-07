/** The availability owner's construction types: the bounded checks it runs and the transport it
 * uses. The entrypoint builds the named defaults (and may override them from the environment);
 * a test injects a scripted transport and short bounds. Nothing here reads configuration. */

/** How long a health check may take. None of these is a total-duration timeout on a healthy
 * stream: `stallMs` is reset by every byte, so a long-lived stream is only ever cut for going
 * quiet. */
export type RemoteAvailabilityDeadlines = {
  /** Time from starting the request to its response headers. Not a TCP connect timeout: a remote
   * behind a slow proxy may legitimately take a moment to answer, and this bound is generous. */
  readonly connectMs: number;
  /** Time from the response headers to the stream's first byte. A server that answers 200 and
   * then says nothing is not healthy, however long the connection stays open. */
  readonly firstSignalMs: number;
  /** Maximum silence between bytes on an open stream. Heartbeat comments count. */
  readonly stallMs: number;
};

export const DEFAULT_AVAILABILITY_DEADLINES: RemoteAvailabilityDeadlines = {
  connectMs: 10_000,
  firstSignalMs: 10_000,
  stallMs: 20_000,
};

/** The fetch the owner uses. Injectable so a test can script responses and their timing. */
export type RemoteFetch = (
  url: URL,
  init: {
    readonly headers: Record<string, string>;
    readonly signal: AbortSignal;
    readonly redirect: "manual";
  },
) => Promise<Response>;

/** What a transport observation from the gateway may say about a source. It is an observation,
 * not a verdict: the owner may use it to ask for a health recheck, and never classifies a
 * workspace from a single failed operation. */
export type RemoteObservation = "unreachable" | "authentication";
