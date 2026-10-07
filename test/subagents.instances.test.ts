/** The subagent instance composition: create, message flow, the delivery cursor, and the waiter
 * registry. The default launcher is a fake — the only part that touches the terminal substrate —
 * so most of these run without a host or a harness; one test opens a real host session to pin
 * discovery, presentation and close. */
import { beforeAll, afterAll, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";

import {
  closeSubagent,
  createSubagent,
  listSubagents,
  nextForSubagent,
  openSubagent,
  recordTurn,
  resultOfSubagent,
  sendToSubagent,
  awaitReady,
  subagentLaunch,
  type SubagentLauncher,
} from "../apps/server/src/subagents/server/instances.ts";
import { closeHostClient, hostClient } from "../apps/server/src/terminals/server/host.ts";
import { liveSubagents, newSubagentWindow } from "../apps/server/src/terminals/server/index.ts";
import { setStatus } from "../apps/server/src/terminals/server/status.ts";
import { listWindowsAsync, newWindowAsync } from "../apps/server/src/terminals/server/windows.ts";
import { createInstance, readInstance, instanceDir, appendMessageAndPatch, writeRecord } from "@corvi/agents/node";
import { pendingInbound, type SubagentRecord } from "@corvi/agents/instance";
import { BadRequestError } from "@corvi/contracts/errors";
import { waiterCount } from "../apps/server/src/subagents/server/waiters.ts";
import { AWAIT_INSTRUCTIONS } from "../apps/server/src/subagents/server/prompt.ts";
import { changeDir } from "../apps/server/src/change/server/index.ts";
import type { Change } from "@corvi/changes/record";
import { testTempDir, waitFor } from "./helpers.ts";

/** A launcher that returns a fake window id, so create/open work without a host or a harness. The
 * caller persists the id and the `opened` entry under the lock. */
const fakeLauncher: SubagentLauncher = () => Effect.succeed("@fake");

/** A launcher that opens a real host session running `sleep` in the subagent's directory, with
 * the metadata and env the server's own subagent launcher sets. */
const hostLauncher: SubagentLauncher = (change, record: SubagentRecord) =>
  newSubagentWindow(change.id, {
    changeDir: changeDir(change),
    cwd: instanceDir(changeDir(change), record.id),
    subagentId: record.id,
    label: record.label,
    command: ["sh", "-c", "sleep 30"],
  }).pipe(Effect.mapError((failure) => new BadRequestError({ message: failure.message })));

// The env this file mutates, saved so a co-located test file does not inherit it (bun runs the
// files of a run in one process).
const savedHostRuntime = process.env.CORVI_HOST_RUNTIME;
const restoreEnv = (): void => {
  if (savedHostRuntime === undefined) delete process.env.CORVI_HOST_RUNTIME;
  else process.env.CORVI_HOST_RUNTIME = savedHostRuntime;
};

let tmp: string;
let change: Change;

beforeAll(async () => {
  // The host owns the pty outside Bun; the tests point the server's host client at Node.
  process.env.CORVI_HOST_RUNTIME = "node";
  tmp = await testTempDir("subagents-instances");
  change = {
    id: "PROJ-sub",
    branch: "PROJ-sub",
    checkouts: [],
    state: "Implementation",
    createdAt: "2026-01-01T00:00:00.000Z",
  } as Change;
  await mkdir(changeDir(change), { recursive: true });
});

afterAll(async () => {
  // The host is the test file's only one; shutting it down kills every subagent session it owns
  // and leaves no process behind.
  await closeHostClient();
  restoreEnv();
  await rm(tmp, { recursive: true, force: true });
});

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(effect as Effect.Effect<A>);

/** A fresh instance with the built-in reviewer profile and one orchestrator message. */
const fresh = async (): Promise<string> => {
  const created = await run(createSubagent(change, { profile: "builtin:reviewer", prompt: "Review it" }, fakeLauncher));
  return created.id;
};

/** Mark an instance's inbound messages through `through` as delivered without claiming a turn:
 * the durable state a settled run leaves behind, so a reply can be attributed to a turn the relay
 * handed over without an open `inFlight` or a live window. */
const deliveredThrough = async (own: Change, id: string, through: number): Promise<void> => {
  const record = (await run(readInstance(changeDir(own), id)))!;
  const next: SubagentRecord & { readonly messages?: unknown } = { ...record, deliveredThrough: through };
  await run(writeRecord(changeDir(own), next));
};

/** Close a host-backed subagent and wait for its session to disappear. */
const closeAndWait = async (own: Change, id: string): Promise<void> => {
  await run(closeSubagent(own, id));
  await waitFor(
    "the subagent's host session to die",
    async () => !(await Effect.runPromise(liveSubagents(own.id))).has(id),
    15_000,
  );
};

test("create writes the record and the initial message, closed by a fake launcher", async () => {
  const created = await run(
    createSubagent(change, { profile: "builtin:reviewer", prompt: "Review it" }, fakeLauncher),
  );
  expect(created.profile).toBe("builtin:reviewer");
  expect(created.label).toBe("Reviewer");
  expect(created.presence).toBe("detached"); // no live window with the private socket
  expect(created.messages.map((message) => message.role)).toEqual(["orchestrator"]);
  // The first message is the built-in reviewer body with the task filled into `{prompt}`.
  expect(created.messages[0]?.body).toContain("Review the change `PROJ-sub` — PROJ-sub.");
  expect(created.messages[0]?.body).toContain("Look for correctness bugs, missing tests");
  expect(created.messages[0]?.body).toContain("Review it");
  expect(created.log.map((event) => event.kind)).toEqual(["created", "opened"]);
});

test("create refuses an unknown profile", async () => {
  await expect(run(createSubagent(change, { profile: "global:nope" }, fakeLauncher))).rejects.toThrow(
    /no such profile/,
  );
});

test("create with no task still sends exactly one first message with the await instruction", async () => {
  const created = await run(createSubagent(change, { profile: "builtin:reviewer" }, fakeLauncher));
  expect(created.messages).toHaveLength(1);
  expect(created.messages[0]?.role).toBe("orchestrator");
  expect(created.messages[0]?.body).toContain(AWAIT_INSTRUCTIONS);
  expect(created.messages[0]?.body).not.toContain("{prompt}");
});

test("next hands over the inbound message once, then reports the open turn as interrupted", async () => {
  const id = await fresh();
  const first = await run(nextForSubagent(change, id));
  expect(first.status).toBe("message");
  expect(first.message?.number).toBe(1);
  expect(first.message?.body).toContain("Review the change `PROJ-sub`");
  expect(first.message?.body).toContain("Review it");
  // The cursor and the in-flight marker advanced together: a restarted extension is not handed
  // the same message again.
  const second = await run(nextForSubagent(change, id));
  expect(second.status).toBe("interrupted");
});

test("a new send sets an interrupted turn aside so next delivers the new message", async () => {
  const id = await fresh();
  await run(nextForSubagent(change, id)); // consume #1, leaves inFlight=1
  const sent = await run(sendToSubagent(change, id, "Actually, focus on tests", "orchestrator"));
  expect(sent.number).toBe(2);
  const next = await run(nextForSubagent(change, id));
  expect(next.status).toBe("message");
  expect(next.message?.number).toBe(2);
});

test("a settled turn is appended, clears the open turn, and becomes the result", async () => {
  const id = await fresh();
  await run(nextForSubagent(change, id));
  const reply = await run(recordTurn(change, id, { text: "Looks good" }));
  expect(reply.role).toBe("subagent");
  expect(reply.number).toBe(2);
  const result = await run(resultOfSubagent(change, id));
  expect(result?.body).toBe("Looks good");
  // The turn settled: no longer in flight, so `next` has nothing to hand over.
  const savedPollMs = process.env.CORVI_SUBAGENT_POLL_MS;
  process.env.CORVI_SUBAGENT_POLL_MS = "40";
  try {
    const next = await run(nextForSubagent(change, id));
    expect(next.status).toBe("none");
  } finally {
    if (savedPollMs === undefined) delete process.env.CORVI_SUBAGENT_POLL_MS;
    else process.env.CORVI_SUBAGENT_POLL_MS = savedPollMs;
  }
});

test("await wakes on a relayed reply and reports it parked", async () => {
  const own = await isolatedChange();
  const created = await run(createSubagent(own, { profile: "builtin:reviewer", prompt: "Review it" }, hostLauncher));
  try {
    // The live turn is working, so the await is not ready until its reply lands; the relayed
    // reply names turn 1 and is what wakes the await.
    await run(nextForSubagent(own, created.id));
    const [awaited] = await Effect.runPromise(
      Effect.all(
        [
          awaitReady(own, { ids: [created.id], mode: "any" }),
          Effect.andThen(Effect.sleep("30 millis"), recordTurn(own, created.id, { text: "Here is my answer", inReplyTo: 1 })),
        ],
        { concurrency: "unbounded" },
      ),
    );
    expect(awaited.status).toBe("ready");
    expect(awaited.outcomes).toEqual([
      { id: created.id, status: "ready", reason: "replied", turn: 1, reply: 2 },
    ]);
  } finally {
    await closeAndWait(own, created.id);
  }
}, 30_000);

test("await reports an in-flight turn with no live window as interrupted", async () => {
  const id = await fresh();
  await run(nextForSubagent(change, id)); // claims #1, leaves inFlight with no live window
  const awaited = await run(awaitReady(change, { ids: [id], mode: "any" }));
  expect(awaited.status).toBe("interrupted");
  expect(awaited.outcomes).toEqual([{ id, status: "interrupted", turn: 1 }]);
});

test("await on a closed subagent resolves lost rather than blocking", async () => {
  const id = await fresh();
  const [awaited] = await Effect.runPromise(
    Effect.all(
      [awaitReady(change, { ids: [id], mode: "any" }), Effect.andThen(Effect.sleep("30 millis"), closeSubagent(change, id))],
      { concurrency: "unbounded" },
    ),
  );
  expect(awaited.status).toBe("lost");
  expect(awaited.outcomes).toEqual([{ id, status: "lost", turn: 1 }]);
});

test("await answers lost from the state when the window closed before the call", async () => {
  const savedPollMs = process.env.CORVI_SUBAGENT_POLL_MS;
  process.env.CORVI_SUBAGENT_POLL_MS = "60";
  try {
    const id = await fresh();
    // The close lands before the await subscribes, so no event can wake it: the state read — a
    // cleared window with the prompt still undelivered — is what answers, never the horizon.
    await run(closeSubagent(change, id));
    const awaited = await run(awaitReady(change, { ids: [id], mode: "any" }));
    expect(awaited.status).toBe("lost");
    expect(awaited.outcomes).toEqual([{ id, status: "lost", turn: 1 }]);
  } finally {
    if (savedPollMs === undefined) delete process.env.CORVI_SUBAGENT_POLL_MS;
    else process.env.CORVI_SUBAGENT_POLL_MS = savedPollMs;
  }
});

test("await --all reports a lost subagent even though another becomes ready", async () => {
  const own = await isolatedChange();
  const a = await run(createSubagent(own, { profile: "builtin:reviewer", prompt: "a" }, fakeLauncher));
  const b = await run(createSubagent(own, { profile: "builtin:reviewer", prompt: "b" }, fakeLauncher));
  await run(closeSubagent(own, a.id));
  await deliveredThrough(own, b.id, 1);
  const [awaited] = await Effect.runPromise(
    Effect.all(
      [
        awaitReady(own, { ids: [a.id, b.id], mode: "all" }),
        Effect.andThen(Effect.sleep("30 millis"), recordTurn(own, b.id, { text: "b", inReplyTo: 1 })),
      ],
      { concurrency: "unbounded" },
    ),
  );
  expect(awaited.status).toBe("lost");
  expect(awaited.outcomes.map((outcome) => outcome.id)).toEqual([a.id, b.id]);
  expect(awaited.outcomes.find((outcome) => outcome.id === a.id)?.status).toBe("lost");
  expect(awaited.outcomes.find((outcome) => outcome.id === b.id)).toMatchObject({
    status: "ready",
    reason: "idle",
    turn: 1,
  });
});

test("a parked reply is held back while a newer message of yours is queued", async () => {
  const savedPollMs = process.env.CORVI_SUBAGENT_POLL_MS;
  try {
    const id = await fresh();
    // Turn 1 is settled by an attributed reply; the queued message is a newer turn, so the parked
    // reply is not the current completion and the await is held to the horizon.
    await deliveredThrough(change, id, 1);
    await run(recordTurn(change, id, { text: "the answer", inReplyTo: 1 }));
    await run(sendToSubagent(change, id, "More work", "orchestrator"));
    const record = (await run(readInstance(changeDir(change), id)))!;
    expect(pendingInbound(record)).toBeDefined();
    process.env.CORVI_SUBAGENT_POLL_MS = "60";
    const awaited = await run(awaitReady(change, { ids: [id], mode: "any" }));
    expect(awaited.status).toBe("timeout");
    expect(awaited.outcomes).toEqual([]);
  } finally {
    if (savedPollMs === undefined) delete process.env.CORVI_SUBAGENT_POLL_MS;
    else process.env.CORVI_SUBAGENT_POLL_MS = savedPollMs;
  }
});

test("recordTurn persists the inbound number a reply answers", async () => {
  const id = await fresh();
  await run(nextForSubagent(change, id)); // claim #1
  const reply = await run(recordTurn(change, id, { text: "the answer", inReplyTo: 1 }));
  expect(reply.inReplyTo).toBe(1);
  const record = (await run(readInstance(changeDir(change), id)))!;
  expect(record.messages.find((message) => message.number === reply.number)?.inReplyTo).toBe(1);
});

test("a reply for a superseded turn does not clear a newer claim", async () => {
  const id = await fresh();
  await run(nextForSubagent(change, id)); // claim #1
  await run(sendToSubagent(change, id, "More work", "orchestrator")); // inbound #2
  await run(nextForSubagent(change, id)); // claim #2
  // A late reply for turn 1 arrives while turn 2 is in flight: it appends, but the claim stays
  // and the log records the mismatch.
  await run(recordTurn(change, id, { text: "the late turn-1 answer", inReplyTo: 1 }));
  const record = (await run(readInstance(changeDir(change), id)))!;
  expect(record.inFlight).toBe(2);
  expect(record.log.at(-1)?.kind).toBe("turn_settled");
  expect(record.log.at(-1)?.note).toContain("does not settle the turn in flight (2)");
  // With no live window the open claim reads as interrupted, never ready.
  const awaited = await run(awaitReady(change, { ids: [id], mode: "any" }));
  expect(awaited.status).toBe("interrupted");
  expect(awaited.outcomes).toEqual([{ id, status: "interrupted", turn: 2 }]);
});

test("await holds back while a message is still undelivered, and answers timeout", async () => {
  const savedPollMs = process.env.CORVI_SUBAGENT_POLL_MS;
  process.env.CORVI_SUBAGENT_POLL_MS = "60";
  try {
    const id = await fresh();
    // The prompt was appended but the relay has not picked it up: not "idle with nothing
    // pending", so the answer is the horizon — never a false ready on the pre-claim gap.
    const awaited = await run(awaitReady(change, { ids: [id], mode: "any" }));
    expect(awaited.status).toBe("timeout");
    expect(awaited.outcomes).toEqual([]);
  } finally {
    if (savedPollMs === undefined) delete process.env.CORVI_SUBAGENT_POLL_MS;
    else process.env.CORVI_SUBAGENT_POLL_MS = savedPollMs;
  }
  // The parked requests were cleaned up when they timed out.
  expect(waiterCount()).toBe(0);
});

test("list answers every instance with its conversation", async () => {
  const instances = await run(listSubagents(change));
  expect(instances.length).toBeGreaterThan(0);
  expect(instances.every((instance) => Array.isArray(instance.messages))).toBe(true);
});

test("two concurrent next calls claim the pending message once", async () => {
  const id = await fresh();
  const [a, b] = await Effect.runPromise(
    Effect.all([nextForSubagent(change, id), nextForSubagent(change, id)], { concurrency: "unbounded" }),
  );
  expect([a.status, b.status].sort()).toEqual(["interrupted", "message"]);
});

test("a send and a turn with the same idempotency key append once", async () => {
  const id = await fresh();
  const sent = await run(sendToSubagent(change, id, "one", "orchestrator", "k1"));
  const sentAgain = await run(sendToSubagent(change, id, "one", "orchestrator", "k1"));
  expect(sentAgain.number).toBe(sent.number);
  const reply = await run(recordTurn(change, id, { text: "r", key: "k2" }));
  const replyAgain = await run(recordTurn(change, id, { text: "r", key: "k2" }));
  expect(replyAgain.number).toBe(reply.number);
  const record = await run(readInstance(changeDir(change), id));
  expect(record?.messages.map((message) => message.number)).toEqual([1, sent.number, reply.number]);
});

test("a create with the same idempotency key returns the same instance", async () => {
  const a = await run(
    createSubagent(change, { profile: "builtin:reviewer", prompt: "x" }, fakeLauncher, "create-key-1"),
  );
  const b = await run(
    createSubagent(change, { profile: "builtin:reviewer", prompt: "x" }, fakeLauncher, "create-key-1"),
  );
  expect(b.id).toBe(a.id);
});

/** A change of its own, so `--any`/`--all` do not see every other test's instances. */
const isolatedChange = async (): Promise<Change> => {
  const isolated = {
    ...change,
    id: `PROJ-${Math.random().toString(36).slice(2, 8)}`,
  } as Change;
  await mkdir(changeDir(isolated), { recursive: true });
  return isolated;
};

test("await returns immediately when a reply is already parked", async () => {
  const id = await fresh();
  await deliveredThrough(change, id, 1);
  await run(recordTurn(change, id, { text: "answer", inReplyTo: 1 }));
  const awaited = await run(awaitReady(change, { ids: [id], mode: "any" }));
  expect(awaited.status).toBe("ready");
  expect(awaited.outcomes).toEqual([{ id, status: "ready", reason: "replied", turn: 1, reply: 2 }]);
});

test("await returns immediately when a subagent is already idle", async () => {
  const own = await isolatedChange();
  // A message-less instance: nothing of the orchestrator's is pending, so it can be processed at
  // once — the state contract, not a turn that has not happened yet. Create always sends a first
  // message, so the record is written directly.
  const id = `idle-${Math.random().toString(36).slice(2, 8)}`;
  const record: SubagentRecord = {
    id,
    changeId: own.id,
    profile: "builtin:reviewer",
    label: "Reviewer",
    harness: "pi",
    createdBy: "orchestrator",
    createdAt: new Date().toISOString(),
    log: [],
  };
  await run(createInstance(changeDir(own), record));
  const awaited = await run(awaitReady(own, { ids: [id], mode: "any" }));
  expect(awaited.status).toBe("ready");
  expect(awaited.outcomes).toEqual([{ id, status: "ready", reason: "idle" }]);
});

test("await --any resolves on whichever subagent becomes ready first", async () => {
  const own = await isolatedChange();
  const a = await run(createSubagent(own, { profile: "builtin:reviewer", prompt: "a" }, hostLauncher));
  const b = await run(createSubagent(own, { profile: "builtin:reviewer", prompt: "b" }, hostLauncher));
  try {
    await run(nextForSubagent(own, a.id));
    await run(nextForSubagent(own, b.id));
    const [awaited] = await Effect.runPromise(
      Effect.all(
        [
          awaitReady(own, { ids: [a.id, b.id], mode: "any" }),
          Effect.andThen(Effect.sleep("30 millis"), recordTurn(own, b.id, { text: "from b", inReplyTo: 1 })),
        ],
        { concurrency: "unbounded" },
      ),
    );
    expect(awaited.status).toBe("ready");
    expect(awaited.outcomes).toHaveLength(1);
    expect(awaited.outcomes[0]).toMatchObject({ id: b.id, status: "ready", reason: "replied", turn: 1, reply: 2 });
    expect(a.id).not.toBe(b.id);
  } finally {
    await closeAndWait(own, a.id);
    await closeAndWait(own, b.id);
  }
}, 30_000);

test("await --all waits for every subagent to be ready", async () => {
  const own = await isolatedChange();
  const a = await run(createSubagent(own, { profile: "builtin:reviewer", prompt: "a" }, hostLauncher));
  const b = await run(createSubagent(own, { profile: "builtin:reviewer", prompt: "b" }, hostLauncher));
  try {
    await run(nextForSubagent(own, a.id));
    await run(nextForSubagent(own, b.id));
    const [awaited] = await Effect.runPromise(
      Effect.all(
        [
          awaitReady(own, { ids: [a.id, b.id], mode: "all" }),
          Effect.andThen(Effect.sleep("20 millis"), recordTurn(own, a.id, { text: "a", inReplyTo: 1 })),
          Effect.andThen(Effect.sleep("40 millis"), recordTurn(own, b.id, { text: "b", inReplyTo: 1 })),
        ],
        { concurrency: "unbounded" },
      ),
    );
    expect(awaited.status).toBe("ready");
    expect(awaited.outcomes.map((outcome) => outcome.id)).toEqual([a.id, b.id]);
    expect(awaited.outcomes.every((outcome) => outcome.status === "ready")).toBe(true);
  } finally {
    await closeAndWait(own, a.id);
    await closeAndWait(own, b.id);
  }
}, 30_000);

test("await --turn returns an earlier reply while a newer turn is in flight", async () => {
  const own = await isolatedChange();
  const created = await run(createSubagent(own, { profile: "builtin:reviewer", prompt: "Review it" }, hostLauncher));
  try {
    await run(nextForSubagent(own, created.id)); // claim #1
    await run(recordTurn(own, created.id, { text: "first answer", inReplyTo: 1 })); // reply #2
    await run(sendToSubagent(own, created.id, "More detail", "orchestrator")); // inbound #3
    await run(nextForSubagent(own, created.id)); // claim #3, live window attached
    const awaited = await run(awaitReady(own, { ids: [created.id], mode: "any", turn: 1 }));
    expect(awaited.status).toBe("ready");
    expect(awaited.outcomes).toEqual([
      { id: created.id, status: "ready", reason: "replied", turn: 1, reply: 2 },
    ]);
  } finally {
    await closeAndWait(own, created.id);
  }
}, 30_000);

test("await --turn waits for an unsettled turn and wakes on its reply", async () => {
  const own = await isolatedChange();
  const created = await run(createSubagent(own, { profile: "builtin:reviewer", prompt: "Review it" }, hostLauncher));
  const savedPollMs = process.env.CORVI_SUBAGENT_POLL_MS;
  try {
    await run(nextForSubagent(own, created.id)); // claim #1
    await run(recordTurn(own, created.id, { text: "first answer", inReplyTo: 1 })); // reply #2
    await run(sendToSubagent(own, created.id, "More detail", "orchestrator")); // inbound #3
    await run(nextForSubagent(own, created.id)); // claim #3, live window attached
    process.env.CORVI_SUBAGENT_POLL_MS = "60";
    // Turn 3 has not settled: the explicit target waits to the horizon, then wakes on its reply.
    const held = await run(awaitReady(own, { ids: [created.id], mode: "any", turn: 3 }));
    expect(held.status).toBe("timeout");
    expect(held.outcomes).toEqual([]);
    const [awaited] = await Effect.runPromise(
      Effect.all(
        [
          awaitReady(own, { ids: [created.id], mode: "any", turn: 3 }),
          Effect.andThen(Effect.sleep("30 millis"), recordTurn(own, created.id, { text: "second answer", inReplyTo: 3 })),
        ],
        { concurrency: "unbounded" },
      ),
    );
    expect(awaited.status).toBe("ready");
    expect(awaited.outcomes).toEqual([
      { id: created.id, status: "ready", reason: "replied", turn: 3, reply: 4 },
    ]);
  } finally {
    if (savedPollMs === undefined) delete process.env.CORVI_SUBAGENT_POLL_MS;
    else process.env.CORVI_SUBAGENT_POLL_MS = savedPollMs;
    await closeAndWait(own, created.id);
  }
}, 30_000);

test("await --turn refuses several targets or an unknown inbound", async () => {
  const own = await isolatedChange();
  const id = await fresh();
  // The explicit turn names one subagent: none (or `--all`) and several ids are bad requests.
  await expect(run(awaitReady(own, { ids: [], mode: "all", turn: 1 }))).rejects.toThrow(
    /turn awaits one named subagent/,
  );
  await expect(run(awaitReady(own, { ids: ["a", "b"], mode: "any", turn: 1 }))).rejects.toThrow(
    /turn awaits one named subagent/,
  );
  // One id but `all` is still `--all`, not a single named target.
  await expect(run(awaitReady(own, { ids: ["a"], mode: "all", turn: 1 }))).rejects.toThrow(
    /turn awaits one named subagent/,
  );
  // An inbound turn that does not exist would otherwise park to the horizon for nothing.
  await expect(run(awaitReady(change, { ids: [id], mode: "any", turn: 99 }))).rejects.toThrow(
    /no inbound message 99/,
  );
});

test("await --turn keeps waiting for an earlier turn while the default answers the latest", async () => {
  const savedPollMs = process.env.CORVI_SUBAGENT_POLL_MS;
  try {
    const id = await fresh(); // #1 orchestrator
    await run(sendToSubagent(change, id, "More work", "orchestrator")); // #2 orchestrator
    await deliveredThrough(change, id, 2); // the relay handed over both turns
    await run(recordTurn(change, id, { text: "the answer", inReplyTo: 2 })); // #3 reply
    process.env.CORVI_SUBAGENT_POLL_MS = "60";
    // Turn 1 was never answered, so the explicit target keeps waiting.
    const held = await run(awaitReady(change, { ids: [id], mode: "any", turn: 1 }));
    expect(held.status).toBe("timeout");
    expect(held.outcomes).toEqual([]);
    // The default target is the latest inbound turn, 2, whose reply is parked.
    const latest = await run(awaitReady(change, { ids: [id], mode: "any" }));
    expect(latest.outcomes).toEqual([
      { id, status: "ready", reason: "replied", turn: 2, reply: 3 },
    ]);
  } finally {
    if (savedPollMs === undefined) delete process.env.CORVI_SUBAGENT_POLL_MS;
    else process.env.CORVI_SUBAGENT_POLL_MS = savedPollMs;
  }
});

test("await --turn returns a parked earlier reply even while a newer claim is detached", async () => {
  const id = await fresh(); // #1 orchestrator
  await run(nextForSubagent(change, id)); // claim #1
  await run(recordTurn(change, id, { text: "first answer", inReplyTo: 1 })); // reply #2
  await run(sendToSubagent(change, id, "More work", "orchestrator")); // inbound #3
  await run(nextForSubagent(change, id)); // claim #3, no live window
  const record = (await run(readInstance(changeDir(change), id)))!;
  expect(record.inFlight).toBe(3);
  // A reply on disk is a fact: it wins over the detached claim on the newer turn.
  const awaited = await run(awaitReady(change, { ids: [id], mode: "any", turn: 1 }));
  expect(awaited.status).toBe("ready");
  expect(awaited.outcomes).toEqual([
    { id, status: "ready", reason: "replied", turn: 1, reply: 2 },
  ]);
});

test("an interrupted wait names the in-flight turn, never a newer pending message", async () => {
  const id = await fresh(); // #1 orchestrator
  await run(nextForSubagent(change, id)); // claim #1
  await run(recordTurn(change, id, { text: "first answer", inReplyTo: 1 })); // reply #2
  await run(sendToSubagent(change, id, "More work", "orchestrator")); // inbound #3
  await run(nextForSubagent(change, id)); // claim #3
  // A newer inbound (#4) is queued while the claim on #3 stands. `send` itself clears the claim
  // (D8 is deferred), so append it through the store patch that keeps the in-flight marker: the
  // queue-behind state whose label must report turn 3, not 4.
  await run(
    appendMessageAndPatch(
      changeDir(change),
      id,
      { role: "orchestrator", body: "Even more", at: new Date().toISOString() },
      (record) => ({ ...record }),
    ),
  );
  const record = (await run(readInstance(changeDir(change), id)))!;
  expect(record.inFlight).toBe(3);
  expect(record.messages.at(-1)?.number).toBe(4);
  const awaited = await run(awaitReady(change, { ids: [id], mode: "any" }));
  expect(awaited.status).toBe("interrupted");
  expect(awaited.outcomes).toEqual([{ id, status: "interrupted", turn: 3 }]);
});

test("a reply cannot credit a turn the relay never delivered", async () => {
  const savedPollMs = process.env.CORVI_SUBAGENT_POLL_MS;
  try {
    const id = await fresh(); // #1 orchestrator
    await run(sendToSubagent(change, id, "More work", "orchestrator")); // inbound #2
    await deliveredThrough(change, id, 1); // but the relay delivered only turn 1
    await run(recordTurn(change, id, { text: "stray", inReplyTo: 2 })); // reply #3 names turn 2
    // The gated reply is invisible to both reads.
    expect(await run(resultOfSubagent(change, id, 2))).toBeNull();
    process.env.CORVI_SUBAGENT_POLL_MS = "60";
    const awaited = await run(awaitReady(change, { ids: [id], mode: "any", turn: 2 }));
    expect(awaited.status).toBe("timeout");
    expect(awaited.outcomes).toEqual([]);
  } finally {
    if (savedPollMs === undefined) delete process.env.CORVI_SUBAGENT_POLL_MS;
    else process.env.CORVI_SUBAGENT_POLL_MS = savedPollMs;
  }
});

test("await --all returns one outcome per target with lost over interrupted over ready", async () => {
  const own = await isolatedChange();
  const a = await run(createSubagent(own, { profile: "builtin:reviewer", prompt: "a" }, fakeLauncher));
  const b = await run(createSubagent(own, { profile: "builtin:reviewer", prompt: "b" }, fakeLauncher));
  const c = await run(createSubagent(own, { profile: "builtin:reviewer", prompt: "c" }, fakeLauncher));
  await run(closeSubagent(own, a.id));
  await run(nextForSubagent(own, b.id)); // claimed with no live window: interrupted
  await deliveredThrough(own, c.id, 1);
  await run(recordTurn(own, c.id, { text: "c", inReplyTo: 1 })); // settled: ready

  const awaited = await run(awaitReady(own, { ids: [a.id, b.id, c.id], mode: "all" }));
  expect(awaited.status).toBe("lost");
  expect(awaited.outcomes.map((outcome) => outcome.id)).toEqual([a.id, b.id, c.id]);
  expect(awaited.outcomes.map((outcome) => outcome.status)).toEqual(["lost", "interrupted", "ready"]);

  // Without the lost target, interrupted outranks ready.
  const withoutLost = await run(awaitReady(own, { ids: [b.id, c.id], mode: "all" }));
  expect(withoutLost.status).toBe("interrupted");
  expect(withoutLost.outcomes.map((outcome) => outcome.status)).toEqual(["interrupted", "ready"]);
});

test("await --all discards a settled sibling when the horizon expires", async () => {
  const savedPollMs = process.env.CORVI_SUBAGENT_POLL_MS;
  try {
    const own = await isolatedChange();
    const settled = await run(createSubagent(own, { profile: "builtin:reviewer", prompt: "a" }, fakeLauncher));
    const waiting = await run(createSubagent(own, { profile: "builtin:reviewer", prompt: "b" }, fakeLauncher));
    await deliveredThrough(own, settled.id, 1);
    await run(recordTurn(own, settled.id, { text: "a", inReplyTo: 1 })); // ready
    process.env.CORVI_SUBAGENT_POLL_MS = "60";
    // One target is ready, the other still holds: `--all` times out and discards the settled one.
    const awaited = await run(awaitReady(own, { ids: [settled.id, waiting.id], mode: "all" }));
    expect(awaited.status).toBe("timeout");
    expect(awaited.outcomes).toEqual([]);
    // Re-issuing for the settled target re-derives its answer at once.
    const reissued = await run(awaitReady(own, { ids: [settled.id], mode: "any" }));
    expect(reissued.outcomes).toEqual([
      { id: settled.id, status: "ready", reason: "replied", turn: 1, reply: 2 },
    ]);
  } finally {
    if (savedPollMs === undefined) delete process.env.CORVI_SUBAGENT_POLL_MS;
    else process.env.CORVI_SUBAGENT_POLL_MS = savedPollMs;
  }
});

test("await --all parks every target concurrently", async () => {
  const savedPollMs = process.env.CORVI_SUBAGENT_POLL_MS;
  try {
    const own = await isolatedChange();
    const a = await run(createSubagent(own, { profile: "builtin:reviewer", prompt: "a" }, fakeLauncher));
    const b = await run(createSubagent(own, { profile: "builtin:reviewer", prompt: "b" }, fakeLauncher));
    // A horizon with room to sample: both targets are far from settled, so both must park.
    process.env.CORVI_SUBAGENT_POLL_MS = "2000";
    const awaited = Effect.runPromise(awaitReady(own, { ids: [a.id, b.id], mode: "all" }));
    // Reading the waiter registry while they wait shows two registrations: `all` started every
    // target rather than running them in sequence (which would have only the first parked).
    await waitFor("both targets to park", async () => waiterCount() === 2, 1_000);
    const settled = await awaited;
    expect(settled.status).toBe("timeout");
    expect(settled.outcomes).toEqual([]);
    // The interrupt path closed every registration.
    expect(waiterCount()).toBe(0);
  } finally {
    if (savedPollMs === undefined) delete process.env.CORVI_SUBAGENT_POLL_MS;
    else process.env.CORVI_SUBAGENT_POLL_MS = savedPollMs;
  }
});

test("result names the reply for an explicit turn, or null when none has landed", async () => {
  const id = await fresh(); // #1 orchestrator
  await run(sendToSubagent(change, id, "More work", "orchestrator")); // inbound #2
  await deliveredThrough(change, id, 2); // turn 2 was handed over
  const reply = await run(recordTurn(change, id, { text: "the answer", inReplyTo: 2 })); // reply #3
  expect((await run(resultOfSubagent(change, id, 2)))?.number).toBe(reply.number);
  // A known inbound turn with no reply yet is null; a turn that is no inbound message is refused.
  expect(await run(resultOfSubagent(change, id, 1))).toBeNull();
  await expect(run(resultOfSubagent(change, id, 9))).rejects.toThrow(/no inbound message 9/);
});

test("await and result are read-only: repeated calls leave the record unchanged", async () => {
  const id = await fresh();
  await run(nextForSubagent(change, id)); // claim #1
  await run(recordTurn(change, id, { text: "the answer", inReplyTo: 1 }));
  const before = (await run(readInstance(changeDir(change), id)))!;

  const firstAwait = await run(awaitReady(change, { ids: [id], mode: "any" }));
  const secondAwait = await run(awaitReady(change, { ids: [id], mode: "any" }));
  expect(secondAwait).toEqual(firstAwait);
  expect((await run(resultOfSubagent(change, id, 1)))?.number).toBe(
    (await run(resultOfSubagent(change, id)))?.number,
  );

  // Reading never acknowledges or consumes: the whole record is exactly as it was.
  const after = (await run(readInstance(changeDir(change), id)))!;
  expect(after).toEqual(before);
});

test("closing and reopening a subagent resumes the same pinned harness session", async () => {
  const own = await isolatedChange();
  const created = await run(createSubagent(own, { profile: "builtin:reviewer", prompt: "Review it" }, hostLauncher));

  // The launch contract: the harness pinned to the subagent id, in the subagent's own directory.
  const record = (await run(readInstance(changeDir(own), created.id)))!;
  const launch = subagentLaunch(changeDir(own), record);
  expect(launch.cwd).toBe(instanceDir(changeDir(own), created.id));
  expect(launch.command[0]).toBe("pi");
  expect(launch.command[launch.command.indexOf("--session-id") + 1]).toBe(created.id);
  // The other harness pins with `--session`, and the cwd is the same subagent directory.
  const opencode = subagentLaunch(changeDir(own), { ...record, harness: "opencode" });
  expect(opencode.cwd).toBe(launch.cwd);
  expect(opencode.command[opencode.command.indexOf("--session") + 1]).toBe(created.id);

  // Close it: the host session dies and discovery forgets it.
  await run(closeSubagent(own, created.id));
  await waitFor(
    "the subagent's host session to die",
    async () => !(await Effect.runPromise(liveSubagents(own.id))).has(created.id),
    15_000,
  );

  // Reopen: the same id, the same launch, and a live session in the subagent's directory.
  const reopened = await run(openSubagent(own, created.id, hostLauncher));
  expect(reopened.id).toBe(created.id);
  expect(reopened.presence).toBe("attached");
  const reread = (await run(readInstance(changeDir(own), created.id)))!;
  expect(subagentLaunch(changeDir(own), reread)).toEqual(launch);
  const entry = (await Effect.runPromise(liveSubagents(own.id))).get(created.id);
  const session = (await (await hostClient()).list()).find((candidate) => candidate.id === entry?.window);
  expect(session?.cwd).toBe(instanceDir(changeDir(own), created.id));
  expect(session?.metadata?.subagentId).toBe(created.id);
}, 30_000);

test("explicit open selects the subagent's window; create leaves the current one alone", async () => {
  const own = await isolatedChange();
  // An interactive shell the user is looking at before any subagent exists.
  const shell = await newWindowAsync(own.id, changeDir(own));
  const created = await run(createSubagent(own, { profile: "builtin:reviewer", prompt: "Review it" }, hostLauncher));
  expect(created.presence).toBe("attached");
  // Creation is background work: it must not steal the active terminal from the shell.
  expect((await listWindowsAsync(own.id)).find((window) => window.active)?.id).toBe(shell.id);

  await run(closeSubagent(own, created.id));
  // Explicit open is the user asking for this terminal: it becomes the active one.
  const reopened = await run(openSubagent(own, created.id, hostLauncher));
  expect(reopened.presence).toBe("attached");
  const live = await Effect.runPromise(liveSubagents(own.id));
  const reopenedWindow = live.get(created.id)?.window;
  expect(reopenedWindow).toBeDefined();
  expect((await listWindowsAsync(own.id)).find((window) => window.active)?.id).toBe(reopenedWindow);
}, 60_000);

test("a subagent on a host session is discovered, presented, relays, and closes", async () => {
  const own = await isolatedChange();
  const created = await run(createSubagent(own, { profile: "builtin:reviewer", prompt: "Review it" }, hostLauncher));
  expect(created.presence).toBe("attached");

  // Discovery is the host session's metadata, keyed by subagent id.
  const live = await Effect.runPromise(liveSubagents(own.id));
  const entry = live.get(created.id);
  expect(entry).toBeDefined();
  const session = (await (await hostClient()).list()).find((candidate) => candidate.id === entry?.window);
  expect(session?.alive).toBe(true);
  expect(session?.metadata?.subagentId).toBe(created.id);
  expect(session?.metadata?.change).toBe(own.id);

  // The reporter's status (the CLI/HTTP store) reaches the window presenter: the session name
  // as the label, the last message as the note. The host session's `subagentId` names the glyph:
  // a reporting subagent is still a subagent, not a plain agent.
  setStatus(entry!.window, session!.incarnation, {
    state: "waiting",
    name: "pi",
    sessionName: "Review session",
    message: "Please review",
    at: new Date().toISOString(),
  });
  const shown = (await listWindowsAsync(own.id)).find((window) => window.id === entry!.window);
  expect(shown?.icon).toBe("subagent");
  expect(shown?.label).toBe("Review session");
  expect(shown?.note).toBe("Please review");
  // A subagent waits for its orchestrator (the Subagents page), not the user, so its waiting
  // turn never raises an attention edge and never notifies.
  expect(shown?.attention).toBe(false);

  // The relay: the first message is handed over once, an inbound send wakes the next, and the
  // settled reply is a turn.
  const relayed = await run(nextForSubagent(own, created.id));
  expect(relayed.message?.body).toContain("Review the change");
  expect(relayed.message?.body).toContain("Review it");
  const sent = await run(sendToSubagent(own, created.id, "More detail", "orchestrator"));
  expect(sent.number).toBe(2);
  const next = await run(nextForSubagent(own, created.id));
  expect(next.status).toBe("message");
  expect(next.message?.body).toBe("More detail");
  await run(recordTurn(own, created.id, { text: "Done" }));
  const awaited = await run(awaitReady(own, { ids: [created.id], mode: "any" }));
  expect(awaited.status).toBe("ready");
  expect(awaited.outcomes).toEqual([
    { id: created.id, status: "ready", reason: "replied", turn: 2, reply: 3 },
  ]);

  // Close kills the host session and drops it from discovery.
  await run(closeSubagent(own, created.id));
  await waitFor(
    "the subagent's host session to die",
    async () => !(await Effect.runPromise(liveSubagents(own.id))).has(created.id),
    15_000,
  );
}, 30_000);

test("an attributed reply for turn 1 does not settle the claimed turn 3", async () => {
  const own = await isolatedChange();
  const created = await run(createSubagent(own, { profile: "builtin:reviewer", prompt: "Review it" }, hostLauncher));
  const savedPollMs = process.env.CORVI_SUBAGENT_POLL_MS;
  try {
    await run(nextForSubagent(own, created.id)); // claim #1
    await run(recordTurn(own, created.id, { text: "first answer", inReplyTo: 1 })); // reply #2
    await run(sendToSubagent(own, created.id, "More detail", "orchestrator")); // inbound #3
    await run(nextForSubagent(own, created.id)); // claim #3, live window attached
    process.env.CORVI_SUBAGENT_POLL_MS = "60";
    // Turn 1's reply is older than the claimed turn 3: the await holds to the horizon.
    const held = await run(awaitReady(own, { ids: [created.id], mode: "any" }));
    expect(held.status).toBe("timeout");
    expect(held.outcomes).toEqual([]);
    // Turn 3's own reply is what settles it, and the waiter wakes on that reply.
    const [awaited] = await Effect.runPromise(
      Effect.all(
        [
          awaitReady(own, { ids: [created.id], mode: "any" }),
          Effect.andThen(Effect.sleep("30 millis"), recordTurn(own, created.id, { text: "second answer", inReplyTo: 3 })),
        ],
        { concurrency: "unbounded" },
      ),
    );
    expect(awaited.status).toBe("ready");
    expect(awaited.outcomes).toEqual([
      { id: created.id, status: "ready", reason: "replied", turn: 3, reply: 4 },
    ]);
  } finally {
    if (savedPollMs === undefined) delete process.env.CORVI_SUBAGENT_POLL_MS;
    else process.env.CORVI_SUBAGENT_POLL_MS = savedPollMs;
    await run(closeSubagent(own, created.id));
    await waitFor(
      "the subagent's host session to die",
      async () => !(await Effect.runPromise(liveSubagents(own.id))).has(created.id),
      15_000,
    );
  }
}, 30_000);

test("await times out, never ready, while a claimed turn's reporter is still waiting", async () => {
  const own = await isolatedChange();
  const created = await run(createSubagent(own, { profile: "builtin:reviewer", prompt: "Review it" }, hostLauncher));
  const savedPollMs = process.env.CORVI_SUBAGENT_POLL_MS;
  try {
    expect(created.presence).toBe("attached");
    process.env.CORVI_SUBAGENT_POLL_MS = "60";
    // The relay claims the message, leaving `inFlight`, before the reporter has caught up.
    await run(nextForSubagent(own, created.id));
    const entry = (await Effect.runPromise(liveSubagents(own.id))).get(created.id);
    expect(entry).toBeDefined();
    const session = (await (await hostClient()).list()).find((candidate) => candidate.id === entry?.window);
    expect(session).toBeDefined();
    // The reporter's status is pinned to `waiting` while the claimed turn is still running.
    setStatus(entry!.window, session!.incarnation, {
      state: "waiting",
      name: "pi",
      at: new Date().toISOString(),
    });
    // The claimed turn holds the await to the horizon: a stale `waiting` must never read ready
    // while the turn is still running.
    const awaited = await run(awaitReady(own, { ids: [created.id], mode: "any" }));
    expect(awaited.status).toBe("timeout");
    expect(awaited.outcomes).toEqual([]);
    // The parked request was cleaned up when it timed out.
    expect(waiterCount()).toBe(0);
  } finally {
    if (savedPollMs === undefined) delete process.env.CORVI_SUBAGENT_POLL_MS;
    else process.env.CORVI_SUBAGENT_POLL_MS = savedPollMs;
    // A regression (a false ready) must not leave the `sleep 30` host session behind.
    await run(closeSubagent(own, created.id));
    await waitFor(
      "the subagent's host session to die",
      async () => !(await Effect.runPromise(liveSubagents(own.id))).has(created.id),
      15_000,
    );
  }
}, 30_000);
