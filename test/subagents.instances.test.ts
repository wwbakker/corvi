/** The subagent instance composition: create, message flow, the delivery cursor, and the waiter
 * registry. The window launcher is a fake — the only part that touches tmux — so these run
 * without a harness, while the store and the pure model are exercised for real. */
import { beforeAll, afterAll, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";

import {
  closeSubagent,
  createSubagent,
  listSubagents,
  nextForSubagent,
  recordTurn,
  resultOfSubagent,
  sendToSubagent,
  waitForTurn,
  type SubagentLauncher,
} from "../apps/server/src/subagents/server/instances.ts";
import { writeRecord } from "@corvi/agents/node";
import { waiterCount } from "../apps/server/src/subagents/server/waiters.ts";
import { changeDir } from "../apps/server/src/change/server/index.ts";
import type { Change } from "../apps/server/src/domain/change.ts";
import { testTempDir } from "./helpers.ts";

/** A launcher that records the open itself, so create/open work without tmux or a harness: the
 * default launcher's contract is that it persists the updated record. */
const fakeLauncher: SubagentLauncher = (change, record) =>
  Effect.gen(function* () {
    const updated = {
      ...record,
      log: [...record.log, { kind: "opened" as const, at: new Date().toISOString() }],
    };
    yield* writeRecord(changeDir(change), updated).pipe(Effect.catchAll(() => Effect.void));
    return updated;
  });

let tmp: string;
let change: Change;
let savedSocket: string | undefined;

beforeAll(async () => {
  tmp = await testTempDir("subagents-instances");
  // A private, non-existent tmux socket: the store's window reads answer empty instead of ever
  // touching the user's server.
  savedSocket = process.env.CORVI_TMUX_SOCKET;
  process.env.CORVI_TMUX_SOCKET = join(tmp, "tmux.sock");
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
  if (savedSocket === undefined) delete process.env.CORVI_TMUX_SOCKET;
  else process.env.CORVI_TMUX_SOCKET = savedSocket;
  await rm(tmp, { recursive: true, force: true });
});

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(effect as Effect.Effect<A>);

/** A fresh instance with the built-in reviewer profile and one orchestrator message. */
const fresh = async (): Promise<string> => {
  const created = await run(createSubagent(change, { profile: "builtin:reviewer", prompt: "Review it" }, fakeLauncher));
  return created.id;
};

test("create writes the record and the initial message, closed by a fake launcher", async () => {
  const created = await run(
    createSubagent(change, { profile: "builtin:reviewer", prompt: "Review it" }, fakeLauncher),
  );
  expect(created.profile).toBe("builtin:reviewer");
  expect(created.label).toBe("Reviewer");
  expect(created.presence).toBe("detached"); // no live window with the private socket
  expect(created.messages.map((message) => [message.role, message.body])).toEqual([
    ["orchestrator", "Review it"],
  ]);
  expect(created.log.map((event) => event.kind)).toEqual(["created", "opened"]);
});

test("create refuses an unknown profile", async () => {
  await expect(run(createSubagent(change, { profile: "global:nope" }, fakeLauncher))).rejects.toThrow(
    /no such profile/,
  );
});

test("next hands over the inbound message once, then reports the open turn as interrupted", async () => {
  const id = await fresh();
  const first = await run(nextForSubagent(change, id));
  expect(first.status).toBe("message");
  expect(first.message?.number).toBe(1);
  expect(first.message?.body).toBe("Review it");
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
  const reply = await run(recordTurn(change, id, "Looks good"));
  expect(reply.role).toBe("subagent");
  expect(reply.number).toBe(2);
  const result = await run(resultOfSubagent(change, id));
  expect(result?.body).toBe("Looks good");
  // The turn settled: no longer in flight, so `next` has nothing to hand over.
  process.env.CORVI_SUBAGENT_POLL_MS = "40";
  try {
    const next = await run(nextForSubagent(change, id));
    expect(next.status).toBe("none");
  } finally {
    delete process.env.CORVI_SUBAGENT_POLL_MS;
  }
});

test("wait wakes on a delivered turn", async () => {
  const id = await fresh();
  await run(nextForSubagent(change, id)); // in flight
  const [waited] = await Effect.runPromise(
    Effect.all(
      [waitForTurn(change, { id, mode: "one" }), Effect.zipRight(Effect.sleep("30 millis"), recordTurn(change, id, "Here is my answer"))],
      { concurrency: "unbounded" },
    ),
  );
  expect(waited.status).toBe("turn");
  expect(waited.id).toBe(id);
  expect(waited.message?.body).toBe("Here is my answer");
});

test("wait on a closed subagent resolves lost rather than blocking", async () => {
  const id = await fresh();
  const [waited] = await Effect.runPromise(
    Effect.all(
      [waitForTurn(change, { id, mode: "one" }), Effect.zipRight(Effect.sleep("30 millis"), closeSubagent(change, id))],
      { concurrency: "unbounded" },
    ),
  );
  expect(waited.status).toBe("lost");
});

test("wait answers timeout when nothing arrives", async () => {
  process.env.CORVI_SUBAGENT_POLL_MS = "60";
  try {
    const id = await fresh();
    const waited = await run(waitForTurn(change, { id, mode: "one" }));
    expect(waited.status).toBe("timeout");
  } finally {
    delete process.env.CORVI_SUBAGENT_POLL_MS;
  }
  // The parked requests were cleaned up when they timed out.
  expect(waiterCount()).toBe(0);
});

test("list answers every instance with its conversation", async () => {
  const instances = await run(listSubagents(change));
  expect(instances.length).toBeGreaterThan(0);
  expect(instances.every((instance) => Array.isArray(instance.messages))).toBe(true);
});
