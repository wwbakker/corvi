import {
  ClientError,
  makeCorviClient,
  makeWireClient,
  type CorviClient,
  type FetchLike,
  type WireClient,
} from "@corvi/client";
import { Schema } from "effect";
import {
  RemoteAvailabilitySnapshotSchema,
  type RemoteAvailabilityReasonDto,
  type RemoteAvailabilitySnapshotDto,
  type RemoteAvailabilityStatusDto,
} from "@corvi/contracts/availability";

/**
 * The page's owner of remote availability, its client gate, and the clients themselves.
 *
 * There is deliberately no module-level instance: an owner is constructed by `SourcesProvider`
 * and disposed with it, so two app instances (two tests, two mounts) cannot share state. The
 * owner holds the authoritative availability epoch (a snapshot's `instance`/`revision`), wraps
 * every remote client's transport in a gate, and aborts in-flight work when a target's
 * reachability or identity changes.
 *
 * The gate is the app-wide seam: an unavailable or still-checking remote never reaches the
 * network, and a response whose target generation changed on the way back is discarded — headers
 * and body alike, because the request stays registered until its body is consumed. Local
 * (`""`) traffic is never gated. Nothing here retries or replays a write.
 */

/** One source's availability as the page holds it. */
export type OwnerAvailabilityEntry = {
  readonly status: RemoteAvailabilityStatusDto;
  readonly generation: string;
  readonly revision: number;
};

export type OwnerAvailability = {
  /** The authoritative epoch: null until the first snapshot answer establishes it. */
  readonly instance: string | null;
  readonly revision: number;
  readonly entries: Readonly<Record<string, OwnerAvailabilityEntry>>;
};

export const EMPTY_AVAILABILITY: OwnerAvailability = { instance: null, revision: 0, entries: {} };

/** Why a gated request did not produce an answer. `cancelled` is a read that was retired;
 * `uncertain` is a write that may have reached the remote, whose outcome is unknown. */
export type GateKind = "checking" | "unavailable" | "cancelled" | "uncertain" | "stale-target";

export type GateFailure = {
  readonly kind: GateKind;
  readonly message: string;
  readonly reason?: RemoteAvailabilityReasonDto;
};

/** The abort reason a retired request carries. It survives `@corvi/client`'s wrapping as the
 * `ClientError`'s cause, so callers can classify the failure without parsing a message. */
export class RemoteGateAbort extends Error {
  readonly kind: "cancelled" | "uncertain" | "stale-target";
  constructor(kind: "cancelled" | "uncertain" | "stale-target", message: string) {
    super(message);
    this.name = "RemoteGateAbort";
    this.kind = kind;
  }
}

const isGateCode = (value: unknown): value is GateKind =>
  value === "checking" || value === "unavailable" || value === "cancelled" || value === "uncertain" || value === "stale-target";

/** Classify a failed client call as a gate outcome, or undefined for an ordinary error. */
export const gateFailureOf = (error: unknown): GateFailure | undefined => {
  if (error instanceof RemoteGateAbort) {
    return { kind: error.kind, message: error.message };
  }
  if (error instanceof ClientError) {
    const body = error.body as { code?: unknown; reason?: unknown; error?: unknown } | undefined;
    if (body !== undefined && isGateCode(body.code)) {
      return {
        kind: body.code,
        message: typeof body.error === "string" ? body.error : error.message,
        ...(body.reason === undefined ? {} : { reason: body.reason as RemoteAvailabilityReasonDto }),
      };
    }
    if (error.cause !== undefined && error.cause !== error) return gateFailureOf(error.cause);
  }
  return undefined;
};

