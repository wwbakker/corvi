/** The remote-event fan-in and the availability owner.
 *
 * The page keeps its one local `EventSource`. For every remote workspace in the config this opens
 * `<remote.url>/api/events` with the workspace's device token, parses the named events, and calls
 * `announceFromSource`. The stream is reconnected with a bounded backoff; `reconcile` starts and
 * stops subscriptions as the config changes, and `stop` ends them on shutdown.
 *
 * The same stream is the availability owner's health signal: an open stream that keeps sending
 * bytes (event frames or the server's heartbeat comments) means the workspace is reachable, and
 * going quiet past a bound means it is not. The owner publishes one snapshot for every remote and
 * re-emits it on the local bus under `availability`. Retries are health reconnects only — a
 * failed write is never queued or replayed here.
 *
 * Nothing here reaches the page directly. The token lives in the config and is only ever an
 * `Authorization` header on the upstream request.
 */
import { randomUUID } from "node:crypto";
import { Effect } from "effect";

import type { RemoteWorkspaceDto } from "@corvi/contracts/config";
import type {
  RemoteAvailabilityReasonDto,
  RemoteAvailabilitySnapshotDto,
  RemoteAvailabilityStatusDto,
} from "@corvi/contracts/availability";
import { NotFoundError } from "@corvi/contracts/errors";
import { announceAvailability, announceFromSource } from "../capabilities/bus.ts";
import { runtimeConfig } from "../capabilities/runtime.ts";
import { DEFAULT_AVAILABILITY_DEADLINES, type RemoteAvailabilityDeadlines, type RemoteFetch, type RemoteObservation } from "./model.ts";

/** The remote event names the fan-in forwards. `open` and anything unknown are ignored. */
const EVENT_NAMES = new Set(["changes", "windows", "notify", "update", "power"]);
type Forwarded = "changes" | "windows" | "notify" | "update" | "power";

export type RemoteEvents = {
  /** Start, stop or restart subscriptions to match `runtimeConfig().workspaces`. */
  reconcile: () => Effect.Effect<void>;
  /** Abort every subscription, for a signal handler that is about to exit. */
  stop: () => void;
  /** The current availability map. Sync: the routes and the gateway read it. */
  snapshot: () => RemoteAvailabilitySnapshotDto;
  /** Ask for an immediate coordinated health check of one source. A healthy stream is left
   * untouched; a retry while a check is in flight coalesces into one more check. */
  retry: (source: string) => Effect.Effect<RemoteAvailabilitySnapshotDto, NotFoundError>;
  /** A transport-level observation from the gateway. It may request one recheck; it never
   * classifies a workspace from a single failed operation. */
  observe: (source: string, observation: RemoteObservation) => void;
};

export type RemoteEventsOptions = {
  readonly instance?: string;
  readonly transport?: RemoteFetch;
  readonly deadlines?: RemoteAvailabilityDeadlines;
};

/** What identifies a subscription: url, remote workspace id and token together. A change to any
 * of them is a different target, never a restart of the same one. */
const targetKey = (remote: RemoteWorkspaceDto): string =>
  `${remote.url}\n${remote.workspace}\n${remote.token ?? ""}`;

/** The remote's events URL, or undefined when the url is not http(s) (the 2.1 note: never fetch a
 * scheme the config should not hold). */
const eventsUrl = (remoteUrl: string): URL | undefined => {
  try {
    const base = new URL(remoteUrl);
    if (base.protocol !== "http:" && base.protocol !== "https:") return undefined;
    return new URL(`${remoteUrl.replace(/\/+$/, "")}/api/events`);
  } catch {
    return undefined;
  }
};

/** Statuses `fetch` would follow; the subscription refuses them instead, so a remote cannot point
 * the fan-in at another origin. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** A frame may be this large; a remote that never sends a blank line is cut off here rather than
 * growing local memory. */
const MAX_FRAME_BYTES = 1 << 20;

/** Bounded: half a second doubling to thirty. */
const backoffMs = (attempt: number): number => Math.min(30_000, 500 * 2 ** attempt);

/** Fixed, sanitized explanations. Never a raw remote error body, a token, or a credential-bearing
 * URL: the kind and this sentence are all a page needs. */
const unreachable = (message: string): RemoteAvailabilityReasonDto => ({ _tag: "unreachable", message });
const authentication = (message: string): RemoteAvailabilityReasonDto => ({ _tag: "authentication", message });
const configuration = (message: string): RemoteAvailabilityReasonDto => ({ _tag: "configuration", message });
const stalled = (message: string): RemoteAvailabilityReasonDto => ({ _tag: "stalled", message });

