import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { Schema } from "effect";

import {
  RemoteAvailabilitySnapshotSchema,
  type RemoteAvailabilityDto,
  type RemoteAvailabilitySnapshotDto,
} from "@corvi/contracts/availability";
import { makeCorviClient } from "@corvi/client";
import { eventsRoutes } from "../apps/server/src/capabilities/bus.ts";
import { resetRuntime, setRuntime } from "../apps/server/src/capabilities/runtime.ts";
import { serve, type Serving } from "../apps/server/src/capabilities/serve.ts";
import type { RemoteFetch } from "../apps/server/src/remote-events/model.ts";
import { availabilityRoutes } from "../apps/server/src/remote-events/routes.ts";
import { makeRemoteEvents, type RemoteEvents } from "../apps/server/src/remote-events/server.ts";
import { configPath, reloadConfigSync } from "../apps/server/src/workspace/server/index.ts";
import { runEffect, until } from "./helpers.ts";

/**
 * The availability owner: a scripted transport drives the bounded checks, so state transitions,
 * retries, generations and privacy are asserted deterministically rather than raced against a
 * real socket. The route/client pair is exercised through a real local server.
 */

const INSTANCE = "test-instance";

const writeConfig = (workspaces: unknown[]): void => {
  writeFileSync(configPath(), JSON.stringify({ workspaces }));
  reloadConfigSync();
};

const remoteWorkspace = (id: string, url: string, token = "remote-token", workspace = id): unknown => ({
  id,
  name: id,
  remote: { url, workspace, token },
});

/** One connected stream the test drives by hand. */
type ScriptedRemote = {
  readonly response: Response;
  readonly push: (text: string) => void;
  readonly end: () => void;
  readonly fail: (error: Error) => void;
};

type Step =
  | { readonly kind: "stream" }
  | { readonly kind: "status"; readonly status: number; readonly contentType?: string }
  | { readonly kind: "hang" }
  /** The connect promise settles only when the test resolves it; the signal is ignored. */
  | { readonly kind: "deferred" };

type ScriptedTransport = {
  readonly transport: RemoteFetch;
  readonly remotes: ScriptedRemote[];
  readonly calls: () => number;
  /** How many times the owner aborted a transport call's signal. */
  readonly gaveUp: () => number;
  /** How many times the owner explicitly cancelled a reader (the stream's `cancel` path). */
  readonly cancelled: () => number;
  readonly resolveDeferred: (index: number) => void;
};

const scriptedRemote = (onCancel: () => void): ScriptedRemote => {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start: (next) => {
      controller = next;
    },
    cancel: () => onCancel(),
  });
  return {
    response: new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    push: (text) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
    fail: (error) => controller.error(error),
  };
};

/** A transport whose each call takes the next step.
 *
 * `cooperative` (the default) mirrors fetch: an aborted signal errors the body. With
 * `cooperative: false` the body ignores the signal, so only the owner's explicit `reader.cancel()`
 * can unblock a pending read. */