export type SourceOwner = {
  readonly availability: () => OwnerAvailability;
  readonly subscribe: (listener: () => void) => () => void;
  /** Fetch the authoritative snapshot, retiring any in-flight snapshot request. */
  readonly refresh: () => void;
  /** Apply an `availability` event payload; `""` (an EventSource open) re-establishes the epoch. */
  readonly applyEvent: (payload: string) => void;
  /** Ask the server for one coordinated check of a source. */
  readonly retry: (sourceId: string) => Promise<void>;
  /** Whether a source may send now. Local always may; only `available` remotes may. */
  readonly maySend: (sourceId: string) => boolean;
  /** The client for one specific target generation. A caller that captured a generation (a queued
   * window action) acquires the capability for that target: if the source has retargeted since,
   * the capability's own gate refuses the send as stale rather than reaching the new target. */
  readonly clientForGeneration: (sourceId: string, generation: string) => CorviClient;
  /** The wire for one specific target generation, the same rule. */
  readonly wireForGeneration: (sourceId: string, generation: string) => WireClient;
  readonly clientFor: (sourceId: string) => CorviClient;
  readonly wireFor: (sourceId: string) => WireClient;
  /** Requests still in flight for a source, for tests and diagnostics. */
  readonly inflightCount: (sourceId: string) => number;
  readonly dispose: () => void;
};

export type SourceOwnerDeps = {
  /** The local server's availability route. Injectable so two owners are independently testable. */
  readonly local: Pick<CorviClient["remotes"], "availability" | "retry">;
  readonly baseUrlOf: (sourceId: string) => string;
  /** The transport the gate wraps. Defaults to the platform fetch. */
  readonly fetch?: FetchLike;
};

const gateResponse = (status: number, failure: GateFailure, sourceId: string): Response =>
  new Response(
    JSON.stringify({
      error: failure.message,
      code: failure.kind,
      source: sourceId,
      ...(failure.reason === undefined ? {} : { reason: failure.reason }),
    }),
    { status, headers: { "content-type": "application/json" } },
  );