const MESSAGES = {
  unreachable: "the remote server could not be reached",
  timedOut: "the remote did not answer within the health check bound",
  authentication: "the remote refused this device token",
  configuration: "the remote workspace's url is not http or https",
  notAnEventStream: "the remote did not answer with an event stream",
  redirected: "the remote event stream redirected; configure the final address",
  refused: (status: number): string => `the remote event stream answered ${status}`,
  noFirstSignal: "the remote sent nothing after answering",
  stalled: "the remote stopped sending events",
  closed: "the remote closed the event stream",
  frameTooLarge: "the remote event stream sent a frame larger than the bound",
} as const;

/** One subscription's live owner. `generation` and `status` are published; the rest is the
 * reconnect state. A replaced entry is aborted and removed, and every callback checks it is still
 * the current one for its source before touching anything. */
type Entry = {
  readonly source: string;
  readonly remote: RemoteWorkspaceDto;
  readonly key: string;
  readonly generation: string;
  readonly controller: AbortController;
  status: RemoteAvailabilityStatusDto;
  revision: number;
  attempt: number;
  checking: boolean;
  retryQueued: boolean;
  reported: boolean;
  /** Resolves the current backoff wait early; set only while waiting. */
  waiting?: () => void;
};

type Owner = {
  readonly instance: string;
  readonly transport: RemoteFetch;
  readonly deadlines: RemoteAvailabilityDeadlines;
  readonly active: Map<string, Entry>;
  /** Installed once the snapshot variables exist. */
  publish: () => void;
};

/** The earliest blank line, whatever it is spelled with (`\n\n` or `\r\n\r\n`). */
const separatorAt = (buffer: string): { readonly at: number; readonly length: number } | undefined => {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return undefined;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { at: crlf, length: 4 };
  return { at: lf, length: 2 };
};

/** One SSE frame: its `event` name and its joined `data`. Comments (the heartbeat) are ignored. */
const parseFrame = (frame: string): { event?: string; data: string } => {
  let event: string | undefined;
  const data: string[] = [];
  for (const raw of frame.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line === "" || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return { event, data: data.join("\n") };
};

/** Whether an entry is still the one that owns its source: a replaced target's callbacks must not
 * publish, announce, or schedule anything. */
const isCurrent = (owner: Owner, entry: Entry): boolean =>
  owner.active.get(entry.source) === entry && !entry.controller.signal.aborted;

/** Publish one entry's status, only while it still owns its source. */
const setStatus = (owner: Owner, entry: Entry, status: RemoteAvailabilityStatusDto): void => {
  if (!isCurrent(owner, entry)) return;
  entry.status = status;
  entry.revision += 1;
  owner.publish();
};

type Outcome =
  | { readonly kind: "aborted" }
  | { readonly kind: "ended"; readonly healthy: boolean }
  | { readonly kind: "failure"; readonly reason: RemoteAvailabilityReasonDto; readonly healthy: boolean };

/** Read one connected stream. Resolves when it ends, stalls, or is aborted; publishes `available`
 * on the first byte and resets the stall bound on every byte after it. */
const readAttempt = async (owner: Owner, entry: Entry, response: Response, attempt: AbortController, outer: AbortSignal): Promise<Outcome> => {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let healthy = false;
  let ended = false;
  let timedOut: "first" | "stall" | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number, kind: "first" | "stall"): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = kind;
      attempt.abort();
    }, ms);
  };
  // The owner aborts the attempt (a deadline, a retarget, shutdown); the reader is cancelled
  // directly rather than relying on the body erroring for the signal. A body that ignores the
  // signal must not leave this read pending forever.
  const cancelRead = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  attempt.signal.addEventListener("abort", cancelRead, { once: true });
  outer.addEventListener("abort", cancelRead, { once: true });
  try {
    arm(owner.deadlines.firstSignalMs, "first");
    for (;;) {
      let read: { readonly done: boolean; readonly value?: Uint8Array };
      try {
        read = await reader.read();
      } catch {
        if (outer.aborted) return { kind: "aborted" };
        if (timedOut === "first") return { kind: "failure", reason: stalled(MESSAGES.noFirstSignal), healthy };
        if (timedOut === "stall") return { kind: "failure", reason: stalled(MESSAGES.stalled), healthy };
        return { kind: "failure", reason: unreachable(MESSAGES.unreachable), healthy };
      }
      if (read.done) {
        // A cancellation also resolves the pending read as done; the deadline decides first.
        if (outer.aborted) return { kind: "aborted" };
        if (timedOut === "first") return { kind: "failure", reason: stalled(MESSAGES.noFirstSignal), healthy };
        if (timedOut === "stall") return { kind: "failure", reason: stalled(MESSAGES.stalled), healthy };
        ended = true;
        return { kind: "ended", healthy };
      }
      const chunk = read.value ?? new Uint8Array();
      if (!healthy) {
        healthy = true;
        setStatus(owner, entry, { _tag: "available" });
      }
      arm(owner.deadlines.stallMs, "stall");
      buffer += decoder.decode(chunk, { stream: true });
      let separator = separatorAt(buffer);
      while (separator !== undefined) {
        const parsed = parseFrame(buffer.slice(0, separator.at));
        buffer = buffer.slice(separator.at + separator.length);
        if (parsed.event !== undefined && isCurrent(owner, entry) && EVENT_NAMES.has(parsed.event)) {
          announceFromSource(entry.source, parsed.event as Forwarded, parsed.data);
        }
        separator = separatorAt(buffer);
      }
      // What is left is one incomplete frame; a remote that never completes it must not grow this.
      if (buffer.length > MAX_FRAME_BYTES) {
        return { kind: "failure", reason: unreachable(MESSAGES.frameTooLarge), healthy };
      }
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    attempt.signal.removeEventListener("abort", cancelRead);
    outer.removeEventListener("abort", cancelRead);
    if (!ended) {
      // A stream we are giving up on is cancelled now, not left for the garbage collector.
      await reader.cancel().catch(() => undefined);
    } else {
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
    }
  }
};

