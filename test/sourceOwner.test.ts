import { expect, test } from "bun:test";

import { Schema } from "effect";
import { ChangeId } from "@corvi/contracts/changes";
import type { FetchLike } from "@corvi/client";
import type {
  RemoteAvailabilitySnapshotDto,
  RemoteAvailabilityStatusDto,
} from "@corvi/contracts/availability";
import { gateFailureOf, makeSourceOwner, type SourceOwner } from "../apps/web/src/app-root/sourceOwner.ts";

/**
 * The page's availability owner and its client gate, with an injected transport and an injected
 * availability route: every epoch, gate, cancellation and disposal rule is asserted by call
 * counts and outcomes, not by timing. Two owners are constructed independently, which is the
 * point of not keeping a module-level registry.
 */

const until = async <T>(read: () => T | Promise<T>, want: T, ms = 1000): Promise<T> => {
  const deadline = Date.now() + ms;
  let value = await read();
  while (value !== want && Date.now() < deadline) {
    await Bun.sleep(5);
    value = await read();
  }
  return value;
};

const available: RemoteAvailabilityStatusDto = { _tag: "available" };
const unavailable: RemoteAvailabilityStatusDto = {
  _tag: "unavailable",
  reason: { _tag: "unreachable", message: "the remote server could not be reached" },
};

type Entry = RemoteAvailabilitySnapshotDto["availability"][number];
const entry = (
  source: string,
  status: RemoteAvailabilityStatusDto = available,
  generation = "g1",
  revision = 1,
): Entry => ({ source, status, generation, revision });

const snapshot = (over: Partial<RemoteAvailabilitySnapshotDto> = {}): RemoteAvailabilitySnapshotDto => ({
  instance: "i1",
  revision: 1,
  availability: [],
  ...over,
});

type Harness = {
  readonly owner: SourceOwner;
  readonly fetches: () => number;
  readonly availabilityCalls: () => number;
  readonly retries: string[];
  readonly cancelled: () => boolean;
  readonly retryAborted: () => boolean;
};

/** `header` answers at once (a normal read); `body` answers the headers but leaves the body open
 * until the request is retired, which is the headers/body race; `chunks` answers in two pieces;
 * `hang` sends one piece and then waits to be retired. */
