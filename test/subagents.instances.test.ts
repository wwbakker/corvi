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
import { listWindowsAsync } from "../apps/server/src/terminals/server/windows.ts";
import { createInstance, readInstance, instanceDir, pendingInbound } from "@corvi/agents/node";
import type { SubagentRecord } from "@corvi/agents/instance";
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

test("a parked reply answers even while a newer message of yours is queued", async () => {
  const id = await fresh();
  // The prompt is still undelivered when the reply parks — pending and parked at once. The
  // parked reply wins the ready answer (docs/manual/subagents.md states the precedence): it is
  // the orchestrator's to process, and the queued message is delivered when the subagent is
  // free again.
  await run(recordTurn(change, id, "the answer"));
  const record = (await run(readInstance(changeDir(change), id)))!;
  expect(pendingInbound(record)).toBeDefined();
  const awaited = await run(awaitReady(change, { ids: [id], mode: "any" }));
  expect(awaited.status).toBe("ready");
  expect(awaited.awaitingReply).toBe(true);
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

  // The reporter's status (the CLI/HTTP store) reaches the window presenter: agent icon, the
  // session name as the label, the last message as the note.
  setStatus(entry!.window, session!.incarnation, {
    state: "waiting",
    name: "pi",
    sessionName: "Review session",
    message: "Please review",
    at: new Date().toISOString(),
  });
  const shown = (await listWindowsAsync(own.id)).find((window) => window.id === entry!.window);
  expect(shown?.icon).toBe("agent");
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
  await run(recordTurn(own, created.id, "Done"));
  const awaited = await run(awaitReady(own, { ids: [created.id], mode: "any" }));
  expect(awaited.status).toBe("ready");
  expect(awaited.awaitingReply).toBe(true);

  // Close kills the host session and drops it from discovery.
  await run(closeSubagent(own, created.id));
  await waitFor(
    "the subagent's host session to die",
    async () => !(await Effect.runPromise(liveSubagents(own.id))).has(created.id),
    15_000,
  );
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
