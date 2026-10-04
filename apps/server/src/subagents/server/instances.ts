/**
 * Subagent instances: create, open, close, message, and await.
 *
 * Composes three things: the instance store (`@corvi/agents/node`, one directory per subagent),
 * the terminal (one host session per attached subagent, discovered by its session metadata), and
 * the waiter registry (`./waiters.ts`, the long poll's parking lot). The server is the single
 * writer of the `session.json` records and the message files; **every** read-modify-write of a
 * record goes through the store's per-subagent lock (`mutateRecord`/`appendMessageAndPatch`/
 * `claimInbound`), so two concurrent requests cannot interleave a cursor, an in-flight marker, or
 * a log.
 *
 * Presence is a live host session whose metadata carries `subagentId`, opened here and read back
 * with the host list. Activity is the reporter's status (the CLI/HTTP store, or the host's OSC
 * parse), except that a claimed turn reads as working even while the reporter's last status is a
 * stale `waiting`. The one stored fact is `inFlight`: whether a turn was in flight cannot be
 * derived after a reboot, so it is written when `next` hands a message over and cleared when the
 * reply settles.
 */
import { Effect, Semaphore } from "effect";

import { launchOf } from "@corvi/agents/harness";
import {
  viewOf,
  type SubagentMessage,
  type SubagentRecord,
  type SubagentWithMessages,
} from "@corvi/agents/instance";
import {
  appendMessageAndPatch,
  claimInbound,
  createInstance,
  findCreatedByKey,
  instanceDir,
  pendingInbound,
  readInstance,
  listInstances,
  mutateRecord,
  removeInstance,
  writeRecord,
  withCreateLock,
} from "@corvi/agents/node";
import type {
  SubagentCreateRequestDto,
  SubagentInstanceDto,
  SubagentNextResponseDto,
  SubagentAwaitResponseDto,
} from "@corvi/contracts/subagents";
import { BadRequestError, ConflictError, NotFoundError } from "@corvi/contracts/errors";
import { announce } from "../../capabilities/bus.ts";
import { changeDir, factsFor } from "../../change/server/index.ts";
import {
  killHostWindow,
  liveSubagents,
  newSubagentWindow,
  type LiveSubagent,
} from "../../terminals/server/index.ts";
import type { Change } from "@corvi/changes/record";
import { resolveProfileFor } from "./run.ts";
import { renderSubagentBody } from "./prompt.ts";
import { notify, subscribe } from "./waiters.ts";

/** How long an `await`/`next` parks before answering "nothing yet" — the check-in horizon for
 * `await`. The caller re-issues. Read per call, so a test can shorten it. */
const longPollMs = (): number => Number(process.env.CORVI_SUBAGENT_POLL_MS) || 300_000;

const now = (): string => new Date().toISOString();

/** One open per subagent at a time: two concurrent opens would otherwise both see "not live" and
 * launch two host sessions for one id. An in-process lock is enough, since the server is the only
 * writer of the instances. */
const openLocks = new Map<string, Semaphore.Semaphore>();
const openLock = (key: string): Semaphore.Semaphore => {
  let lock = openLocks.get(key);
  if (lock === undefined) {
    lock = Semaphore.makeUnsafe(1);
    openLocks.set(key, lock);
  }
  return lock;
};

type Live = LiveSubagent;

/** The live subagent host sessions of a change, keyed by subagent id. A host that is not running
 * is an empty map: presence is best-effort, never a request failure. */
const liveBySubagent = (changeId: string): Effect.Effect<Map<string, Live>> =>
  liveSubagents(changeId).pipe(Effect.catch(() => Effect.succeed(new Map<string, Live>())));

/** The `viewOf` input for a live entry (or its absence): one projection, so `toDto` and
 * `awaitReady` cannot disagree about presence or the reporter's status. */
const viewInputOf = (
  live: Live | undefined,
): { readonly attached: boolean; readonly agentStatus?: "working" | "waiting" } => ({
  attached: live !== undefined,
  agentStatus: live?.agentStatus,
});

const toDto = (record: SubagentWithMessages, live: Live | undefined): SubagentInstanceDto => {
  const view = viewOf(record, viewInputOf(live), record.messages);
  return {
    id: record.id,
    changeId: record.changeId,
    profile: record.profile,
    label: record.label,
    harness: record.harness,
    ...(record.model === undefined ? {} : { model: record.model }),
    ...(record.effort === undefined ? {} : { effort: record.effort }),
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    ...view,
    ...(live === undefined ? {} : { windowIndex: live.index }),
    log: record.log,
    messages: [...record.messages],
  };
};

