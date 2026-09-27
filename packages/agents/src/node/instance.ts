/** The filesystem half of subagent instances: one directory per subagent, a `session.json`
 * record, and one file per message. The server is the only writer; every mutation takes the
 * per-subagent lock so two concurrent requests cannot collide on a message number or a record
 * patch.
 *
 * The vocabulary and the derivations are pure (`../instance`). */
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";

import {
  messageFileOf,
  messageFileName,
  nextNumber,
  parseMessage,
  parseRecord,
  renderMessage,
  renderRecord,
  type SubagentMessage,
  type SubagentRecord,
  type SubagentRole,
  type SubagentWithMessages,
} from "../instance.ts";

/** Where a change's subagents live, beside its plan. */
export const subagentsDir = (changeDir: string): string => join(changeDir, "subagents");

export const instanceDir = (changeDir: string, id: string): string => join(subagentsDir(changeDir), id);

/** One lock per subagent directory, created the first time it is needed. Synchronous
 * get-or-create: no fiber can interleave between the read and the set. */
const locks = new Map<string, ReturnType<typeof Effect.unsafeMakeSemaphore>>();
const lockFor = (key: string): ReturnType<typeof Effect.unsafeMakeSemaphore> => {
  let lock = locks.get(key);
  if (lock === undefined) {
    lock = Effect.unsafeMakeSemaphore(1);
    locks.set(key, lock);
  }
  return lock;
};

const withLock = <A, E, R>(
  changeDir: string,
  id: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => lockFor(`${changeDir}\u0000${id}`).withPermits(1)(effect);

/** The atomic write the record needs: a reader never sees half a file. */
const writeAtomic = (path: string, data: string): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: async () => {
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, data);
      await rename(temp, path);
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });

const readText = (path: string): Effect.Effect<string | undefined> =>
  Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: () => new Error(path) }).pipe(
    Effect.catchAll(() => Effect.succeed(undefined)),
  );

/** The message files of one instance, numbered from their filenames and sorted. A file that
 * cannot be parsed is skipped: the server wrote it, so it is a damaged file rather than user
 * input, and one bad line must not take the log down. */
export const readMessages = (
  changeDir: string,
  id: string,
): Effect.Effect<readonly SubagentMessage[]> =>
  Effect.gen(function* () {
    const dir = instanceDir(changeDir, id);
    const names = yield* Effect.tryPromise({ try: () => readdir(dir), catch: () => new Error(dir) }).pipe(
      Effect.catchAll(() => Effect.succeed([] as string[])),
    );
    const messages: SubagentMessage[] = [];
    for (const name of names.sort()) {
      const file = messageFileOf(name);
      if (!file) continue;
      const text = yield* readText(join(dir, name));
      if (text === undefined) continue;
      const parsed = parseMessage(text);
      if (parsed._tag === "Left") continue;
      messages.push({ ...parsed.right, number: file.number, role: file.role });
    }
    return messages.sort((left, right) => left.number - right.number);
  });

/** Read one instance, or null when it does not exist. */
export const readInstance = (
  changeDir: string,
  id: string,
): Effect.Effect<SubagentWithMessages | null> =>
  Effect.gen(function* () {
    const text = yield* readText(join(instanceDir(changeDir, id), "session.json"));
    if (text === undefined) return null;
    const parsed = parseRecord(text);
    if (parsed._tag === "Left") return null;
    const messages = yield* readMessages(changeDir, id);
    return { ...parsed.right, messages };
  });

/** Every instance of a change, in id order (which is creation order, the ids carrying a
 * timestamp). */
export const listInstances = (
  changeDir: string,
): Effect.Effect<readonly SubagentWithMessages[]> =>
  Effect.gen(function* () {
    const dir = subagentsDir(changeDir);
    const names = yield* Effect.tryPromise({ try: () => readdir(dir), catch: () => new Error(dir) }).pipe(
      Effect.catchAll(() => Effect.succeed([] as string[])),
    );
    const instances: SubagentWithMessages[] = [];
    for (const name of names.sort()) {
      const found = yield* readInstance(changeDir, name);
      if (found) instances.push(found);
    }
    return instances;
  });