/** Connect once and read until the stream ends; classifies every failure into a fixed reason. */
const attemptOnce = async (owner: Owner, entry: Entry): Promise<Outcome> => {
  const outer = entry.controller.signal;
  const url = eventsUrl(entry.remote.url);
  if (url === undefined) return { kind: "failure", reason: configuration(MESSAGES.configuration), healthy: false };

  const attempt = new AbortController();
  const onOuterAbort = (): void => attempt.abort();
  outer.addEventListener("abort", onOuterAbort, { once: true });
  let timedOut = false;
  const connectTimer = setTimeout(() => {
    timedOut = true;
    attempt.abort();
  }, owner.deadlines.connectMs);
  try {
    let response: Response;
    try {
      response = await owner.transport(url, {
        headers: entry.remote.token === undefined ? {} : { authorization: `Bearer ${entry.remote.token}` },
        signal: attempt.signal,
        // Never let a configured remote point the fan-in at another origin.
        redirect: "manual",
      });
    } catch {
      if (outer.aborted) return { kind: "aborted" };
      if (timedOut) return { kind: "failure", reason: unreachable(MESSAGES.timedOut), healthy: false };
      return { kind: "failure", reason: unreachable(MESSAGES.unreachable), healthy: false };
    } finally {
      clearTimeout(connectTimer);
    }
    if (outer.aborted) {
      void response.body?.cancel().catch(() => undefined);
      return { kind: "aborted" };
    }
    // The connect deadline can fire as the headers arrive: the attempt is already aborted, so
    // classify the timeout rather than falling through to a generic unreachable.
    if (timedOut) {
      void response.body?.cancel().catch(() => undefined);
      return { kind: "failure", reason: unreachable(MESSAGES.timedOut), healthy: false };
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      void response.body?.cancel().catch(() => undefined);
      return { kind: "failure", reason: configuration(MESSAGES.redirected), healthy: false };
    }
    if (response.status === 401 || response.status === 403) {
      void response.body?.cancel().catch(() => undefined);
      return { kind: "failure", reason: authentication(MESSAGES.authentication), healthy: false };
    }
    if (!response.ok || response.body === null) {
      void response.body?.cancel().catch(() => undefined);
      return { kind: "failure", reason: unreachable(MESSAGES.refused(response.status)), healthy: false };
    }
    if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream")) {
      void response.body?.cancel().catch(() => undefined);
      return { kind: "failure", reason: configuration(MESSAGES.notAnEventStream), healthy: false };
    }
    return await readAttempt(owner, entry, response, attempt, outer);
  } finally {
    outer.removeEventListener("abort", onOuterAbort);
  }
};

/** Wait out the backoff, woken early by a retry, an observation, or the owner aborting. */
const waitBackoff = (owner: Owner, entry: Entry): Promise<void> =>
  new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      entry.controller.signal.removeEventListener("abort", finish);
      if (entry.waiting === finish) entry.waiting = undefined;
      resolve();
    };
    const timer = setTimeout(finish, backoffMs(entry.attempt));
    entry.waiting = finish;
    entry.controller.signal.addEventListener("abort", finish, { once: true });
  });