const notFound = (id: string): NotFoundError => new NotFoundError({ message: `no such subagent: ${id}` });

const requireInstance = (change: Change, id: string): Effect.Effect<SubagentWithMessages, NotFoundError> =>
  Effect.flatMap(readInstance(changeDir(change), id), (record) =>
    record === null ? Effect.fail(notFound(id)) : Effect.succeed(record),
  );

/** The DTO for one instance, freshly read with its live window. */
export const refreshSubagent = (
  change: Change,
  id: string,
): Effect.Effect<SubagentInstanceDto, NotFoundError> =>
  Effect.gen(function* () {
    const record = yield* requireInstance(change, id);
    const live = (yield* liveBySubagent(change.id)).get(id);
    return toDto(record, live);
  });

export const listSubagents = (change: Change): Effect.Effect<readonly SubagentInstanceDto[]> =>
  Effect.gen(function* () {
    const records = yield* listInstances(changeDir(change));
    const live = yield* liveBySubagent(change.id);
    return records.map((record) => toDto(record, live.get(record.id)));
  });

export const showSubagent = (
  change: Change,
  id: string,
): Effect.Effect<SubagentInstanceDto, NotFoundError> => refreshSubagent(change, id);

/** A filename-shaped id derived from the label, with a timestamp and a counter for uniqueness. */
const uniqueId = (change: Change, label: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    const slug =
      label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24) || "subagent";
    const stamp = now().replace(/[-:T.]/g, "").slice(0, 15);
    for (let attempt = 1; ; attempt += 1) {
      const id = attempt === 1 ? `${slug}-${stamp}` : `${slug}-${stamp}-${attempt}`;
      const taken = yield* readInstance(changeDir(change), id);
      if (taken === null) return id;
    }
  });

/** How an instance's window is opened. The default creates the host session and returns its id;
 * a test can supply one that returns a fake id, which is the only part of create/open that
 * touches the terminal substrate. The caller persists the id under the lock. */
export type SubagentLauncher = (change: Change, record: SubagentRecord) => Effect.Effect<string, BadRequestError>;

/** The argv and working directory a subagent's host window runs: the harness pinned to the
 * subagent id (`--session-id`/`--session`), in the subagent's own directory. Pure, so the resume
 * contract a reopen depends on is testable without a harness. */
export const subagentLaunch = (
  changeDirPath: string,
  record: SubagentRecord,
): { readonly cwd: string; readonly command: string[] } => {
  const launch = launchOf({
    harness: record.harness,
    sessionId: record.id,
    label: record.label,
    ...(record.model === undefined ? {} : { model: record.model }),
    ...(record.effort === undefined ? {} : { effort: record.effort }),
  });
  return { cwd: instanceDir(changeDirPath, record.id), command: [launch.command, ...launch.args] };
};

/** The launcher a real subagent gets: its own host session, running the harness pinned to the
 * subagent id. Reopening the same id runs the same argv in the same directory, which is what
 * resumes the harness's own session. */
const startWindow: SubagentLauncher = (change, record) =>
  Effect.gen(function* () {
    const changeDirPath = changeDir(change);
    const { cwd, command } = subagentLaunch(changeDirPath, record);
    // argv, not a shell line: the host execs the harness directly.
    const window = yield* newSubagentWindow(change.id, {
      changeDir: changeDirPath,
      cwd,
      subagentId: record.id,
      label: record.label,
      command,
    }).pipe(Effect.mapError((failure) => new BadRequestError({ message: failure.message })));
    return window;
  });

const opened = (change: Change, id: string, window: string): Effect.Effect<void, BadRequestError> =>
  mutateRecord(changeDir(change), id, (record) => ({
    write: true,
    record: { ...record, window, log: [...record.log, { kind: "opened", at: now() }] },
    result: undefined,
  })).pipe(Effect.mapError((error) => new BadRequestError({ message: error.message })));