export const makeSourceOwner = (deps: SourceOwnerDeps): SourceOwner => {
  const innerFetch: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
  const listeners = new Set<() => void>();
  const clients = new Map<string, CorviClient>();
  const wireClients = new Map<string, WireClient>();
  const inflight = new Map<
    number,
    { sourceId: string; controller: AbortController; kind: "read" | "write"; retired: boolean }
  >();
  let current: OwnerAvailability = EMPTY_AVAILABILITY;
  let snapshotController: AbortController | undefined;
  let retryController: AbortController | undefined;
  let snapshotSeq = 0;
  let requestSeq = 0;
  let disposed = false;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  /** Retire one source's in-flight requests. Reads are `stale-target` for a retarget and
   * `cancelled` for a loss of reachability; a write that may have reached the remote is always
   * `uncertain`, and is never replayed. The retired flag is what a non-cooperative body sees:
   * abort alone is a request to the transport, not a guarantee. */
  const retire = (sourceId: string, readKind: "cancelled" | "stale-target", reason?: string): void => {
    for (const [id, request] of inflight) {
      if (request.sourceId !== sourceId) continue;
      inflight.delete(id);
      request.retired = true;
      const kind = request.kind === "write" ? "uncertain" : readKind;
      request.controller.abort(
        new RemoteGateAbort(
          kind,
          reason ??
            (kind === "uncertain"
              ? "the workspace changed while saving; the outcome is unknown"
              : "the workspace's target was retired before this read answered"),
        ),
      );
    }
  };

  const entriesOf = (snapshot: RemoteAvailabilitySnapshotDto): Record<string, OwnerAvailabilityEntry> => {
    const entries: Record<string, OwnerAvailabilityEntry> = {};
    for (const entry of snapshot.availability) {
      entries[entry.source] = { status: entry.status, generation: entry.generation, revision: entry.revision };
    }
    return entries;
  };

  /** How a new state invalidates in-flight work: a changed generation, a lost reachability, a
   * removed source. A same-generation availability change keeps its in-flight reads. */
  const invalidated = (previous: OwnerAvailability, next: OwnerAvailability): void => {
    for (const [sourceId, before] of Object.entries(previous.entries)) {
      const after = next.entries[sourceId];
      if (after === undefined) {
        retire(sourceId, "cancelled");
        continue;
      }
      if (after.generation !== before.generation) {
        retire(sourceId, "stale-target");
        continue;
      }
      if (before.status._tag === "available" && after.status._tag !== "available") {
        retire(sourceId, "cancelled");
      }
    }
  };

  const adopt = (snapshot: RemoteAvailabilitySnapshotDto, authoritative: boolean): void => {
    if (authoritative) {
      // A snapshot answer is the authoritative epoch. An older revision for the same instance
      // must not roll back an event that already arrived.
      if (current.instance === snapshot.instance && snapshot.revision < current.revision) return;
    } else {
      // Events never establish or change the epoch; the caller handles that.
      if (current.instance === null || snapshot.instance !== current.instance) return;
      if (snapshot.revision <= current.revision) return;
    }
    const previous = current;
    current = { instance: snapshot.instance, revision: snapshot.revision, entries: entriesOf(snapshot) };
    invalidated(previous, current);
    notify();
  };

  const refresh = (): void => {
    if (disposed) return;
    snapshotController?.abort();
    const controller = new AbortController();
    snapshotController = controller;
    const seq = ++snapshotSeq;
    deps.local
      .availability({ signal: controller.signal })
      .then((snapshot) => {
        if (disposed || seq !== snapshotSeq) return;
        adopt(snapshot, true);
      })
      .catch(() => {
        // The local server could not be asked; the next open or explicit refresh tries again.
      });
  };

  /** A disposed owner refuses every call, local included: its lifetime is over. */
  const refused = (sourceId: string): Response =>
    gateResponse(503, { kind: "cancelled", message: "this page's connection is gone" }, sourceId);

  /** The target a source names now. The local source has no entry and is always the same target. */
  const generationOf = (sourceId: string): string => current.entries[sourceId]?.generation ?? "";

  /** A capability is bound to the target it was acquired for, not just the source id: a client or
   * wire held across a retarget must not carry the old target's request to the new one. */
  const capabilityKey = (sourceId: string, generation: string): string => `${sourceId}\u0000${generation}`;

  const gatedFetch = (sourceId: string, generation: string): FetchLike => async (input, init) => {
    if (disposed) return refused(sourceId);
    // The capability belongs to the target it was acquired for. After a retarget it is spent: the
    // same stale-target answer the gate gives retired work, and no request leaves the browser.
    if (generationOf(sourceId) !== generation) {
      return gateResponse(
        503,
        { kind: "stale-target", message: "this request belongs to a workspace target that has changed" },
        sourceId,
      );
    }
    const entry = current.entries[sourceId];
    if (entry === undefined || entry.status._tag !== "available") {
      const failure: GateFailure =
        entry?.status._tag === "unavailable"
          ? { kind: "unavailable", message: entry.status.reason.message, reason: entry.status.reason }
          : { kind: "checking", message: "checking this workspace's availability" };
      return gateResponse(503, failure, sourceId);
    }
    const outer = init?.signal;
    // An already-aborted client never reaches the network, and never becomes a transport
    // observation of the remote.
    if (outer?.aborted === true) throw new RemoteGateAbort("cancelled", "the request was aborted before it was sent");
    const method = (init?.method ?? "GET").toUpperCase();
    const kind: "read" | "write" = method === "GET" || method === "HEAD" ? "read" : "write";
    const controller = new AbortController();
    if (outer != null) outer.addEventListener("abort", () => controller.abort(outer.reason), { once: true });
    const id = ++requestSeq;
    const record: { sourceId: string; controller: AbortController; kind: "read" | "write"; retired: boolean } = {
      sourceId,
      controller,
      kind,
      retired: false,
    };
    // The abort reason owns the classification (cancelled vs stale-target vs uncertain); the
    // retired flag only makes a non-cooperative body notice it.
    const retiredFailure = (): RemoteGateAbort => {
      const reason = controller.signal.reason;
      return reason instanceof RemoteGateAbort
        ? reason
        : new RemoteGateAbort(kind === "write" ? "uncertain" : "stale-target", "the target was retired");
    };
    inflight.set(id, record);
    try {
      const response = await innerFetch(input, { ...init, signal: controller.signal });
      if (response.body === null || record.retired) {
        inflight.delete(id);
        if (record.retired) {
          // Headers arrived, but the target was gone before the body was handed out: drop the
          // body rather than leave it for whoever would have read it to consume old bytes.
          void response.body?.cancel().catch(() => undefined);
          throw retiredFailure();
        }
        return response;
      }
      // The request stays registered until its body is consumed, so a target change between the
      // headers and the body still reaches the read. The retired flag is checked on every pull:
      // a body that ignores the abort signal must not deliver old-target bytes.
      const reader = response.body.getReader();
      // One abort deferral for the whole request, not one per pull: a non-cooperative body may
      // ignore the abort and never send another byte, and racing its read against this is what
      // unsticks it. The listener is removed as soon as the body ends, cancels, or errors, so a
      // consumed request leaves nothing attached to the signal.
      let settleAbort: ((reason: RemoteGateAbort) => void) | undefined;
      const unstuck = new Promise<never>((_resolve, reject) => {
        settleAbort = reject;
      });
      // Nothing races it if the body is never pulled; that must not surface as an unhandled
      // rejection when the request is eventually retired.
      unstuck.catch(() => undefined);
      const onAbort = (): void => settleAbort?.(retiredFailure());
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener("abort", onAbort, { once: true });
      const release = (): void => {
        settleAbort = undefined;
        controller.signal.removeEventListener("abort", onAbort);
      };
      const body = new ReadableStream<Uint8Array>({
        pull: async (controllerStream) => {
          if (record.retired) {
            inflight.delete(id);
            release();
            void reader.cancel().catch(() => undefined);
            controllerStream.error(retiredFailure());
            return;
          }
          try {
            const { value, done } = await Promise.race([reader.read(), unstuck]);
            if (done) {
              inflight.delete(id);
              release();
              controllerStream.close();
              return;
            }
            if (record.retired) {
              inflight.delete(id);
              release();
              void reader.cancel().catch(() => undefined);
              controllerStream.error(retiredFailure());
              return;
            }
            controllerStream.enqueue(value);
          } catch (error) {
            inflight.delete(id);
            release();
            // The body is over (errored or retired mid-stream): release the underlying stream
            // too, so it is not left producing bytes for a read nobody will consume.
            void reader.cancel(error).catch(() => undefined);
            controllerStream.error(error);
          }
        },
        cancel: (reason) => {
          inflight.delete(id);
          release();
          void reader.cancel(reason);
        },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      inflight.delete(id);
      throw error;
    }
  };

  // Local traffic is never gated on availability, but it must still refuse after disposal and it
  // still uses the injected transport, so a test can drive both halves of the owner.
  const localFetch: FetchLike = async (input, init) => (disposed ? refused("") : innerFetch(input, init));

  /** A capability cached by `(source, generation)`. A new generation drops the superseded entries:
   * a component holding the object keeps it (and its sends are refused as stale), but the cache
   * cannot grow one client per retarget. Local is `""` and always the same entry. */
  const dropSuperseded = (cache: Map<string, unknown>, sourceId: string, keep: string): void => {
    const prefix = `${sourceId}\u0000`;
    for (const known of [...cache.keys()]) if (known !== keep && known.startsWith(prefix)) cache.delete(known);
  };

  const clientAt = (sourceId: string, generation: string): CorviClient => {
    const key = capabilityKey(sourceId, generation);
    let client = clients.get(key);
    if (client === undefined) {
      client = makeCorviClient({
        baseUrl: deps.baseUrlOf(sourceId),
        fetch: sourceId === "" ? localFetch : gatedFetch(sourceId, generation),
      });
      clients.set(key, client);
    }
    return client;
  };

  const clientFor = (sourceId: string): CorviClient => {
    const generation = generationOf(sourceId);
    const client = clientAt(sourceId, generation);
    dropSuperseded(clients, sourceId, capabilityKey(sourceId, generation));
    return client;
  };

  const wireAt = (sourceId: string, generation: string): WireClient => {
    const key = capabilityKey(sourceId, generation);
    let wire = wireClients.get(key);
    if (wire === undefined) {
      wire = makeWireClient({
        baseUrl: deps.baseUrlOf(sourceId),
        fetch: sourceId === "" ? localFetch : gatedFetch(sourceId, generation),
      });
      wireClients.set(key, wire);
    }
    return wire;
  };

  const wireFor = (sourceId: string): WireClient => {
    const generation = generationOf(sourceId);
    const wire = wireAt(sourceId, generation);
    dropSuperseded(wireClients, sourceId, capabilityKey(sourceId, generation));
    return wire;
  };

  const retry = async (sourceId: string): Promise<void> => {
    if (disposed) return;
    // Retry shares the authoritative epoch's request sequence: a late retry answer must not
    // replace a snapshot a newer refresh or open has already established.
    const seq = ++snapshotSeq;
    // The local request is owned by this page too: a disposal (or a newer retry) aborts it rather
    // than leaving it to land on an owner that is gone.
    retryController?.abort();
    const controller = new AbortController();
    retryController = controller;
    try {
      const snapshot = await deps.local.retry(sourceId, { signal: controller.signal });
      if (disposed || seq !== snapshotSeq) return;
      adopt(snapshot, true);
    } catch {
      // The retry route failed (or was aborted): the state it left is what the surfaces show.
    } finally {
      if (retryController === controller) retryController = undefined;
    }
  };

  return {
    availability: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    applyEvent: (payload) => {
      if (disposed) return;
      if (payload === "") {
        // A reconnected stream is a new conversation with (possibly) a new server: retire what
        // was in flight and establish the epoch from an authoritative answer again.
        for (const [id, request] of inflight) {
          inflight.delete(id);
          request.retired = true;
          request.controller.abort(
            new RemoteGateAbort(request.kind === "write" ? "uncertain" : "cancelled", "the event stream reconnected"),
          );
        }
        refresh();
        return;
      }
      let snapshot: RemoteAvailabilitySnapshotDto;
      try {
        snapshot = Schema.decodeUnknownSync(RemoteAvailabilitySnapshotSchema)(JSON.parse(payload));
      } catch {
        refresh();
        return;
      }
      if (current.instance === null || snapshot.instance !== current.instance) {
        // An unknown epoch is never adopted from an event; the snapshot decides.
        refresh();
        return;
      }
      adopt(snapshot, false);
    },
    retry,
    maySend: (sourceId) => sourceId === "" || current.entries[sourceId]?.status._tag === "available",
    clientFor,
    clientForGeneration: (sourceId, generation) => clientAt(sourceId, generation),
    wireFor,
    wireForGeneration: (sourceId, generation) => wireAt(sourceId, generation),
    inflightCount: (sourceId) => {
      let count = 0;
      for (const request of inflight.values()) if (request.sourceId === sourceId) count += 1;
      return count;
    },
    dispose: () => {
      disposed = true;
      snapshotController?.abort();
      snapshotController = undefined;
      retryController?.abort();
      retryController = undefined;
      for (const [id, request] of inflight) {
        inflight.delete(id);
        request.retired = true;
        request.controller.abort(new RemoteGateAbort(request.kind === "write" ? "uncertain" : "cancelled", "the page is gone"));
      }
      listeners.clear();
      clients.clear();
      wireClients.clear();
    },
  };
};

/** The status a source has before any answer: local is always reachable, a configured remote is
 * still being checked. */
export const statusOf = (availability: OwnerAvailability, sourceId: string): RemoteAvailabilityStatusDto =>
  sourceId === "" ? { _tag: "available" } : (availability.entries[sourceId]?.status ?? { _tag: "checking" });

/** The `(Unavailable)` suffix the selector and its selected label use. */
export const availabilitySuffix = (status: RemoteAvailabilityStatusDto): string =>
  status._tag === "unavailable" ? " (Unavailable)" : "";

/** Whether the availability state changed in a way that retires a source's cached data. */
export const generationChanged = (before: OwnerAvailabilityEntry | undefined, after: OwnerAvailabilityEntry | undefined): boolean =>
  before !== undefined && after !== undefined && before.generation !== after.generation;