/** Subscribe for as long as the entry is current: connect, read, back off, repeat. */
const run = async (owner: Owner, entry: Entry): Promise<void> => {
  const signal = entry.controller.signal;
  while (!signal.aborted) {
    entry.checking = true;
    let outcome: Outcome;
    try {
      outcome = await attemptOnce(owner, entry);
    } catch {
      // A defect in one attempt must not end the subscription or reject this loop.
      outcome = signal.aborted ? { kind: "aborted" } : { kind: "failure", reason: unreachable(MESSAGES.unreachable), healthy: false };
    }
    entry.checking = false;
    if (signal.aborted || outcome.kind === "aborted") return;
    entry.attempt = outcome.healthy ? 0 : Math.min(entry.attempt + 1, 6);
    // A stream that ends — even one that was healthy — is unavailable immediately, with the
    // bounded reconnect below. This is deliberate: chunk-3 gating must not keep calling a
    // source whose stream is gone, and no grace period would make that claim truer.
    if (outcome.kind === "failure") {
      if (!entry.reported) {
        console.error(`could not watch events for "${entry.source}": ${outcome.reason.message}; retrying`);
        entry.reported = true;
      }
      setStatus(owner, entry, { _tag: "unavailable", reason: outcome.reason });
    } else {
      setStatus(owner, entry, { _tag: "unavailable", reason: unreachable(MESSAGES.closed) });
    }
    if (entry.retryQueued) {
      entry.retryQueued = false;
      entry.attempt = 0;
      continue;
    }
    await waitBackoff(owner, entry);
  }
};

const subscribe = (owner: Owner, source: string, remote: RemoteWorkspaceDto): Entry => {
  const entry: Entry = {
    source,
    remote,
    key: targetKey(remote),
    generation: randomUUID(),
    controller: new AbortController(),
    status: { _tag: "checking" },
    revision: 0,
    attempt: 0,
    checking: false,
    retryQueued: false,
    reported: false,
  };
  void run(owner, entry);
  return entry;
};

export const makeRemoteEvents = (options: RemoteEventsOptions = {}): RemoteEvents => {
  const owner: Owner = {
    instance: options.instance ?? randomUUID(),
    transport: options.transport ?? ((url, init) => fetch(url, init)),
    deadlines: options.deadlines ?? DEFAULT_AVAILABILITY_DEADLINES,
    active: new Map(),
    publish: () => undefined,
  };
  let revision = 0;
  let current: RemoteAvailabilitySnapshotDto = {
    instance: owner.instance,
    revision: 0,
    availability: [],
  };
  owner.publish = (): void => {
    revision += 1;
    current = {
      instance: owner.instance,
      revision,
      availability: [...owner.active.values()].map((entry) => ({
        source: entry.source,
        status: entry.status,
        generation: entry.generation,
        revision: entry.revision,
      })),
    };
    announceAvailability(current);
  };

  const reconcile = (): void => {
    const wanted = new Map<string, RemoteWorkspaceDto>();
    for (const workspace of runtimeConfig().workspaces) {
      if (workspace.remote !== undefined) wanted.set(workspace.id, workspace.remote);
    }
    let changed = false;
    // A source that is gone, or whose target changed, is no longer the same subscription; its
    // generation is retired with it, so late callbacks cannot touch the replacement.
    for (const [source, entry] of owner.active) {
      const target = wanted.get(source);
      if (target === undefined || targetKey(target) !== entry.key) {
        entry.controller.abort();
        owner.active.delete(source);
        changed = true;
      }
    }
    for (const [source, remote] of wanted) {
      if (owner.active.has(source)) continue;
      owner.active.set(source, subscribe(owner, source, remote));
      changed = true;
    }
    if (changed) owner.publish();
  };

  return {
    reconcile: (): Effect.Effect<void> => Effect.sync(reconcile),
    stop: (): void => {
      for (const entry of owner.active.values()) entry.controller.abort();
      owner.active.clear();
    },
    snapshot: (): RemoteAvailabilitySnapshotDto => current,
    retry: (source: string): Effect.Effect<RemoteAvailabilitySnapshotDto, NotFoundError> =>
      Effect.suspend(() => {
        const entry = owner.active.get(source);
        if (entry === undefined) {
          return Effect.fail(new NotFoundError({ message: `no such remote workspace: ${source}` }));
        }
        // A healthy stream is already the best evidence; a retry must not interrupt it.
        if (entry.status._tag !== "available") {
          if (entry.waiting !== undefined) {
            // Waiting out a backoff: wake it now rather than starting a second loop.
            entry.waiting();
          } else {
            // An attempt is in flight (or its continuation is about to run): one more check will
            // follow it. Repeated retries collapse into that one queued check.
            entry.retryQueued = true;
          }
          if (entry.status._tag === "unavailable") setStatus(owner, entry, { _tag: "checking" });
        }
        return Effect.succeed(current);
      }),
    observe: (source: string, observation: RemoteObservation): void => {
      const entry = owner.active.get(source);
      if (entry === undefined) return;
      // A single failed operation is not workspace health, and a healthy stream needs no help.
      // At most, ask for one coordinated recheck; the check's own result does the classifying.
      // The observation's own kind is advisory and deliberately not used to classify: it is a
      // seam for later copy, never a verdict.
      if (entry.status._tag === "available") return;
      if (entry.checking) {
        entry.retryQueued = true;
      } else if (entry.waiting !== undefined) {
        entry.waiting();
      }
      void observation;
    },
  };
};