const harness = (config: {
  readonly snapshots?: RemoteAvailabilitySnapshotDto[];
  readonly origin?: "header" | "body" | "silent" | "chunks" | "hang";
  /** The local retry route hangs until its request is aborted (disposal). */
  readonly retryHang?: boolean;
} = {}): Harness => {
  const queue = [...(config.snapshots ?? [])];
  let fetchCount = 0;
  let availabilityCount = 0;
  let cancelled = false;
  let retryAborted = false;
  const retries: string[] = [];
  const fetchImpl: FetchLike = async (_input, init) => {
    fetchCount += 1;
    if (config.origin === "chunks") {
      // Two chunks, then done: the gate must hand out both and release its record once.
      const encoder = new TextEncoder();
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(stream) {
          pulls += 1;
          if (pulls === 1) stream.enqueue(encoder.encode("{"));
          else if (pulls === 2) stream.enqueue(encoder.encode("}"));
          else stream.close();
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }
    if (config.origin === "hang") {
      // One chunk, then silence: only retirement unsticks the pending read, and the underlying
      // stream must be cancelled rather than left to deliver more of the old target.
      return new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new TextEncoder().encode("{"));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (config.origin === "body") {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const signal = init?.signal;
          signal?.addEventListener(
            "abort",
            () => controller.error(signal.reason ?? new DOMException("aborted", "AbortError")),
            { once: true },
          );
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }
    if (config.origin === "silent") {
      // A body that ignores the signal and never sends a byte: the retirement race is what must
      // unstick the read.
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const owner = makeSourceOwner({
    local: {
      availability: async () => {
        availabilityCount += 1;
        return queue.shift() ?? snapshot();
      },
      retry: async (source: string, options?: { readonly signal?: AbortSignal }) => {
        retries.push(source);
        if (config.retryHang === true) {
          return new Promise<RemoteAvailabilitySnapshotDto>((_resolve, reject) => {
            const signal = options?.signal;
            const onAbort = (): void => {
              retryAborted = true;
              reject(signal?.reason ?? new Error("aborted"));
            };
            if (signal?.aborted === true) onAbort();
            else signal?.addEventListener("abort", onAbort, { once: true });
          });
        }
        return queue.shift() ?? snapshot();
      },
    },
    baseUrlOf: (sourceId) => (sourceId === "" ? "" : `/remote/${sourceId}`),
    fetch: fetchImpl,
  });
  return {
    owner,
    fetches: () => fetchCount,
    availabilityCalls: () => availabilityCount,
    retries,
    cancelled: () => cancelled,
    retryAborted: () => retryAborted,
  };
};

const refusal = (promise: Promise<unknown>): Promise<ReturnType<typeof gateFailureOf>> =>
  promise.then(
    () => undefined,
    (error: unknown) => gateFailureOf(error),
  );

test("a checking remote is not sent, and the refusal is machine-readable", async () => {
  const h = harness();
  const failure = await refusal(h.owner.clientFor("r").terminals.list());
  expect(failure?.kind).toBe("checking");
  expect(h.fetches()).toBe(0);
});

test("an unavailable remote is not sent, and carries the server's fixed reason", async () => {
  const h = harness({ snapshots: [snapshot({ availability: [entry("r", unavailable)] })] });
  h.owner.refresh();
  await until(() => h.owner.availability().entries.r?.status._tag, "unavailable");
  const failure = await refusal(h.owner.clientFor("r").terminals.list());
  expect(failure).toEqual({
    kind: "unavailable",
    message: "the remote server could not be reached",
    reason: { _tag: "unreachable", message: "the remote server could not be reached" },
  });
  expect(h.fetches()).toBe(0);
});

test("an available remote is sent, and the local source is never gated", async () => {
  const h = harness({ snapshots: [snapshot({ availability: [entry("r")] })] });
  h.owner.refresh();
  await until(() => h.owner.availability().entries.r?.status._tag, "available");
  expect(h.owner.maySend("r")).toBe(true);
  expect(await h.owner.clientFor("r").terminals.list()).toEqual({});
  expect(h.fetches()).toBe(1);

  // Local sends without any snapshot at all.
  expect(h.owner.maySend("")).toBe(true);
  expect(await h.owner.clientFor("").terminals.list()).toEqual({});
  expect(h.fetches()).toBe(2);
});

test("an event for an unknown instance is not adopted; it re-establishes the snapshot", async () => {
  const h = harness({ snapshots: [snapshot({ instance: "i2", availability: [entry("r")] })] });
  h.owner.applyEvent(JSON.stringify(snapshot({ instance: "i1" })));
  expect(h.owner.availability().instance).toBeNull();
  expect(h.owner.availability().entries.r).toBeUndefined();
  await until(() => h.owner.availability().instance, "i2");
  expect(h.owner.availability().entries.r?.status._tag).toBe("available");
  expect(h.availabilityCalls()).toBeGreaterThanOrEqual(1);
});

test("an older same-instance event cannot roll back a newer revision", async () => {
  const h = harness({ snapshots: [snapshot()] });
  h.owner.refresh();
  await until(() => h.owner.availability().instance, "i1");
  h.owner.applyEvent(
    JSON.stringify(snapshot({ instance: "i1", revision: 5, availability: [entry("r", unavailable, "g1", 5)] })),
  );
  h.owner.applyEvent(
    JSON.stringify(snapshot({ instance: "i1", revision: 3, availability: [entry("r", available, "g1", 3)] })),
  );
  expect(h.owner.availability().entries.r?.status._tag).toBe("unavailable");
  expect(h.owner.availability().revision).toBe(5);
});

test("a generation change retires an in-flight read as stale and an in-flight write as uncertain", async () => {
  const h = harness({ snapshots: [snapshot({ availability: [entry("r", available, "g1")] })], origin: "body" });
  h.owner.refresh();
  await until(() => h.owner.availability().entries.r?.status._tag, "available");

  const read = h.owner.clientFor("r").terminals.list();
  expect(h.owner.inflightCount("r")).toBe(1);
  h.owner.applyEvent(
    JSON.stringify(snapshot({ instance: "i1", revision: 2, availability: [entry("r", available, "g2", 2)] })),
  );
  expect((await refusal(read))?.kind).toBe("stale-target");
  expect(h.owner.inflightCount("r")).toBe(0);

  const write = h.owner
    .clientFor("r")
    .terminals.windowAction(ChangeId.make("C"), { action: "select", index: 0 });
  h.owner.applyEvent(
    JSON.stringify(snapshot({ instance: "i1", revision: 3, availability: [entry("r", available, "g3", 3)] })),
  );
  expect((await refusal(write))?.kind).toBe("uncertain");
});

test("a target change between headers and body also retires the read", async () => {
  const h = harness({ snapshots: [snapshot({ availability: [entry("r", available, "g1")] })], origin: "body" });
  h.owner.refresh();
  await until(() => h.owner.availability().entries.r?.status._tag, "available");

  const read = h.owner.clientFor("r").terminals.list();
  // The response headers are already in hand; only the body is pending.
  h.owner.applyEvent(
    JSON.stringify(snapshot({ instance: "i1", revision: 2, availability: [entry("r", available, "g2", 2)] })),
  );
  expect((await refusal(read))?.kind).toBe("stale-target");
});

test("an event-stream reconnection retires in-flight work and re-establishes the epoch", async () => {
  const h = harness({ snapshots: [snapshot({ availability: [entry("r", available, "g1")] })], origin: "body" });
  h.owner.refresh();
  await until(() => h.owner.availability().entries.r?.status._tag, "available");
  const read = h.owner.clientFor("r").terminals.list();
  expect(h.owner.inflightCount("r")).toBe(1);

  h.owner.applyEvent("");
  expect((await refusal(read))?.kind).toBe("cancelled");
  await until(() => h.availabilityCalls(), 2);
});

test("a non-cooperative silent body is unstuck by retirement, and a disposed owner refuses", async () => {
  const h = harness({ snapshots: [snapshot({ availability: [entry("r")] })], origin: "silent" });
  h.owner.refresh();
  await until(() => h.owner.availability().entries.r?.status._tag, "available");
  const read = h.owner.clientFor("r").terminals.list();
  // No byte will ever arrive; the retarget must unstick the pending read.
  h.owner.applyEvent(
    JSON.stringify(snapshot({ instance: "i1", revision: 2, availability: [entry("r", available, "g2", 2)] })),
  );
  expect((await refusal(read))?.kind).toBe("stale-target");

  const disposed = harness();
  disposed.owner.dispose();
  // A disposed owner refuses local calls too.
  expect((await refusal(disposed.owner.clientFor("").terminals.list()))?.kind).toBe("cancelled");
});

test("disposal aborts the owner's work and two owners do not share state", async () => {
  const a = harness({ snapshots: [snapshot({ availability: [entry("r", available, "g1")] })], origin: "body" });
  const b = harness({ snapshots: [snapshot({ availability: [entry("r", available, "g1")] })] });
  a.owner.refresh();
  b.owner.refresh();
  await until(() => a.owner.availability().entries.r?.status._tag, "available");
  await until(() => b.owner.availability().entries.r?.status._tag, "available");

  const read = a.owner.clientFor("r").terminals.list();
  a.owner.dispose();
  expect((await refusal(read))?.kind).toBe("cancelled");
  // B is untouched: its own state, its own in-flight bookkeeping.
  expect(b.owner.availability().entries.r?.status._tag).toBe("available");
  expect(b.owner.inflightCount("r")).toBe(0);

  const before = a.availabilityCalls();
  a.owner.refresh();
  await Bun.sleep(20);
  expect(a.availabilityCalls()).toBe(before);
});

test("a multi-chunk body completes once, and retiring mid-body cancels the rest", async () => {
  // Two chunks then done: the record is released, the request is not retired, and the body is
  // not cancelled — a normal read leaves nothing attached.
  const done = harness({ snapshots: [snapshot({ availability: [entry("r")] })], origin: "chunks" });
  done.owner.refresh();
  await until(() => done.owner.availability().entries.r?.status._tag, "available");
  expect(await done.owner.clientFor("r").terminals.list()).toEqual({});
  await until(() => done.owner.inflightCount("r"), 0);
  expect(done.cancelled()).toBe(false);

  // One chunk then silence: the retirement unsticks the read and cancels the underlying stream,
  // so no later chunk can be handed to a read that belongs to the old target.
  const hang = harness({ snapshots: [snapshot({ availability: [entry("r")] })], origin: "hang" });
  hang.owner.refresh();
  await until(() => hang.owner.availability().entries.r?.status._tag, "available");
  const read = refusal(hang.owner.clientFor("r").terminals.list());
  await until(() => hang.owner.inflightCount("r"), 1);
  hang.owner.applyEvent(""); // the event stream reconnected: retire in-flight reads
  expect((await read)?.kind).toBe("cancelled");
  await until(() => hang.cancelled(), true);
  await until(() => hang.owner.inflightCount("r"), 0);
});

test("a retry in flight is aborted by disposal, and its failure never escapes", async () => {
  const h = harness({ retryHang: true });
  const pending = h.owner.retry("r");
  await until(() => h.retries.length, 1);
  h.owner.dispose();
  // The aborted retry resolves, not rejects: a disposal must not surface a failed request.
  await pending;
  await until(() => h.retryAborted(), true);
  expect(h.owner.availability().instance).toBeNull();
});

test("a capability acquired before a retarget is spent: old sends never reach the new target", async () => {
  const h = harness({ snapshots: [snapshot({ availability: [entry("r", available, "g1", 1)] })] });
  h.owner.refresh();
  await until(() => h.owner.availability().entries.r?.generation, "g1");
  const oldClient = h.owner.clientFor("r");
  const oldWire = h.owner.wireFor("r");
  const before = h.fetches();

  // The same source id now names another target, available immediately.
  h.owner.applyEvent(
    JSON.stringify(snapshot({ instance: "i1", revision: 2, availability: [entry("r", available, "g2", 2)] })),
  );
  await until(() => h.owner.availability().entries.r?.generation, "g2");

  // The old capability belongs to g1: a read, a write and a wire request are all refused as
  // stale, and none of them leaves the browser as a request.
  expect((await refusal(oldClient.terminals.list()))?.kind).toBe("stale-target");
  expect(
    (await refusal(oldClient.terminals.windowAction(ChangeId.make("C1"), { action: "select", index: 0 })))?.kind,
  ).toBe("stale-target");
  expect((await refusal(oldWire.request("PUT", "/ext/notes/x", Schema.Struct({}))))?.kind).toBe("stale-target");
  expect(h.fetches()).toBe(before);

  // A capability acquired now is bound to g2 and does reach the target.
  expect(await h.owner.clientFor("r").terminals.list()).toEqual({});
  expect(h.fetches()).toBe(before + 1);
});

test("a capability outlives a same-generation outage and sends again on recovery", async () => {
  const h = harness({ snapshots: [snapshot({ availability: [entry("r", available, "g1", 1)] })] });
  h.owner.refresh();
  await until(() => h.owner.availability().entries.r?.status._tag, "available");
  const client = h.owner.clientFor("r");
  const before = h.fetches();
  // Same target, reachability lost: the capability is not spent, only held back.
  h.owner.applyEvent(
    JSON.stringify(snapshot({ instance: "i1", revision: 2, availability: [entry("r", unavailable, "g1", 2)] })),
  );
  await until(() => h.owner.availability().entries.r?.status._tag, "unavailable");
  expect((await refusal(client.terminals.list()))?.kind).toBe("unavailable");
  expect(h.fetches()).toBe(before);
  // Recovery: the same capability sends, because the target did not change.
  h.owner.applyEvent(
    JSON.stringify(snapshot({ instance: "i1", revision: 3, availability: [entry("r", available, "g1", 3)] })),
  );
  await until(() => h.owner.availability().entries.r?.status._tag, "available");
  expect(await client.terminals.list()).toEqual({});
  expect(h.fetches()).toBe(before + 1);
});