/** Create a record and its directory. Refuses to overwrite an existing instance. */
export const createInstance = (
  changeDir: string,
  record: SubagentRecord,
): Effect.Effect<void, Error> =>
  withLock(
    changeDir,
    record.id,
    Effect.gen(function* () {
      const dir = instanceDir(changeDir, record.id);
      const existing = yield* readText(join(dir, "session.json"));
      if (existing !== undefined) {
        return yield* Effect.fail(new Error(`subagent "${record.id}" already exists`));
      }
      yield* Effect.tryPromise({
        try: () => mkdir(dir, { recursive: true }),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      });
      yield* writeAtomic(join(dir, "session.json"), renderRecord(record));
    }),
  );

/** Replace a record's file. Callers pass a record they read under the same lock. */
export const writeRecord = (changeDir: string, record: SubagentRecord): Effect.Effect<void, Error> =>
  withLock(
    changeDir,
    record.id,
    writeAtomic(join(instanceDir(changeDir, record.id), "session.json"), renderRecord(record)),
  );

/** Append one message, assigning its number under the lock so two concurrent sends cannot
 * collide. Returns the message as written. */
export const appendMessage = (
  changeDir: string,
  id: string,
  input: {
    readonly role: SubagentRole;
    readonly body: string;
    readonly at: string;
    readonly pane?: string;
  },
): Effect.Effect<SubagentMessage, Error> =>
  withLock(
    changeDir,
    id,
    Effect.gen(function* () {
      const messages = yield* readMessages(changeDir, id);
      const message: SubagentMessage = {
        number: nextNumber(messages),
        role: input.role,
        at: input.at,
        body: input.body,
        ...(input.pane === undefined ? {} : { pane: input.pane }),
      };
      const dir = instanceDir(changeDir, id);
      yield* Effect.tryPromise({
        try: () => mkdir(dir, { recursive: true }),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      });
      yield* writeAtomic(join(dir, messageFileName(message.number, message.role)), renderMessage(message));
      return message;
    }),
  );

/** A change-level lock, for the operations that span instances: create's idempotency scan, and
 * removal. Per-subagent locks do not help when the thing being decided is which subagent. */
const changeLocks = new Map<string, ReturnType<typeof Effect.unsafeMakeSemaphore>>();
const changeLockFor = (changeDir: string): ReturnType<typeof Effect.unsafeMakeSemaphore> => {
  let lock = changeLocks.get(changeDir);
  if (lock === undefined) {
    lock = Effect.unsafeMakeSemaphore(1);
    changeLocks.set(changeDir, lock);
  }
  return lock;
};