/** Create a subagent from a profile, open its window, and append the rendered profile body as
 * the first inbound message. Create, open and the first message are bound on purpose. The render
 * always yields a message (a task, the await instruction, or the body plus one), so create always
 * sends a first message. A failed launcher rolls the whole instance back, and a retried create
 * with the same idempotency key returns the instance it already made. */
export const createSubagent = (
  change: Change,
  input: SubagentCreateRequestDto,
  launcher: SubagentLauncher = startWindow,
  key?: string,
): Effect.Effect<SubagentInstanceDto, BadRequestError | ConflictError | NotFoundError> =>
  Effect.gen(function* () {
    if (change.completedAt) {
      return yield* new BadRequestError({ message: "this change is finished: no new subagents" });
    }
    if (key !== undefined) {
      const existing = yield* findCreatedByKey(changeDir(change), key).pipe(
        Effect.mapError((error) => new BadRequestError({ message: error.message })),
      );
      if (existing) return toDto(existing, undefined);
    }
    const profile = yield* resolveProfileFor(change, input.profile);
    if (!profile) {
      return yield* new BadRequestError({ message: `no such profile: ${input.profile}` });
    }
    const from = input.from ?? "orchestrator";
    const dir = changeDir(change);
    return yield* withCreateLock(
      dir,
      Effect.gen(function* () {
        const id = yield* uniqueId(change, profile.profile.label);
        const record: SubagentRecord = {
          id,
          changeId: change.id,
          profile: profile.key,
          label: profile.profile.label,
          harness: profile.profile.harness,
          ...(profile.profile.model === undefined ? {} : { model: profile.profile.model }),
          ...(profile.profile.effort === undefined ? {} : { effort: profile.profile.effort }),
          createdBy: from,
          createdAt: now(),
          ...(key === undefined ? {} : { createdKey: key }),
          log: [{ kind: "created", at: now() }],
        };
        yield* createInstance(dir, record).pipe(
          Effect.mapError(() => new ConflictError({ message: `subagent "${id}" already exists` })),
        );
        yield* appendMessageAndPatch(
          dir,
          id,
          {
            role: from,
            body: renderSubagentBody(profile.profile.body, factsFor(change), input.prompt),
            at: now(),
          },
          (current) => current,
        ).pipe(Effect.mapError((error) => new BadRequestError({ message: error.message })));
        // The launcher can still fail after the files exist: roll back so a failed create leaves
        // nothing behind, and a retry starts clean.
        const window = yield* launcher(change, record).pipe(
          Effect.catch((failure) => Effect.andThen(removeInstance(dir, id), Effect.fail(failure))),
        );
        yield* opened(change, id, window);
        return yield* refreshSubagent(change, id);
      }),
    );
  });

export const openSubagent = (
  change: Change,
  id: string,
  launcher: SubagentLauncher = startWindow,
): Effect.Effect<SubagentInstanceDto, NotFoundError | BadRequestError> =>
  openLock(`${change.id}\u0000${id}`).withPermits(1)(
    Effect.gen(function* () {
      const record = yield* requireInstance(change, id);
      const live = (yield* liveBySubagent(change.id)).get(id);
      if (live !== undefined) return toDto(record, live);
      const window = yield* launcher(change, record);
      yield* opened(change, id, window);
      yield* Effect.sync(() => announce("windows"));
      return yield* refreshSubagent(change, id);
    }),
  );

export const closeSubagent = (
  change: Change,
  id: string,
): Effect.Effect<SubagentInstanceDto, NotFoundError> =>
  Effect.gen(function* () {
    const record = yield* requireInstance(change, id);
    if (record.window !== undefined) {
      yield* killHostWindow(change.id, record.window).pipe(Effect.catch(() => Effect.void));
    }
    yield* mutateRecord(changeDir(change), id, (current) => ({
      write: true,
      record: {
        ...current,
        window: undefined,
        log: [...current.log, { kind: "closed", at: now() }],
      },
      result: undefined,
    })).pipe(Effect.catch(() => Effect.void));
    yield* notify(change.id, id, { kind: "lost", id });
    yield* Effect.sync(() => announce("windows"));
    return yield* refreshSubagent(change, id);
  });

/** Append an inbound message and wake `next`. An open `inFlight` — an interrupted turn — is set
 * aside first, with a `continued` entry, so the new message is what the extension receives; this
 * is what the one-click Continue sends. */
