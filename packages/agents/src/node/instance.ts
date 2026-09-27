/** The filesystem half of subagent instances: one directory per subagent, a `session.json`
 * record, and one file per message. The server is the only writer; every mutation takes the
 * per-subagent lock so two concurrent requests cannot collide on a message number or a record
 * patch.
 *
 * The vocabulary and the derivations are pure (`../instance`). */
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
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

/** The path a record's file is at, for a caller that wants to show it. */
export const recordPath = (changeDir: string, id: string): string =>
  join(instanceDir(changeDir, id), "session.json");

/** Re-exported so the server does not reach into the pure module for the common types. */
export type { SubagentRecord, SubagentMessage, SubagentWithMessages };
