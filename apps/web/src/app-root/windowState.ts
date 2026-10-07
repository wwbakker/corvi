import type { TerminalWindow } from "@corvi/contracts/terminal";
import type { WindowActionBodyDto } from "@corvi/contracts/api";

/**
 * The page's window lists, per source, with the ordering rules that keep a slow or failed source
 * from rolling back a newer selection or creation.
 *
 * A read answers for every change of one source at once, so its result is only safe while no
 * mutation of that source is in flight: a mutation may have moved the active flag between the
 * server building the read and the page applying it. Reads that raced a mutation are dropped and
 * reconciled with a fresh read once the pending mutations have settled, so dropping one never
 * leaves a change permanently stale. Mutations of different changes are independent — each change
 * keeps its own serialized queue, so one change's slow write cannot suppress another's — while the
 * source-level read guard still covers every change the read touched. Conflicting operations on
 * one change are serialized, so the server sees them in the order the user asked for them and the
 * last explicit choice wins without depending on response arrival order.
 *
 * Ordering is scoped by the **identity of the per-source facts object**, not by id alone: removing
 * a source invalidates it (its facts are dropped), and a re-added source gets a fresh object, so a
 * read or a queued mutation still in flight for the old registration can neither publish nor
 * schedule another read. A URL/token change that keeps the same workspace id is not visible to
 * this store; the source identity needed to invalidate that case belongs to the availability
 * source contract (chunk 2/3).
 *
 * A failed read keeps the last known list and marks the source not fresh; a source with no list
 * yet is empty but explicitly not fresh, which is not the same claim as a successful empty answer.
 * A successful mutation alone never marks a source fresh (it answered for one change, not the
 * source). A failed mutation is kept per change so the page can say what failed instead of
 * silently leaving the old selection on screen.
 *
 * One in-flight request per source is deliberately untimed here: a remote that accepts the
 * connection and never answers keeps its writes pending and its reads dropped until it does. The
 * bounded deadline and reconnect loop for that belong to the availability chunk; this store must
 * not grow an automatic retry before it.
 */
export type SourceWindows = {
  readonly byChange: Readonly<Record<string, readonly TerminalWindow[]>>;
  readonly fresh: boolean;
};

export type WindowsSnapshot = {
  readonly bySource: Readonly<Record<string, SourceWindows>>;
  /** Why a mutation failed, by source and change id. Cleared by a later success on the same change. */
  readonly errors: Readonly<Record<string, Readonly<Record<string, string>>>>;
};

/** The calls the store makes. The page passes the real client; a test passes scripted promises so
 * it can complete them in a chosen order. */
export type WindowsTransport = {
  /** `generation` is the target the read belongs to, captured before it left: the transport binds
   * its capability to it, so a read answered after a retarget cannot reach the new target. */
  readonly list: (
    sourceId: string,
    generation: string,
  ) => Promise<Readonly<Record<string, readonly TerminalWindow[]>>>;
  readonly act: (
    sourceId: string,
    generation: string,
    changeId: string,
    action: WindowActionBodyDto,
  ) => Promise<readonly TerminalWindow[]>;
};

export type WindowsStore = {
  readonly subscribe: (listener: () => void) => () => void;
  readonly snapshot: () => WindowsSnapshot;
  /** Which sources exist now: results already in flight for a source that is gone are discarded,
   * and its lists, errors and mutation queues are dropped. */
  readonly setSources: (sourceIds: readonly string[]) => void;
  /** Read every configured source; one failed source keeps its last known list. */
  readonly refresh: () => void;
  /** Tell the store a source's target identity and reachability. A changed `generation` retires
   * the old target's data, in-flight reads and queued writes; `maySend` false keeps the last
   * known list marked stale; a recovery re-reads. */
  readonly reconfigure: (sourceId: string, generation: string, maySend: boolean) => void;
  readonly select: (sourceId: string, changeId: string, index: number) => Promise<void>;
  readonly create: (sourceId: string, changeId: string) => Promise<void>;
  readonly move: (sourceId: string, changeId: string, from: number, to: number) => Promise<void>;
  /** Bring a window to the front by stable identity — the window id, not a cached index. */
  readonly focus: (sourceId: string, changeId: string, windowId: string) => Promise<void>;
};