const withChangeLock = <A, E, R>(
  changeDir: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => changeLockFor(changeDir).withPermits(1)(effect);

/** A mutation that may or may not write the record, decided from the record read under the lock.
 * This is the primitive that makes read-modify-write atomic: the caller never reads the record
 * itself and then writes it back outside the lock. */
export type Mutation<A> =
  | { readonly write: false; readonly result: A }
  | { readonly write: true; readonly record: SubagentRecord; readonly result: A };

export const mutateRecord = <A>(
  changeDir: string,
  id: string,
  fn: (record: SubagentWithMessages) => Mutation<A>,
): Effect.Effect<A, Error> =>
  withLock(
    changeDir,
    id,
    Effect.gen(function* () {
      const record = yield* readInstance(changeDir, id);
      if (record === null) return yield* Effect.fail(new Error(`no such subagent: ${id}`));
      const mutation = fn(record);
      if (mutation.write) {
        yield* writeAtomic(join(instanceDir(changeDir, id), "session.json"), renderRecord(mutation.record));
      }
      return mutation.result;
    }),
  );

/** Append a message and patch the record in one locked step. A message carrying an idempotency
 * `key` that is already present is returned as-is, with `replayed: true`, and nothing is written:
 * a retried send/turn appends once. */
export const appendMessageAndPatch = (
  changeDir: string,
  id: string,
  input: {
    readonly role: SubagentRole;
    readonly body: string;
    readonly at: string;
    readonly pane?: string;
    readonly key?: string;
  },
  patch: (record: SubagentWithMessages, message: SubagentMessage) => SubagentRecord,
): Effect.Effect<{ readonly message: SubagentMessage; readonly replayed: boolean }, Error> =>
  withLock(
    changeDir,
    id,
    Effect.gen(function* () {
      const record = yield* readInstance(changeDir, id);
      if (record === null) return yield* Effect.fail(new Error(`no such subagent: ${id}`));
      if (input.key !== undefined) {
        const existing = record.messages.find((message) => message.key === input.key);
        if (existing) return { message: existing, replayed: true };
      }
      const message: SubagentMessage = {
        number: nextNumber(record.messages),
        role: input.role,
        at: input.at,
        body: input.body,
        ...(input.pane === undefined ? {} : { pane: input.pane }),
        ...(input.key === undefined ? {} : { key: input.key }),
      };
      const dir = instanceDir(changeDir, id);
      yield* writeAtomic(join(dir, messageFileName(message.number, message.role)), renderMessage(message));
      yield* writeAtomic(
        join(dir, "session.json"),
        renderRecord(patch({ ...record, messages: [...record.messages, message] }, message)),
      );
      return { message, replayed: false };
    }),
  );

export type Claim =
  | { readonly status: "message"; readonly message: SubagentMessage; readonly redelivered: boolean }
  | { readonly status: "interrupted" }
  | { readonly status: "none" };

/** Claim the next inbound message for the extension, atomically: if a turn is already in flight
 * this answers `interrupted` (or redelivers that message when `redeliverAfter` says the caller
 * has not seen it); otherwise it advances the delivery cursor and the in-flight marker together
 * under the lock, so two concurrent `next` calls cannot both claim the same message. */
export const claimInbound = (
  changeDir: string,
  id: string,
  at: string,
  redeliverAfter?: number,
): Effect.Effect<Claim, Error> =>
  withLock(
    changeDir,
    id,
    Effect.gen(function* () {
      const record = yield* readInstance(changeDir, id);
      if (record === null) return yield* Effect.fail(new Error(`no such subagent: ${id}`));
      if (record.inFlight !== undefined) {
        if (redeliverAfter !== undefined && redeliverAfter < record.inFlight) {
          const message = record.messages.find((one) => one.number === record.inFlight);
          if (message) return { status: "message", message, redelivered: true } as const;
        }
        return { status: "interrupted" } as const;
      }
      const pending = record.messages.find(
        (message) => message.role !== "subagent" && message.number > (record.deliveredThrough ?? 0),
      );
      if (pending === undefined) return { status: "none" } as const;
      yield* writeAtomic(
        join(instanceDir(changeDir, id), "session.json"),
        renderRecord({
          ...record,
          deliveredThrough: pending.number,
          inFlight: pending.number,
          log: [...record.log, { kind: "turn_started", at, note: `message ${pending.number}` }],
        }),
      );
      return { status: "message", message: pending, redelivered: false } as const;
    }),
  );

/** Remove an instance's directory. Used to roll back a create whose launcher failed, so a failed
 * create leaves nothing behind. */
export const removeInstance = (changeDir: string, id: string): Effect.Effect<void> =>
  withLock(
    changeDir,
    id,
    Effect.promise(() => rm(instanceDir(changeDir, id), { recursive: true, force: true })).pipe(
      Effect.catchAll(() => Effect.void),
    ),
  );

/** The record of an instance created with an idempotency key, if one exists: the create route
 * returns it instead of minting a second instance. Under the change-level lock, so two concurrent
 * retries cannot both miss it. */
export const findCreatedByKey = (
  changeDir: string,
  key: string,
): Effect.Effect<SubagentWithMessages | null, Error> =>
  withChangeLock(
    changeDir,
    Effect.gen(function* () {
      const instances = yield* listInstances(changeDir);
      return instances.find((instance) => instance.createdKey === key) ?? null;
    }),
  );

/** Run a create's whole body under the change lock, so a same-key retry cannot race. */
export const withCreateLock = <A, E, R>(
  changeDir: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => withChangeLock(changeDir, effect);

/** The path a record's file is at, for a caller that wants to show it. */
export const recordPath = (changeDir: string, id: string): string =>
  join(instanceDir(changeDir, id), "session.json");

/** Re-exported so the server does not reach into the pure module for the common types. */
export type { SubagentRecord, SubagentMessage, SubagentWithMessages };