export const sendToSubagent = (
  change: Change,
  id: string,
  text: string,
  from: "orchestrator" | "user",
  key?: string,
): Effect.Effect<SubagentMessage, NotFoundError | BadRequestError> =>
  Effect.gen(function* () {
    yield* requireInstance(change, id);
    const { message } = yield* appendMessageAndPatch(
      changeDir(change),
      id,
      { role: from, body: text, at: now(), ...(key === undefined ? {} : { key }) },
      (record) =>
        record.inFlight === undefined
          ? { ...record }
          : {
              ...record,
              inFlight: undefined,
              log: [...record.log, { kind: "continued", at: now(), note: "a new message arrived" }],
            },
    ).pipe(Effect.mapError((error) => new BadRequestError({ message: error.message })));
    yield* notify(change.id, id, { kind: "inbound", id, message });
    yield* Effect.sync(() => announce("changes"));
    return message;
  });

/** A settled subagent turn, relayed by the harness extension. Clears `inFlight`, appends the
 * reply, and wakes `await` and the UI. */
export const recordTurn = (
  change: Change,
  id: string,
  text: string,
  key?: string,
  pane?: string,
): Effect.Effect<SubagentMessage, NotFoundError | BadRequestError> =>
  Effect.gen(function* () {
    yield* requireInstance(change, id);
    const { message } = yield* appendMessageAndPatch(
      changeDir(change),
      id,
      {
        role: "subagent",
        body: text,
        at: now(),
        ...(key === undefined ? {} : { key }),
        ...(pane === undefined ? {} : { pane }),
      },
      (record) =>
        record.inFlight === undefined
          ? { ...record }
          : {
              ...record,
              inFlight: undefined,
              log: [...record.log, { kind: "turn_settled", at: now() }],
            },
    ).pipe(Effect.mapError((error) => new BadRequestError({ message: error.message })));
    yield* notify(change.id, id, { kind: "reply", id, message });
    yield* Effect.sync(() => announce("changes"));
    return message;
  });

/** The latest subagent message: the current deliverable. */
export const resultOfSubagent = (
  change: Change,
  id: string,
): Effect.Effect<SubagentMessage | null, NotFoundError> =>
  Effect.map(requireInstance(change, id), (record) => {
    const reply = [...record.messages].reverse().find((message) => message.role === "subagent");
    return reply ?? null;
  });

/** The extension's half: the next message to submit, an interrupted turn to leave alone, or
 * nothing yet. `after` is the last message number the caller already submitted; a live extension
 * that lost the response can be handed that message again, while a fresh extension (no `after`)
 * gets `interrupted` rather than a redelivery. */
