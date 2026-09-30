/**
 * The agent status of a host session, as its reporter last set it.
 *
 * Keyed by `(sessionId, incarnation)`, so a reused session id never inherits its predecessor's
 * status. It lives in server memory rather than the registry file: status is a live fact about a
 * running process, not product state worth persisting across a restart — a restarted server
 * clears it, and the reporter's next transition sets it again. The presenter reads this store
 * first and falls back to the status the host itself parsed from OSC (`session.status`), so the
 * CLI/HTTP channel and the OSC fallback share one shape.
 *
 * The trust model is the reporter's: any process inside the pty can name its own session id. A
 * later slice's per-window token is the extension point, not this one.
 */
import type { SessionStatus } from "../host/protocol.ts";
import { hostClient, hostRunning } from "./host.ts";

export type AgentStatus = SessionStatus;

/** A status report is a live fact about a running process, keyed by `(sessionId, incarnation)`.
 * The value is the reported status, `null` for an explicit clear (a tombstone, so the presenter
 * does not fall back to the host's OSC-parsed status), or absent when nothing was reported and
 * the OSC value should be used. */
const statuses = new Map<string, AgentStatus | null>();

const key = (sessionId: string, incarnation: number): string => `${sessionId}#${incarnation}`;

/** A validated status body, as the endpoint accepts it. */
export type StatusInput = {
  readonly sessionId: string;
  readonly incarnation: number;
  readonly status: "working" | "waiting" | "clear";
  readonly name?: string;
  readonly sessionName?: string;
  readonly message?: string;
};

const NAME_CAP = 120;
const MESSAGE_CAP = 400;

const capped = (value: string | undefined, max: number): string | undefined =>
  value === undefined || value.length === 0 ? undefined : value.slice(0, max);

export const setStatus = (sessionId: string, incarnation: number, status: AgentStatus): void => {
  statuses.set(key(sessionId, incarnation), status);
};

/** Clear the status. Stored as a tombstone rather than deleted: the presenter must not fall back
 * to an older OSC status for a session the CLI explicitly cleared. */
export const clearStatus = (sessionId: string, incarnation: number): void => {
  statuses.set(key(sessionId, incarnation), null);
};

/** The reported status, or `null` for an explicit clear, or `undefined` when nothing was
 * reported. */
export const statusOf = (sessionId: string, incarnation: number): AgentStatus | null | undefined =>
  statuses.get(key(sessionId, incarnation));

/** Forget statuses whose session incarnation is gone. */
export const pruneStatuses = (live: ReadonlySet<string>): void => {
  for (const existing of statuses.keys()) if (!live.has(existing)) statuses.delete(existing);
};

/** Apply one endpoint report, validating it against the live sessions. Unknown or dead
 * incarnations are refused rather than stored for a window that cannot present them.
 *
 * A session with a kill pending is still alive until the host observes the pty's exit, so a
 * report for it is accepted; once `session.list` says `alive:false` it is refused. (The report's
 * session-list round trip is per report; folding it into the host's push channel is a Phase 6
 * item.) */
export const applyStatus = async (input: StatusInput): Promise<void> => {
  if (!hostRunning()) throw new Error("no terminal host is running");
  const client = await hostClient();
  const session = (await client.list()).find((entry) => entry.id === input.sessionId);
  if (session === undefined || session.incarnation !== input.incarnation) {
    throw new Error(`no such session incarnation: ${input.sessionId}#${input.incarnation}`);
  }
  if (input.status === "clear") {
    clearStatus(input.sessionId, input.incarnation);
    return;
  }
  if (!session.alive) throw new Error(`the session has ended: ${input.sessionId}#${input.incarnation}`);
  setStatus(input.sessionId, input.incarnation, {
    state: input.status,
    ...(capped(input.name, NAME_CAP) ? { name: capped(input.name, NAME_CAP) } : {}),
    ...(capped(input.sessionName, NAME_CAP) ? { sessionName: capped(input.sessionName, NAME_CAP) } : {}),
    ...(capped(input.message, MESSAGE_CAP) ? { message: capped(input.message, MESSAGE_CAP) } : {}),
    at: new Date().toISOString(),
  });
};