/** Per-source ordering facts. `epoch` changes whenever a mutation of the source starts or settles;
 * a read carries the epoch it started in and is dropped when it no longer matches. `pending` is how
 * many mutations of the source are queued or running. `reconcile` remembers that a read was dropped
 * so a fresh one runs once the writes settle. The object's identity is the source's generation: a
 * removed/re-added source replaces it, and any in-flight work holding the old object is discarded. */
type SourceFacts = {
  epoch: number;
  pending: number;
  reading: boolean;
  reread: boolean;
  reconcile: boolean;
};

/** One change's mutation queue: `tail` serializes conflicting operations so the server sees them
 * in the order the user asked for them. */
type ChangeFacts = {
  tail: Promise<void>;
};

const emptySnapshot: WindowsSnapshot = { bySource: {}, errors: {} };

export const makeWindowsStore = (transport: WindowsTransport): WindowsStore => {
  let snapshot: WindowsSnapshot = emptySnapshot;
  const listeners = new Set<() => void>();
  const configured = new Set<string>();
  const sourceFacts = new Map<string, SourceFacts>();
  const changeFacts = new Map<string, ChangeFacts>();
  /** Each source's target identity, and whether the availability owner lets it send. */
  const generations = new Map<string, string>();
  const sendable = new Map<string, boolean>();
  /** Writes that may have reached the remote, by `source\0change`: a target change reports each
   * as an unknown outcome immediately, even if its promise never settles. */
  const inflightWrites = new Map<string, { readonly sourceId: string; readonly changeId: string }>();

  const publish = (next: WindowsSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const factsOf = (sourceId: string): SourceFacts => {
    let facts = sourceFacts.get(sourceId);
    if (facts === undefined) {
      facts = { epoch: 0, pending: 0, reading: false, reread: false, reconcile: false };
      sourceFacts.set(sourceId, facts);
    }
    return facts;
  };

  const changeOf = (key: string): ChangeFacts => {
    let facts = changeFacts.get(key);
    if (facts === undefined) {
      facts = { tail: Promise.resolve() };
      changeFacts.set(key, facts);
    }
    return facts;
  };

  /** Whether the facts object a request captured still belongs to the source that owns it now.
   * False after the source was removed (and true again only for a fresh object on a re-add). */
  const isCurrent = (sourceId: string, facts: SourceFacts): boolean =>
    configured.has(sourceId) && sourceFacts.get(sourceId) === facts;

  const readSource = async (sourceId: string): Promise<void> => {
    if (!configured.has(sourceId)) return;
    // Only `available` remotes (and always the local server) may send; a checking or unavailable
    // source keeps what it has rather than asking through a gate that would only refuse it.
    if (sourceId !== "" && sendable.get(sourceId) !== true) return;
    const facts = factsOf(sourceId);
    // One read per source at a time; an event that arrives mid-read coalesces into one more.
    if (facts.reading) {
      facts.reread = true;
      return;
    }
    facts.reading = true;
    const epoch = facts.epoch;
    // The target this read belongs to. The transport binds its capability to it; a retarget while
    // the read is in flight leaves the answer for a target that is no longer here.
    const generation = generations.get(sourceId) ?? "";
    try {
      const byChange = await transport.list(sourceId, generation);
      if (!isCurrent(sourceId, facts)) return;
      if (facts.epoch !== epoch || facts.pending > 0) {
        facts.reconcile = true;
        return;
      }
      publish({
        bySource: { ...snapshot.bySource, [sourceId]: { byChange, fresh: true } },
        errors: snapshot.errors,
      });
    } catch {
      if (!isCurrent(sourceId, facts)) return;
      if (facts.epoch !== epoch || facts.pending > 0) {
        facts.reconcile = true;
        return;
      }
      // A failed read keeps what was last known and stops vouching for it. With nothing known the
      // source is empty and explicitly not fresh, which a later unavailable surface can tell apart
      // from a successful empty list.
      const current = snapshot.bySource[sourceId];
      publish({
        bySource: {
          ...snapshot.bySource,
          [sourceId]: { byChange: current?.byChange ?? {}, fresh: false },
        },
        errors: snapshot.errors,
      });
    } finally {
      facts.reading = false;
      // Only the facts object that still owns the source may start another read: an old finally
      // must not schedule a ghost read for a source that was removed or replaced.
      if (!isCurrent(sourceId, facts)) return;
      if (facts.reread) {
        facts.reread = false;
        void readSource(sourceId);
      } else if (facts.pending === 0 && facts.reconcile) {
        facts.reconcile = false;
        void readSource(sourceId);
      }
    }
  };

  /** Record one change's failure without touching the rest of the source. The generation the
   * write was made against travels with the message: a queued write of a retired target must not
   * stamp its failure onto the replacement that now shares the source id. */
  const markError = (sourceId: string, changeId: string, generation: string, message: string): void => {
    if (!configured.has(sourceId)) return;
    if ((generations.get(sourceId) ?? "") !== generation) return;
    publish({
      bySource: snapshot.bySource,
      errors: {
        ...snapshot.errors,
        [sourceId]: { ...(snapshot.errors[sourceId] ?? {}), [changeId]: message },
      },
    });
  };

  /** Retire a source's in-flight reads, queued sends and (on a retarget) its data. `clearData`
   * distinguishes a same-target outage (keep the last known list, marked stale) from a retarget
   * (the old target's data was never this one's). In-flight writes are reported uncertain now. */
  const retireSource = (sourceId: string, clearData: boolean): void => {
    sourceFacts.delete(sourceId);
    for (const key of [...changeFacts.keys()]) {
      if (key.startsWith(`${sourceId}\u0000`)) changeFacts.delete(key);
    }
    const errors = { ...snapshot.errors };
    if (clearData) delete errors[sourceId];
    let errorsChanged = false;
    for (const [key, write] of inflightWrites) {
      if (write.sourceId !== sourceId) continue;
      inflightWrites.delete(key);
      errors[sourceId] = {
        ...(errors[sourceId] ?? {}),
        [write.changeId]: "the workspace changed while saving; the outcome is unknown",
      };
      errorsChanged = true;
    }
    const bySource = { ...snapshot.bySource };
    if (clearData) delete bySource[sourceId];
    else {
      const current = bySource[sourceId];
      if (current !== undefined) bySource[sourceId] = { ...current, fresh: false };
    }
    if (clearData || errorsChanged || snapshot.bySource[sourceId]?.fresh === true) {
      publish({ bySource, errors });
    }
  };

  const reconcileIfSettled = (sourceId: string, facts: SourceFacts): void => {
    if (!isCurrent(sourceId, facts)) return;
    if (facts.pending === 0 && facts.reconcile) {
      facts.reconcile = false;
      void readSource(sourceId);
    }
  };

  const enqueue = (sourceId: string, changeId: string, action: WindowActionBodyDto): Promise<void> => {
    // A removed source has nowhere to send: refuse at entry rather than queue work that can
    // never be published.
    if (!configured.has(sourceId)) return Promise.resolve();
    // The target this write belongs to, captured before it can be retired: its late failure must
    // not be published for a replacement target that reuses the source id.
    const generation = generations.get(sourceId) ?? "";
    const facts = factsOf(sourceId);
    const change = changeOf(`${sourceId}\u0000${changeId}`);
    // Claim the source read before the request even leaves: a read that started from now on may
    // have been answered before this write landed, so it must not be published.
    facts.pending += 1;
    facts.epoch += 1;
    const writeKey = `${sourceId}\u0000${changeId}`;
    const run = change.tail.then(async () => {
      // The source may have been removed or its target retired while this waited for its turn.
      // Re-check before the write leaves: a queued send must not reach the transport, and its
      // outcome is known — nothing was sent.
      if (!isCurrent(sourceId, facts)) {
        markError(sourceId, changeId, generation, "the workspace became unavailable before saving; nothing was sent");
        return;
      }
      // From here the write may reach the remote; if the target is retired before it settles, its
      // outcome is genuinely unknown and is reported as such rather than replayed.
      let sent = false;
      try {
        sent = true;
        inflightWrites.set(writeKey, { sourceId, changeId });
        const windows = await transport.act(sourceId, generation, changeId, action);
        if (!isCurrent(sourceId, facts)) return;
        const current = snapshot.bySource[sourceId];
        const errors = clearError(snapshot.errors, sourceId, changeId);
        publish({
          bySource: {
            ...snapshot.bySource,
            [sourceId]: {
              byChange: { ...(current?.byChange ?? {}), [changeId]: windows },
              // A mutation answered for one change only: it never vouches for the whole source.
              fresh: current?.fresh ?? false,
            },
          },
          errors,
        });
      } catch (error) {
        if (!isCurrent(sourceId, facts)) return;
        publish({
          bySource: snapshot.bySource,
          errors: {
            ...snapshot.errors,
            [sourceId]: {
              ...(snapshot.errors[sourceId] ?? {}),
              [changeId]: error instanceof Error ? error.message : String(error),
            },
          },
        });
      } finally {
        facts.pending -= 1;
        facts.epoch += 1;
        // If retireSource already reported this write, the entry is gone and it is not repeated.
        const tracked = inflightWrites.delete(writeKey);
        if (sent && tracked && !isCurrent(sourceId, facts)) {
          markError(sourceId, changeId, generation, "the workspace changed while saving; the outcome is unknown");
        }
        reconcileIfSettled(sourceId, facts);
      }
    });
    // A store listener that throws must not surface as an unhandled rejection from a `void`ed
    // call; the failure itself is already recorded in the snapshot.
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    change.tail = settled;
    return settled;
  };

  return {
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => snapshot,
    setSources: (sourceIds: readonly string[]): void => {
      const next = new Set(sourceIds);
      const removed = [...configured].filter((id) => !next.has(id));
      configured.clear();
      for (const id of next) configured.add(id);
      for (const id of removed) {
        // Dropping the facts object is the generation bump: in-flight work holds the old object and
        // will neither publish nor schedule reads. A re-add creates a fresh one.
        sourceFacts.delete(id);
        generations.delete(id);
        sendable.delete(id);
        for (const key of [...changeFacts.keys()]) {
          if (key.startsWith(`${id}\u0000`)) changeFacts.delete(key);
        }
      }
      if (removed.length > 0) {
        const bySource: Record<string, SourceWindows> = {};
        for (const [id, entry] of Object.entries(snapshot.bySource)) if (next.has(id)) bySource[id] = entry;
        const errors: Record<string, Readonly<Record<string, string>>> = {};
        for (const [id, entry] of Object.entries(snapshot.errors)) if (next.has(id)) errors[id] = entry;
        publish({ bySource, errors });
      }
      for (const id of next) void readSource(id);
    },
    refresh: (): void => {
      for (const id of configured) void readSource(id);
    },
    reconfigure: (sourceId: string, generation: string, maySend: boolean): void => {
      const previousGeneration = generations.get(sourceId);
      const changed = previousGeneration !== undefined && previousGeneration !== generation;
      const wasSendable = sendable.get(sourceId) ?? false;
      if (changed) {
        // A retarget with the same source id: the old target's data was never this target's.
        retireSource(sourceId, true);
      } else if (!maySend && wasSendable) {
        // A same-target outage: keep the last known list marked stale, retire its in-flight and
        // queued work so a recovery re-reads rather than replaying anything.
        retireSource(sourceId, false);
      }
      generations.set(sourceId, generation);
      sendable.set(sourceId, maySend);
      if (!maySend) return;
      if (!wasSendable || changed) void readSource(sourceId);
    },
    select: (sourceId: string, changeId: string, index: number): Promise<void> =>
      enqueue(sourceId, changeId, { action: "select", index }),
    create: (sourceId: string, changeId: string): Promise<void> =>
      enqueue(sourceId, changeId, { action: "new" }),
    move: (sourceId: string, changeId: string, from: number, to: number): Promise<void> =>
      enqueue(sourceId, changeId, { action: "move", from, to }),
    focus: (sourceId: string, changeId: string, windowId: string): Promise<void> =>
      // The server selects by id under the registry lock; no positional index crosses a read.
      enqueue(sourceId, changeId, { action: "select", window: windowId }),
  };
};

/** Drop one change's error, and the source's map with it when it was the last one. */
const clearError = (
  errors: WindowsSnapshot["errors"],
  sourceId: string,
  changeId: string,
): WindowsSnapshot["errors"] => {
  const source = errors[sourceId];
  if (source === undefined || source[changeId] === undefined) return errors;
  const next = { ...source };
  delete next[changeId];
  if (Object.keys(next).length === 0) {
    const without = { ...errors };
    delete without[sourceId];
    return without;
  }
  return { ...errors, [sourceId]: next };
};