export const nextForSubagent = (
  change: Change,
  id: string,
  after?: number,
): Effect.Effect<SubagentNextResponseDto, NotFoundError | BadRequestError> =>
  Effect.gen(function* () {
    yield* requireInstance(change, id);
    const deadline = Date.now() + longPollMs();
    for (;;) {
      // Subscribe before reading, and keep the subscription until the step settles: an event that
      // fires after the registration resolves the deferred; one that fired before is seen by the
      // claim below.
      const subscription = yield* subscribe(change.id, id);
      const step = yield* Effect.gen(function* () {
        const claimed = yield* claimInbound(changeDir(change), id, now(), after).pipe(
          Effect.mapError((error) => new BadRequestError({ message: error.message })),
        );
        if (claimed.status === "message") {
          return { done: true as const, result: { status: "message" as const, message: claimed.message } };
        }
        if (claimed.status === "interrupted") {
          return { done: true as const, result: { status: "interrupted" as const } };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { done: true as const, result: { status: "none" as const } };
        const event = yield* subscription.await.pipe(Effect.timeoutOption(remaining));
        if (event._tag === "None") {
          return { done: true as const, result: { status: "none" as const } };
        }
        if (event.value.kind === "lost") {
          return { done: true as const, result: { status: "interrupted" as const } };
        }
        return { done: false as const };
      }).pipe(Effect.ensuring(subscription.close));
      if (step.done) return step.result;
      // inbound or reply: loop, claim, and either return the message or park again.
    }
  });


export type AwaitInput = {
  /** The subagents to await; empty means every subagent of the change. */
  readonly ids: readonly string[];
  /** `any` returns the first target that settles; `all` waits for every one of them. */
  readonly mode: "any" | "all";
};

/** How often a parked `await` re-checks state without an event: the reporter can flip
 * `@agent_status` to `waiting` with no message ever appended, and an idle read must not wait for
 * a wake that never comes. */
const recheckMs = 2_000;

/** Block until a target can be processed — idle or waiting for input with nothing of the
 * orchestrator's still to deliver, or a reply already parked — with the outcomes `ready`, `lost`,
 * `interrupted`, and `timeout` at the horizon (the orchestrator's cue to check in on its
 * subagents and await again). `any` answers for the first target that settles; `all` waits for
 * every target to settle and reports a lost or interrupted one in preference to `ready`. */
export const awaitReady = (
  change: Change,
  input: AwaitInput,
): Effect.Effect<SubagentAwaitResponseDto, NotFoundError> =>
  Effect.gen(function* () {
    const records = yield* listInstances(changeDir(change));
    const targets = input.ids.length === 0 ? records.map((record) => record.id) : [...input.ids];
    for (const id of targets) {
      if (!records.some((record) => record.id === id)) return yield* Effect.fail(notFound(id));
    }
    if (targets.length === 0) return { status: "timeout" };

    /** One subagent's own wait: settled by the read whenever it is ready, woken by the next
     * event, and re-checked on the tick for state the reporter changes without one. */
    const settleOne = (id: string): Effect.Effect<SubagentAwaitResponseDto> =>
      Effect.gen(function* () {
        for (;;) {
          // Subscribe before reading anything, and keep the subscription until the step settles:
          // an event that fires after the registration resolves the deferred; one that fired
          // before is seen by the read below (waiters.ts has the full argument).
          const subscription = yield* subscribe(change.id, id);
          const step = yield* Effect.gen(function* () {
            const live = yield* liveBySubagent(change.id);
            const entry = live.get(id);
            const attached = entry !== undefined;
            const record = yield* requireInstance(change, id).pipe(
              Effect.catch(() => Effect.succeed(null)),
            );
            if (record === null) {
              return { done: true as const, result: { status: "lost" as const, id } };
            }
            // In flight with no live window: the machine was interrupted mid-turn.
            if (record.inFlight !== undefined && !attached) {
              return { done: true as const, result: { status: "interrupted" as const, id } };
            }
            const pending = pendingInbound(record) !== undefined;
            // A window `close` cleared cannot deliver what is still pending: the lost answer,
            // read from the state so a close before the subscription cannot be waited out to
            // the horizon. A record whose window was never set is the same story.
            if (record.window === undefined && pending) {
              return { done: true as const, result: { status: "lost" as const, id } };
            }
            const view = viewOf(record, viewInputOf(entry), record.messages);
            // Ready is what lets the orchestrator process: a reply is parked, or the subagent is
            // idle with nothing of the orchestrator's still to be delivered. The pending-message
            // hold-back is what keeps `send` (or a create's first prompt) followed by `await`
            // from answering before the relay has picked the message up.
            if (view.awaitingReply || (view.activity === "idle" && !pending)) {
              return {
                done: true as const,
                result: { status: "ready" as const, id, awaitingReply: view.awaitingReply },
              };
            }
            // A lost window resolves the wait as itself (exit 5) — today's answer — while the
            // other events just wake a re-read of the state.
            const event = yield* subscription.await.pipe(Effect.timeoutOption(recheckMs));
            if (event._tag === "Some" && event.value.kind === "lost") {
              return { done: true as const, result: { status: "lost" as const, id } };
            }
            return { done: false as const };
          }).pipe(Effect.ensuring(subscription.close));
          if (step.done) return step.result;
        }
      });

    const waits = targets.map(settleOne);
    if (input.mode === "all") {
      const settled = yield* Effect.all(waits).pipe(Effect.timeoutOption(longPollMs()));
      if (settled._tag === "None") return { status: "timeout" };
      const lost = settled.value.find((result) => result.status === "lost");
      if (lost) return lost;
      const interrupted = settled.value.find((result) => result.status === "interrupted");
      if (interrupted) return interrupted;
      return { status: "ready" };
    }
    const raced =
      waits.length > 1 ? Effect.raceAll(waits) : (waits[0] as Effect.Effect<SubagentAwaitResponseDto>);
    const result = yield* raced.pipe(Effect.timeoutOption(longPollMs()));
    return result._tag === "None" ? { status: "timeout" } : result.value;
  });
