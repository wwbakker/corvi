/** The pairing helper: redeem a code minted on another Corvi server, server-to-server, and hand
 * the editor the device token it will store for a remote workspace.
 *
 * The page never talks to the remote: it cannot, the token is not its to hold, and a browser
 * request to the remote would carry the local origin and fail the remote's own guard. This runs
 * on the local server, which is the single origin for its page and the authenticated gateway to
 * remotes, and it uses the same `@corvi/client` the gateway's callers use rather than a
 * hand-rolled fetch, so a failure classifies the same way.
 */
import { Effect } from "effect";
import { makeCorviClient, type FetchLike } from "@corvi/client";
import type { RemoteWorkspaceRefDto } from "@corvi/contracts/api";
import type { DeviceViewDto } from "@corvi/contracts/devices";
import { BadRequestError } from "@corvi/contracts/errors";

/** What a successful pairing yields: the device created on the remote, the raw token (which the
 * editor writes into its draft, and which is never returned again), and the remote's workspaces,
 * so the editor can offer a picker instead of a free-text id. */
export type PairedRemote = {
  readonly device: DeviceViewDto;
  readonly token: string;
  readonly workspaces: RemoteWorkspaceRefDto[];
};

/** How long the whole outbound pairing exchange may take before it is abandoned. A remote that
 * accepts the connection and then says nothing must not hold the editor's request open forever. */
export const PAIR_TIMEOUT_MS = 15_000;

/** Statuses `fetch` would follow; the helper refuses them, exactly as the gateway does. A
 * redirect could carry the freshly minted token to an origin the user did not name. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** A refusal the transport carries through as its message. The client's transport replaces any
 * throw out of `fetch` with "the server could not be reached", so a choice of words made here has
 * to come back as an ordinary non-ok answer, not an exception. */
const refused = (status: number, message: string): Response =>
  Response.json({ error: message }, { status });

/** The outbound fetch for pairing: never follow a redirect, bound the whole exchange, and present
 * the token once there is one (the redemption itself is tokenless; reading the remote's
 * workspaces is not). The caller's signal (the request being served) and the timeout are both
 * honoured; a client hang-up cancels the remote call with it. */
const outbound = (
  token: string | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): FetchLike => {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signals = [timeout, ...(init?.signal ? [init.signal] : []), ...(signal ? [signal] : [])];
    const combined = signals.length === 1 ? timeout : AbortSignal.any(signals);
    let response: Response;
    try {
      response = await fetch(input, { ...init, headers, redirect: "manual", signal: combined });
    } catch (error) {
      // The timeout is ours to explain; anything else (a refused connection, a client hang-up)
      // travels out as it is so the client can say what it saw.
      if (timeout.aborted) {
        return refused(504, "the remote did not answer in time");
      }
      throw error;
    }
    if (response.status === 0 || REDIRECT_STATUSES.has(response.status)) {
      return refused(502, "that server redirected; redirects are not followed when pairing");
    }
    return response;
  };
};

/** The user-supplied url, trimmed, with no trailing slash: the remote's `baseUrl` for the
 * client. Only http and https are fetchable, and only those are accepted. */
const asHttpUrl = (value: string): Effect.Effect<string, BadRequestError> => {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return Effect.fail(
      new BadRequestError({ message: "the remote address must be a full http or https URL" }),
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return Effect.fail(
      new BadRequestError({ message: "the remote address must be a full http or https URL" }),
    );
  }
  return Effect.succeed(trimmed.replace(/\/+$/, ""));
};

/** The one message a failure gets: the client's classified message when there is one, so an
 * unreachable host, a redirect and a timeout each say what the client saw rather than "failed". */
const failure = (error: unknown): BadRequestError =>
  new BadRequestError({
    message: `could not pair with the remote: ${
      error instanceof Error ? error.message : String(error)
    }`,
  });

/** Pair with a workspace hosted by another server: redeem `code`, then read the remote's
 * workspaces with the token just obtained. A bad code, an unreachable host, a redirect, a hung
 * server, and a server that is not Corvi all come back as one typed `BadRequestError` the editor
 * can show. `signal` is the request's, so a client that hangs up cancels the outbound call;
 * `timeoutMs` is the seam tests use for the bound, never anything a request can set. */
export const pairRemoteWorkspace = (input: {
  readonly url: string;
  readonly code: string;
  readonly name?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Effect.Effect<PairedRemote, BadRequestError> =>
  Effect.gen(function* () {
    const baseUrl = yield* asHttpUrl(input.url);
    const timeoutMs = input.timeoutMs ?? PAIR_TIMEOUT_MS;
    const redeemed = yield* Effect.tryPromise({
      try: () =>
        makeCorviClient({ baseUrl, fetch: outbound(undefined, input.signal, timeoutMs) }).devices.redeem({
          code: input.code,
          ...(input.name?.trim() ? { name: input.name.trim() } : {}),
        }),
      catch: failure,
    });
    const listed = yield* Effect.tryPromise({
      try: () =>
        makeCorviClient({
          baseUrl,
          fetch: outbound(redeemed.token, input.signal, timeoutMs),
        }).workspaces.list(),
      catch: failure,
    });
    return {
      device: redeemed.device,
      token: redeemed.token,
      workspaces: listed.workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name })),
    };
  });