const scriptedTransport = (steps: () => Step, options: { cooperative?: boolean } = {}): ScriptedTransport => {
  const cooperative = options.cooperative ?? true;
  const remotes: ScriptedRemote[] = [];
  const deferredResolvers: (() => void)[] = [];
  let calls = 0;
  let gaveUp = 0;
  let cancelled = 0;
  const transport: RemoteFetch = (_url, init) => {
    calls += 1;
    const step = steps();
    if (step.kind === "status") {
      return Promise.resolve(
        new Response("no", {
          status: step.status,
          ...(step.contentType === undefined ? {} : { headers: { "content-type": step.contentType } }),
        }),
      );
    }
    const remote = scriptedRemote(() => {
      cancelled += 1;
    });
    remotes.push(remote);
    if (step.kind === "deferred") return new Promise((resolve) => deferredResolvers.push(() => resolve(remote.response)));
    init.signal.addEventListener(
      "abort",
      () => {
        gaveUp += 1;
        if (cooperative) remote.fail(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
    if (step.kind === "hang") {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }
    return Promise.resolve(remote.response);
  };
  return {
    transport,
    remotes,
    calls: () => calls,
    gaveUp: () => gaveUp,
    cancelled: () => cancelled,
    resolveDeferred: (index) => deferredResolvers[index]?.(),
  };
};

const always = (step: Step): (() => Step) => () => step;

/** The default bounds keep a stream that is not being beaten stable for the length of a test.
 * Tests that exercise the stall bound use `STALL`. */
const STABLE = { connectMs: 60, firstSignalMs: 60, stallMs: 5_000 };
const STALL = { connectMs: 60, firstSignalMs: 60, stallMs: 120 };
const deadlines = STABLE;

/** A poll step finer than the smallest bound a test is watching. */
const STEP = 20;

const statusOf = (snapshot: RemoteAvailabilitySnapshotDto, source = "remote-client"): string =>
  snapshot.availability.find((entry) => entry.source === source)?.status._tag ?? "missing";

const entryOf = (
  snapshot: RemoteAvailabilitySnapshotDto,
  source = "remote-client",
): RemoteAvailabilityDto | undefined => snapshot.availability.find((entry) => entry.source === source);

const owners: RemoteEvents[] = [];
const newOwner = (options: Parameters<typeof makeRemoteEvents>[0] = {}): RemoteEvents => {
  const owner = makeRemoteEvents({ instance: INSTANCE, deadlines, ...options });
  owners.push(owner);
  return owner;
};

let local: Serving;

beforeAll(async () => {
  local = await serve({ port: 0, routes: { ...eventsRoutes, ...availabilityRoutes } });
});

/** Read named frames from the local bus on one connection, pumped in the background. */
type BusReader = {
  readonly next: (name: string, timeoutMs?: number) => Promise<string | undefined>;
  readonly close: () => void;
};

const parseData = (frame: string): string =>
  frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");

const openBus = async (): Promise<BusReader> => {
  const controller = new AbortController();
  const response = await fetch(new URL("api/events", local.url), { signal: controller.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  let buffer = "";
  let closed = false;
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let at = buffer.indexOf("\n\n");
        while (at >= 0) {
          frames.push(buffer.slice(0, at));
          buffer = buffer.slice(at + 2);
          at = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // the reader was aborted by close()
    }
    closed = true;
  })();
  return {
    next: async (name, timeoutMs = 2000): Promise<string | undefined> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const index = frames.findIndex((frame) => frame.startsWith(`event: ${name}`));
        if (index >= 0) return parseData(frames.splice(index, 1)[0]!);
        if (closed || Date.now() > deadline) return undefined;
        await Bun.sleep(10);
      }
    },
    close: () => controller.abort(),
  };
};

afterEach(() => {
  for (const owner of owners) owner.stop();
  owners.length = 0;
  resetRuntime();
});

afterAll(() => {
  local?.stop();
});

test("an initial registration checks, then becomes available on the stream's first byte", async () => {
  const script = scriptedTransport(always({ kind: "stream" }));
  writeConfig([remoteWorkspace("remote-client", "http://remote.test")]);
  const owner = newOwner({ transport: script.transport });

  // Before reconcile there is nothing; after it the target is checking, not yet reachable.
  expect(owner.snapshot().availability).toEqual([]);
  await runEffect(owner.reconcile());
  expect(statusOf(owner.snapshot())).toBe("checking");
  expect(entryOf(owner.snapshot())?.generation).toBeTruthy();

  script.remotes[0]!.push(": heartbeat\n\n");
  expect(await until(async () => statusOf(owner.snapshot()), "available", 2000, STEP)).toBe("available");
  const entry = entryOf(owner.snapshot())!;
  expect(entry.status).toEqual({ _tag: "available" });
  expect(entry.revision).toBeGreaterThan(0);
});

test("heartbeat bytes keep a long-lived stream available past the stall bound", async () => {
  const script = scriptedTransport(always({ kind: "stream" }));
  writeConfig([remoteWorkspace("remote-client", "http://remote.test")]);
  const owner = newOwner({ transport: script.transport, deadlines: STALL });
  await runEffect(owner.reconcile());
  await until(async () => script.remotes.length >= 1, true, 2000, STEP);

  // Beats every 30ms for ~300ms: well past stallMs=120, with no reconnect and no stall.
  for (let beat = 0; beat < 10; beat++) {
    script.remotes[0]!.push(": ping\n\n");
    await Bun.sleep(30);
    expect(statusOf(owner.snapshot())).toBe("available");
  }
  expect(script.gaveUp()).toBe(0);
  expect(script.calls()).toBe(1);
});

test("a refused token is authentication; an explicit retry recovers without a new generation", async () => {
  const steps = [{ kind: "status", status: 401 } as Step, { kind: "stream" } as Step];
  const script = scriptedTransport(() => steps.shift() ?? { kind: "stream" });
  writeConfig([remoteWorkspace("remote-client", "http://remote.test")]);
  const owner = newOwner({ transport: script.transport });
  await runEffect(owner.reconcile());
  await until(async () => statusOf(owner.snapshot()), "unavailable", 2000);
  const refused = entryOf(owner.snapshot())!;
  expect(refused.status).toEqual({
    _tag: "unavailable",
    reason: { _tag: "authentication", message: "the remote refused this device token" },
  });

  // Retry rather than wait out the backoff: checking while it runs, then available.
  await runEffect(owner.retry("remote-client"));
  expect(statusOf(owner.snapshot())).toBe("checking");
  script.remotes[0]!.push(": open\n\n");
  await until(async () => statusOf(owner.snapshot()), "available", 2000);
  expect(entryOf(owner.snapshot())!.generation).toBe(refused.generation);
});

test("a silent open stream stalls and is cancelled, then a retry recovers", async () => {
  const script = scriptedTransport(always({ kind: "stream" }));
  writeConfig([remoteWorkspace("remote-client", "http://remote.test")]);
  const owner = newOwner({ transport: script.transport, deadlines: STALL });
  await runEffect(owner.reconcile());
  script.remotes[0]!.push(": open\n\n");
  expect(await until(async () => statusOf(owner.snapshot()), "available", 2000, STEP)).toBe("available");

  // Stop sending: the stall bound aborts this attempt and the owner says why.
  expect(await until(async () => statusOf(owner.snapshot()), "unavailable", 2000, STEP)).toBe("unavailable");
  expect(entryOf(owner.snapshot())!.status).toEqual({
    _tag: "unavailable",
    reason: { _tag: "stalled", message: "the remote stopped sending events" },
  });
  expect(script.gaveUp()).toBeGreaterThanOrEqual(1);

  await runEffect(owner.retry("remote-client"));
  await until(async () => script.remotes.length >= 2, true, 2000, STEP);
  script.remotes[1]!.push(": open\n\n");
  expect(await until(async () => statusOf(owner.snapshot()), "available", 2000, STEP)).toBe("available");
});

test("a stream that answers and then sends nothing is bounded with factual copy", async () => {
  const script = scriptedTransport(always({ kind: "stream" }));
  writeConfig([remoteWorkspace("remote-client", "http://remote.test")]);
  const owner = newOwner({ transport: script.transport, deadlines: { ...STABLE, firstSignalMs: 80 } });
  await runEffect(owner.reconcile());
  await until(async () => statusOf(owner.snapshot()), "unavailable", 2000, STEP);
  // Never sent a byte: "stopped" would be a lie; the copy says exactly what happened.
  expect(entryOf(owner.snapshot())!.status).toEqual({
    _tag: "unavailable",
    reason: { _tag: "stalled", message: "the remote sent nothing after answering" },
  });
  expect(script.gaveUp()).toBeGreaterThanOrEqual(1);
});

test("an abort cancels the owned reader even when the body ignores the signal", async () => {
  const script = scriptedTransport(always({ kind: "stream" }), { cooperative: false });
  writeConfig([remoteWorkspace("remote-client", "http://remote.test", "first-token", "first")]);
  const owner = newOwner({ transport: script.transport });
  await runEffect(owner.reconcile());
  await until(async () => script.remotes.length >= 1, true, 2000, STEP);

  // The body never errors on the signal, so only the owner's explicit reader.cancel() can end it.
  writeConfig([]);
  await runEffect(owner.reconcile());
  await until(async () => script.cancelled() >= 1, true, 2000, STEP);
  expect(script.cancelled()).toBeGreaterThanOrEqual(1);
  // The loop is gone: no further call and no further publish.
  const calls = script.calls();
  await Bun.sleep(60);
  expect(script.calls()).toBe(calls);
  expect(script.remotes.length).toBe(1);
});

test("a late result for a replaced target neither publishes nor announces", async () => {
  const bus = await openBus();
  const script = scriptedTransport(always({ kind: "deferred" }));
  writeConfig([remoteWorkspace("remote-client", "http://remote.test", "first-token", "first")]);
  const owner = newOwner({ transport: script.transport });
  try {
    await runEffect(owner.reconcile());
    await until(async () => script.remotes.length >= 1, true, 2000, STEP);
    const firstGeneration = entryOf(owner.snapshot())!.generation;

    // Retarget while the old transport is still pending, then let the old target answer.
    writeConfig([remoteWorkspace("remote-client", "http://remote.test", "second-token", "first")]);
    await runEffect(owner.reconcile());
    script.resolveDeferred(0);
    await Bun.sleep(60);

    const after = entryOf(owner.snapshot())!;
    expect(after.generation).not.toBe(firstGeneration);
    expect(after.status).toEqual({ _tag: "checking" });
    expect(after.revision).toBe(0);
    // The retired target's answer never reached the bus either.
    expect(await bus.next("source", 150)).toBeUndefined();
  } finally {
    bus.close();
  }
});

test("a connect that never answers is bounded and classified unreachable", async () => {
  const script = scriptedTransport(always({ kind: "hang" }));
  writeConfig([remoteWorkspace("remote-client", "http://remote.test")]);
  const owner = newOwner({ transport: script.transport });
  await runEffect(owner.reconcile());
  await until(async () => statusOf(owner.snapshot()), "unavailable", 2000);
  expect(entryOf(owner.snapshot())!.status).toEqual({
    _tag: "unavailable",
    reason: { _tag: "unreachable", message: "the remote did not answer within the health check bound" },
  });
  expect(script.gaveUp()).toBe(1);
});

test("a connect that answers just after its deadline is still classified as a timeout", async () => {
  const script = scriptedTransport(always({ kind: "deferred" }));
  writeConfig([remoteWorkspace("remote-client", "http://remote.test")]);
  const owner = newOwner({ transport: script.transport });
  await runEffect(owner.reconcile());
  await until(async () => script.remotes.length >= 1, true, 2000, STEP);
  // The deadline fires first; the non-cooperative connect then resolves anyway.
  await Bun.sleep(80);
  script.resolveDeferred(0);
  await until(async () => statusOf(owner.snapshot()), "unavailable", 2000, STEP);
  expect(entryOf(owner.snapshot())!.status).toEqual({
    _tag: "unavailable",
    reason: { _tag: "unreachable", message: "the remote did not answer within the health check bound" },
  });
});

test("other stream failures are classified as unreachable or configuration", async () => {
  const steps = [
    { kind: "status", status: 500 } as Step,
    { kind: "status", status: 200, contentType: "text/html" } as Step,
  ];
  const script = scriptedTransport(() => steps.shift() ?? { kind: "status", status: 500 });
  writeConfig([remoteWorkspace("remote-client", "http://remote.test")]);
  const owner = newOwner({ transport: script.transport });
  await runEffect(owner.reconcile());
  await until(async () => statusOf(owner.snapshot()), "unavailable", 2000);
  expect(entryOf(owner.snapshot())!.status).toEqual({
    _tag: "unavailable",
    reason: { _tag: "unreachable", message: "the remote event stream answered 500" },
  });
  await runEffect(owner.retry("remote-client"));
  await until(async () => {
    const status = entryOf(owner.snapshot())!.status;
    return status._tag === "unavailable" && status.reason._tag === "configuration";
  }, true, 2000);
});

test("an invalid url is a configuration failure without any fetch", async () => {
  const script = scriptedTransport(always({ kind: "stream" }));
  writeConfig([remoteWorkspace("remote-client", "ftp://remote.test")]);
  const owner = newOwner({ transport: script.transport });
  await runEffect(owner.reconcile());
  await until(async () => statusOf(owner.snapshot()), "unavailable", 2000);
  expect(entryOf(owner.snapshot())!.status).toEqual({
    _tag: "unavailable",
    reason: { _tag: "configuration", message: "the remote workspace's url is not http or https" },
  });
  expect(script.calls()).toBe(0);
});

test("a scheduled reconnect stays unavailable until it is proven healthy", async () => {
  const steps = [{ kind: "status", status: 401 } as Step, { kind: "hang" } as Step];
  const script = scriptedTransport(() => steps.shift() ?? { kind: "hang" });
  writeConfig([remoteWorkspace("remote-client", "http://remote.test")]);
  const owner = newOwner({ transport: script.transport });
  await runEffect(owner.reconcile());
  await until(async () => statusOf(owner.snapshot()), "unavailable", 2000, STEP);

  // The backoff retry starts a second attempt (the hang). While it is in flight the state must
  // still read unavailable: a scheduled recovery must not flicker back to checking.
  await until(async () => script.calls() >= 2, true, 3000, STEP);
  expect(statusOf(owner.snapshot())).toBe("unavailable");
});

test("stopping the owner ends a waiting loop without another check", async () => {
  const script = scriptedTransport(always({ kind: "status", status: 500 }));
  writeConfig([remoteWorkspace("remote-client", "http://remote.test")]);
  const owner = newOwner({ transport: script.transport });
  await runEffect(owner.reconcile());
  await until(async () => script.calls() >= 1, true, 2000, STEP);
  owner.stop();
  await Bun.sleep(1200);
  expect(script.calls()).toBe(1);
});

test("retries on a healthy stream are coalesced and never restart it", async () => {
  const script = scriptedTransport(always({ kind: "stream" }));
  writeConfig([remoteWorkspace("remote-client", "http://remote.test")]);
  const owner = newOwner({ transport: script.transport });
  await runEffect(owner.reconcile());
  script.remotes[0]!.push(": open\n\n");
  await until(async () => statusOf(owner.snapshot()), "available", 2000);
  const before = entryOf(owner.snapshot())!;

  for (let attempt = 0; attempt < 5; attempt++) await runEffect(owner.retry("remote-client"));
  expect(script.calls()).toBe(1);
  expect(script.gaveUp()).toBe(0);
  expect(entryOf(owner.snapshot())!.revision).toBe(before.revision);
});

test("repeated retries while a check is in flight share one more attempt, not a loop", async () => {
  const steps = [{ kind: "hang" } as Step, { kind: "hang" } as Step, { kind: "stream" } as Step];
  const script = scriptedTransport(() => steps.shift() ?? { kind: "hang" });
  writeConfig([remoteWorkspace("remote-client", "http://remote.test")]);
  const owner = newOwner({ transport: script.transport });
  await runEffect(owner.reconcile());
  await until(async () => statusOf(owner.snapshot()), "unavailable", 2000);

  // The first retry wakes the backoff; the rest arrive while that attempt is in flight and queue
  // one follow-up between them.
  await runEffect(owner.retry("remote-client"));
  await runEffect(owner.retry("remote-client"));
  await runEffect(owner.retry("remote-client"));
  await until(async () => script.calls() >= 2, true, 2000);
  await Bun.sleep(150);
  // One in-flight check plus at most one queued — never one loop per retry.
  expect(script.calls()).toBeLessThanOrEqual(3);
});

test("an observation on an unhealthy source asks for one recheck and classifies nothing itself", async () => {
  const script = scriptedTransport(always({ kind: "hang" }));
  writeConfig([remoteWorkspace("remote-client", "http://remote.test")]);
  const owner = newOwner({ transport: script.transport });
  await runEffect(owner.reconcile());
  await until(async () => statusOf(owner.snapshot()), "unavailable", 2000);
  const before = script.calls();

  owner.observe("remote-client", "unreachable");
  await until(async () => script.calls() > before, true, 2000, STEP);
  // The recheck itself decides the state; the observation did not.
  expect(statusOf(owner.snapshot())).toBe("unavailable");

  // An unknown source is a no-op, not a throw.
  owner.observe("not-a-remote", "unreachable");
});

test("an observation never disturbs a healthy stream", async () => {
  const script = scriptedTransport(always({ kind: "stream" }));
  writeConfig([remoteWorkspace("remote-client", "http://remote.test")]);
  const owner = newOwner({ transport: script.transport });
  await runEffect(owner.reconcile());
  script.remotes[0]!.push(": open\n\n");
  expect(await until(async () => statusOf(owner.snapshot()), "available", 2000, STEP)).toBe("available");
  const before = entryOf(owner.snapshot())!;

  owner.observe("remote-client", "authentication");
  await Bun.sleep(50);
  expect(script.calls()).toBe(1);
  expect(script.gaveUp()).toBe(0);
  expect(entryOf(owner.snapshot())!.revision).toBe(before.revision);
});

test("a same-id target change mints a new generation and abandons the old stream", async () => {
  const script = scriptedTransport(always({ kind: "stream" }));
  writeConfig([remoteWorkspace("remote-client", "http://remote.test", "first-token", "first-workspace")]);
  const owner = newOwner({ transport: script.transport });
  await runEffect(owner.reconcile());
  script.remotes[0]!.push(": open\n\n");
  await until(async () => statusOf(owner.snapshot()), "available", 2000);
  const first = entryOf(owner.snapshot())!;
  const firstGeneration = first.generation;

  // Same source id, same url, different remote workspace: the same-id identity the store must not
  // confuse. A fresh target is checking under a new generation.
  writeConfig([remoteWorkspace("remote-client", "http://remote.test", "first-token", "second-workspace")]);
  await runEffect(owner.reconcile());
  const second = entryOf(owner.snapshot())!;
  expect(second.status).toEqual({ _tag: "checking" });
  expect(second.generation).not.toBe(firstGeneration);
  expect(second.revision).toBe(0);
  expect(script.gaveUp()).toBeGreaterThanOrEqual(1);
});

test("a workspace that leaves the config disappears from the map", async () => {
  const script = scriptedTransport(always({ kind: "stream" }));
  writeConfig([remoteWorkspace("remote-client", "http://remote.test")]);
  const owner = newOwner({ transport: script.transport });
  await runEffect(owner.reconcile());
  expect(owner.snapshot().availability).toHaveLength(1);
  writeConfig([]);
  await runEffect(owner.reconcile());
  expect(owner.snapshot().availability).toEqual([]);
});

test("a fresh server instance resets the revision with a new opaque epoch", async () => {
  const first = scriptedTransport(always({ kind: "stream" }));
  const second = scriptedTransport(always({ kind: "stream" }));
  writeConfig([remoteWorkspace("remote-client", "http://remote.test")]);
  const one = newOwner({ instance: "instance-one", transport: first.transport });
  const two = newOwner({ instance: "instance-two", transport: second.transport });
  await runEffect(one.reconcile());
  await runEffect(two.reconcile());
  expect(one.snapshot().instance).toBe("instance-one");
  expect(two.snapshot().instance).toBe("instance-two");
  // Both instances started from zero, so a restart's revision is not comparable across epochs.
  expect(one.snapshot().revision).toBe(two.snapshot().revision);
});

test("the snapshot and its event never carry the device token", async () => {
  const script = scriptedTransport(always({ kind: "stream" }));
  writeConfig([remoteWorkspace("remote-client", "http://remote.test", "super-secret-token")]);
  const owner = newOwner({ transport: script.transport });
  await runEffect(owner.reconcile());
  script.remotes[0]!.push(": open\n\n");
  await until(async () => statusOf(owner.snapshot()), "available", 2000);
  expect(JSON.stringify(owner.snapshot())).not.toContain("super-secret-token");
});

test("the route and client decode the canonical snapshot and 404 an unknown source", async () => {
  const script = scriptedTransport(always({ kind: "stream" }));
  writeConfig([remoteWorkspace("remote-client", "http://remote.test")]);
  const owner = newOwner({ transport: script.transport });
  setRuntime({
    remoteAvailabilitySnapshot: owner.snapshot,
    remoteAvailabilityRetry: owner.retry,
  });
  await runEffect(owner.reconcile());
  script.remotes[0]!.push(": open\n\n");
  await until(async () => statusOf(owner.snapshot()), "available", 2000);

  const client = makeCorviClient({ baseUrl: local.url.toString() });
  const snapshot = await client.remotes.availability();
  expect(snapshot.instance).toBe(INSTANCE);
  expect(snapshot.availability[0]!.source).toBe("remote-client");

  const retried = await client.remotes.retry("remote-client");
  expect(retried.availability[0]!.generation).toBe(snapshot.availability[0]!.generation);

  await expect(client.remotes.retry("not-a-remote")).rejects.toThrow(/no such remote workspace/);
});

test("the availability snapshot is announced on the local event stream", async () => {
  const script = scriptedTransport(always({ kind: "stream" }));
  writeConfig([remoteWorkspace("remote-client", "http://remote.test", "stream-token")]);
  const owner = newOwner({ transport: script.transport });
  const bus = await openBus();
  try {
    expect(await bus.next("open")).toBeDefined();
    await runEffect(owner.reconcile());
    const data = await bus.next("availability");
    expect(data).toBeDefined();
    const snapshot = Schema.decodeUnknownSync(RemoteAvailabilitySnapshotSchema)(JSON.parse(data!));
    expect(snapshot.instance).toBe(INSTANCE);
    expect(snapshot.availability[0]!.source).toBe("remote-client");
    expect(data).not.toContain("stream-token");
  } finally {
    bus.close();
  }
});
