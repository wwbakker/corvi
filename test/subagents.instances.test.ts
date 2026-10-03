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
  awaitReady,
  type SubagentLauncher,
} from "../apps/server/src/subagents/server/instances.ts";
import { readInstance } from "@corvi/agents/node";
import { waiterCount } from "../apps/server/src/subagents/server/waiters.ts";
import { changeDir } from "../apps/server/src/change/server/index.ts";
import type { Change } from "../apps/server/src/domain/change.ts";
import { testTempDir, tmuxTempDir } from "./helpers.ts";

/** A launcher that returns a fake window id, so create/open work without tmux or a harness. The
 * caller persists the id and the `opened` entry under the lock. */
const fakeLauncher: SubagentLauncher = () => Effect.succeed("@fake");

let tmp: string;
let change: Change;
let savedSocket: string | undefined;

beforeAll(async () => {
  tmp = await testTempDir("subagents-instances");
  // A private, non-existent tmux socket: the store's window reads answer empty instead of ever
  // touching the user's server. In `tmuxTempDir`'s short directory on purpose: a unix socket
  // path has ~100 characters, and `corvi-<token>-subagents-instances-XXXXXX/tmux.sock` under
  // macOS's own long `$TMPDIR` overshoots it — "File name too long" instead of the empty reads
  // most of these tests want (the helper's length check, test/helpers.ts).
  savedSocket = process.env.CORVI_TMUX_SOCKET;
  process.env.CORVI_TMUX_SOCKET = join(await tmuxTempDir(), "s.sock");
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

test("await wakes on a relayed reply and reports it parked", async () => {
  const id = await fresh();
  // The prompt is still undelivered, so nothing is ready; the relayed reply is what wakes the
  // await, reported as parked for `result`.
  const [awaited] = await Effect.runPromise(
    Effect.all(
      [awaitReady(change, { ids: [id], mode: "any" }), Effect.zipRight(Effect.sleep("30 millis"), recordTurn(change, id, "Here is my answer"))],
      { concurrency: "unbounded" },
    ),
  );
  expect(awaited.status).toBe("ready");
  expect(awaited.id).toBe(id);
  expect(awaited.awaitingReply).toBe(true);
});

test("await reports an in-flight turn with no live window as interrupted", async () => {
  const id = await fresh();
  await run(nextForSubagent(change, id)); // claims #1, leaves inFlight with no live window
  const awaited = await run(awaitReady(change, { ids: [id], mode: "any" }));
  expect(awaited.status).toBe("interrupted");
});

test("await on a closed subagent resolves lost rather than blocking", async () => {
  const id = await fresh();
  const [awaited] = await Effect.runPromise(
    Effect.all(
      [awaitReady(change, { ids: [id], mode: "any" }), Effect.zipRight(Effect.sleep("30 millis"), closeSubagent(change, id))],
      { concurrency: "unbounded" },
    ),
  );
  expect(awaited.status).toBe("lost");
});

test("await answers lost from the state when the window closed before the call", async () => {
  process.env.CORVI_SUBAGENT_POLL_MS = "60";
  try {
    const id = await fresh();
    // The close lands before the await subscribes, so no event can wake it: the state read — a
    // cleared window with the prompt still undelivered — is what answers, never the horizon.
    await run(closeSubagent(change, id));
    const awaited = await run(awaitReady(change, { ids: [id], mode: "any" }));
    expect(awaited.status).toBe("lost");
  } finally {
    delete process.env.CORVI_SUBAGENT_POLL_MS;
  }
});

test("await --all reports a lost subagent even though another becomes ready", async () => {
  const own = await isolatedChange();
  const a = await run(createSubagent(own, { profile: "builtin:reviewer", prompt: "a" }, fakeLauncher));
  const b = await run(createSubagent(own, { profile: "builtin:reviewer", prompt: "b" }, fakeLauncher));
  await run(closeSubagent(own, a.id));
  const [awaited] = await Effect.runPromise(
    Effect.all(
      [
        awaitReady(own, { ids: [a.id, b.id], mode: "all" }),
        Effect.zipRight(Effect.sleep("30 millis"), recordTurn(own, b.id, "b")),
      ],
      { concurrency: "unbounded" },
    ),
  );
  expect(awaited.status).toBe("lost");
  expect(awaited.id).toBe(a.id);
});

test("await holds back while a message is still undelivered, and answers timeout", async () => {
  process.env.CORVI_SUBAGENT_POLL_MS = "60";
  try {
    const id = await fresh();
    // The prompt was appended but the relay has not picked it up: not "idle with nothing
    // pending", so the answer is the horizon — never a false ready on the pre-claim gap.
    const awaited = await run(awaitReady(change, { ids: [id], mode: "any" }));
    expect(awaited.status).toBe("timeout");
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
  const reply = await run(recordTurn(change, id, "r", "k2"));
  const replyAgain = await run(recordTurn(change, id, "r", "k2"));
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
  await run(recordTurn(change, id, "answer"));
  const awaited = await run(awaitReady(change, { ids: [id], mode: "any" }));
  expect(awaited.status).toBe("ready");
  expect(awaited.id).toBe(id);
  expect(awaited.awaitingReply).toBe(true);
});

test("await returns immediately when a subagent is already idle", async () => {
  const own = await isolatedChange();
  // No prompt and no turn: nothing of the orchestrator's is pending, so it can be processed at
  // once — the state contract, not a turn that has not happened yet.
  const id = (await run(createSubagent(own, { profile: "builtin:reviewer" }, fakeLauncher))).id;
  const awaited = await run(awaitReady(own, { ids: [id], mode: "any" }));
  expect(awaited.status).toBe("ready");
  expect(awaited.awaitingReply).toBe(false);
});

test("await --any resolves on whichever subagent becomes ready first", async () => {
  const own = await isolatedChange();
  const a = await run(createSubagent(own, { profile: "builtin:reviewer", prompt: "a" }, fakeLauncher));
  const b = await run(createSubagent(own, { profile: "builtin:reviewer", prompt: "b" }, fakeLauncher));
  const [awaited] = await Effect.runPromise(
    Effect.all(
      [
        awaitReady(own, { ids: [a.id, b.id], mode: "any" }),
        Effect.zipRight(Effect.sleep("30 millis"), recordTurn(own, b.id, "from b")),
      ],
      { concurrency: "unbounded" },
    ),
  );
  expect(awaited.status).toBe("ready");
  expect(awaited.id).toBe(b.id);
  expect(a.id).not.toBe(b.id);
});

test("await --all waits for every subagent to be ready", async () => {
  const own = await isolatedChange();
  const a = await run(createSubagent(own, { profile: "builtin:reviewer", prompt: "a" }, fakeLauncher));
  const b = await run(createSubagent(own, { profile: "builtin:reviewer", prompt: "b" }, fakeLauncher));
  const [awaited] = await Effect.runPromise(
    Effect.all(
      [
        awaitReady(own, { ids: [a.id, b.id], mode: "all" }),
        Effect.zipRight(Effect.sleep("20 millis"), recordTurn(own, a.id, "a")),
        Effect.zipRight(Effect.sleep("40 millis"), recordTurn(own, b.id, "b")),
      ],
      { concurrency: "unbounded" },
    ),
  );
  expect(awaited.status).toBe("ready");
});

test.skipIf(!Bun.which("tmux"))("a live window carrying @subagent_id reads as attached", async () => {
  const socket = process.env.CORVI_TMUX_SOCKET as string;
  const own = await isolatedChange();
  const id = (await run(createSubagent(own, { profile: "builtin:reviewer", prompt: "x" }, fakeLauncher))).id;
  const session = `corvi-${own.id}`;
  const tmux = (args: string[]): void => {
    const result = Bun.spawnSync(["tmux", "-S", socket, ...args]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  tmux(["new-session", "-d", "-s", session, "-c", changeDir(own)]);
  tmux(["set-option", "-p", "-t", session, "@subagent_id", id]);
  try {
    const listed = await run(listSubagents(own));
    expect(listed.find((instance) => instance.id === id)?.presence).toBe("attached");
  } finally {
    tmux(["kill-session", "-t", session]);
  }
});
