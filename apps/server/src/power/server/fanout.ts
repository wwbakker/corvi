/** The remote fan-out: send the local arm/disarm to each selected remote workspace's server and
 * report every target on its own.
 *
 * Each remote runs its own Corvi server, so arming a remote is POSTing the same command to its
 * `/api/power/arm` (or `/disarm`) with that workspace's device token. It never throws: a missing
 * or invalid workspace, a network failure, an older server without the route, and a refusal all
 * become a `PowerTargetResultDto` the caller shows. The fetch is an option so the mapping is
 * testable without a real Corvi.
 */
import { Option, Schema } from "effect";

import { PowerArmResponseSchema, type PowerTargetResultDto } from "@corvi/contracts/power";
import { resolveRemote } from "../../gateway/server/index.ts";

/** Which command to fan out. */
export type PowerVerb = "arm" | "disarm";

export type FanoutDeps = {
  /** The fetch used for the remote requests; the global one by default. */
  readonly fetch?: typeof fetch;
  /** Bound on one remote request, so a hung machine cannot hang the page. */
  readonly timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Statuses `fetch` would follow; the fan-out refuses them instead, so a remote cannot point a
 * request carrying the token at another origin. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** One target's result, never a throw. */
const one = async (
  source: string,
  verb: PowerVerb,
  doFetch: typeof fetch,
  timeoutMs: number,
): Promise<PowerTargetResultDto> => {
  const resolved = resolveRemote(source);
  if (resolved.kind === "missing") {
    return { source, status: "unsupported", detail: "no such remote workspace" };
  }
  if (resolved.kind === "invalid") {
    return { source, status: "refused", detail: "the remote workspace's url is not http or https" };
  }

  const { baseUrl, token } = resolved.target;
  let response: Response;
  try {
    response = await doFetch(`${baseUrl}/api/power/${verb}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ targets: [""] }),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { source, status: "unreachable", detail: messageOf(error) };
  }

  if (REDIRECT_STATUSES.has(response.status)) {
    void response.body?.cancel().catch(() => undefined);
    return { source, status: "refused", detail: "the remote redirected the request" };
  }
  if (response.status === 404) {
    void response.body?.cancel().catch(() => undefined);
    return { source, status: "unsupported", detail: "the remote server has no power route" };
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    return { source, status: "refused", detail: `the remote answered ${response.status}` };
  }

  // Reading the body is still transport: a remote that sends 200 headers then stalls past the
  // timeout, or drops the connection mid-body, is `unreachable`, not a malformed answer. Only a
  // body that arrives whole and does not parse is `refused`.
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    return { source, status: "unreachable", detail: messageOf(error) };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { source, status: "refused", detail: "the remote's answer was not a power response" };
  }
  const decoded = Schema.decodeUnknownOption(PowerArmResponseSchema)(body);
  if (Option.isNone(decoded)) {
    return { source, status: "refused", detail: "the remote's answer was not a power response" };
  }
  const result = decoded.value.results.find((entry) => entry.source === "");
  if (result === undefined) {
    return { source, status: "refused", detail: "the remote's answer did not name this target" };
  }
  // The remote answers for its own local machine; the origin reports it under the source id the
  // user selected.
  return { ...result, source };
};

/** Fan `verb` out to `sources`, one result each, in the order given. Never throws. */
export const fanOut = async (
  verb: PowerVerb,
  sources: readonly string[],
  deps: FanoutDeps = {},
): Promise<readonly PowerTargetResultDto[]> => {
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return Promise.all(
    sources.map((source) =>
      one(source, verb, doFetch, timeoutMs).catch(
        (error): PowerTargetResultDto => ({
          source,
          status: "unreachable",
          detail: messageOf(error),
        }),
      ),
    ),
  );
};
