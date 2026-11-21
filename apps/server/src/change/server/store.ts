import { join, dirname, isAbsolute, relative, resolve } from "node:path";
import type { Dirent } from "node:fs";
import { readdir, readFile, mkdir } from "node:fs/promises";
import { Effect, Schema } from "effect";
import { changeRecordLock, isNotFound } from "@corvi/changes/node";
import type { Change } from "@corvi/changes/record";
import { FORMAT_VERSION, PLAN_FILE } from "@corvi/changes/record";
import { ChangeId } from "@corvi/contracts/changes";
import { ChangeConflict, ChangeFormatTooNew, formatTooNew } from "@corvi/changes/errors";
import { Change as ChangeSchema } from "./schema.ts";
import { BadRequestError, DecodeError, InternalError, NotFoundError } from "@corvi/contracts/errors";
import { decodePreserving, formatIssues } from "@corvi/contracts/body";
import { fs } from "../../capabilities/effect/support.ts";
import { file, write, writeAtomic } from "../../capabilities/files.ts";
import { runtimeConfig, workspaceById, settingsOf } from "../../workspace/server/index.ts";

/** One scope's changes root and archive root: where its change directories are, and where they
 * travel to when done. The archive is a root of its own — it can live outside the changes root,
 * and listing the changes root never has to filter it out. */
export type ChangeRoots = { readonly root: string; readonly archiveRoot: string };

/** Every scope's roots — the global level's and each workspace's, duplicates folded. Lookup and
 * listing scan them all, so a change stays wherever it was made even when its workspace's roots
 * move later; the first pair is the global level's, where older changes are. Override with
 * CORVI_ROOT / CORVI_ARCHIVE_ROOT (tests do). */
export const changePairs = (): readonly ChangeRoots[] => {
  const pairs: ChangeRoots[] = [];
  const add = (workspace: Parameters<typeof settingsOf>[0]): void => {
    const settings = settingsOf(workspace);
    const pair = { root: settings.changesRoot, archiveRoot: settings.archiveRoot };
    if (!pairs.some((one) => one.root === pair.root && one.archiveRoot === pair.archiveRoot)) {
      pairs.push(pair);
    }
  };
  // The global level first: a workspace's override never hides older changes. Then each
  // workspace's own pair.
  add(undefined);
  for (const workspace of runtimeConfig().workspaces) add(workspace);
  return pairs;
};

/** Where a change without a workspace lives and is created: the first workspace's root, where
 * every change without one belongs. */
export const root = (): string => settingsOf(workspaceById()).changesRoot;

/** The archive beside `root()`. */
export const archiveRoot = (): string => settingsOf(workspaceById()).archiveRoot;

/** Where one change's directory is — or, for a change not written yet, where it is created: its
 * workspace's changes root, named after the change. A change that already exists and predates a
 * root override stays where it is: the writers prefer `existingDir`, and only fall back to this
 * when creating. */
export const changeDir = (change: { readonly id: string; readonly workspace?: string }): string =>
  join(settingsOf(workspaceById(change.workspace)).changesRoot, change.id);

/** Where one change travels to when it is done: its workspace's archive root. */
export const archiveDir = (change: { readonly id: string; readonly workspace?: string }): string =>
  join(settingsOf(workspaceById(change.workspace)).archiveRoot, change.id);

/** File-backed change records and associated documents. */

const fileExists = (path: string): Effect.Effect<boolean> => fs(() => file(path).exists());

/** The change-root files the change module writes for itself. `Changes.readSidecar` refuses
 * these names, so the capability's migration read cannot be turned on the core's own record or
 * journal; a legacy sidecar from a former feature (notes.md) stays reachable. `wt.toml` is
 * deliberately not here any more: Corvi computes the worktree path itself (apps/server/src/vendors/git.ts),
 * so a file left by the days when wt owned it is an ordinary leftover. */
export const CORE_SIDECARS: ReadonlySet<string> = new Set(["change.json", "completion.json", PLAN_FILE]);

/** Every directory this change may live in: each scope's active root first — the active copy
 * wins — then each scope's archive. */
const candidatesFor = (id: string): string[] => {
  const pairs = changePairs();
  return [
    ...pairs.map(({ root }) => join(root, id)),
    ...pairs.map(({ archiveRoot }) => join(archiveRoot, id)),
  ];
};

/** The directory the change lives in — active first across the scopes, then archived — or null
 * when no scope holds it. This is the one lookup: a change predating a root override stays
 * wherever it was made. */
const existingDir = (id: string): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    for (const dir of candidatesFor(id)) {
      if (yield* fileExists(join(dir, "change.json"))) return dir;
    }
    return null;
  });

/** Where a change's directory is now — its changes root, or the archive once it is over — or
 * null when no scope holds it. */
export const currentDirOf = (id: string): Effect.Effect<string | null> => existingDir(id);

/** The downgrade fence, for the writers that do not hold the record: a change written by a
 * newer Corvi is read but never written, documents and journal included. */
const guardFormat = (id: string): Effect.Effect<void, ChangeFormatTooNew> =>
  Effect.gen(function* () {
    const dir = yield* existingDir(id);
    const text = dir
      ? yield* fs(() => file(join(dir, "change.json")).text()).pipe(
          Effect.catchDefect(() => Effect.succeed("")),
        )
      : "";
    const raw = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
    )(text).pipe(Effect.orElseSucceed(() => ({}) as Record<string, unknown>));
    const recordFormat = typeof raw.formatVersion === "number" ? raw.formatVersion : 1;
    if (recordFormat > FORMAT_VERSION) return yield* formatTooNew(ChangeId.make(id), recordFormat);
  });

// Decode with unknown keys preserved: a change.json carries whatever the code that wrote it
// put there, and rewriting it must not drop fields another version added. Failures become
// DecodeError with the schema issues rendered one line per problem, path included.
const decodeChange = (text: string, dir: string): Effect.Effect<Change, DecodeError> =>
  Effect.gen(function* () {
    const raw = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
    )(text).pipe(
      Effect.mapError(() => new DecodeError({ source: "file", message: `malformed change.json in ${dir}` })),
    );
    return yield* decodePreserving(ChangeSchema, raw).pipe(
      Effect.mapError(
        (error) =>
          new DecodeError({
            source: "file",
            message: `malformed change.json in ${dir}: ${formatIssues(error)}`,
          }),
      ),
    );
  });

/** Read one change's change.json through its Schema. `null` means no change.json in the change
 * directory or the archive. A malformed or wrongly-shaped file is a typed DecodeError. */
export const readChange = (id: string): Effect.Effect<Change | null, DecodeError> =>
  Effect.gen(function* () {
    const dir = yield* existingDir(id);
    if (!dir) return null;
    const text = yield* Effect.tryPromise(() => file(join(dir, "change.json")).text()).pipe(Effect.orDie);
    return yield* decodeChange(text, dir);
  });

/** What the store found under the lock, for the caller's decision: the record as it stands (or
 * why it could not be read), and the revision the write would go onto. */
type BeforeWrite = {
  /** The record as it stands, or `null` when it is missing or unreadable. */
  readonly current: Change | null;
  /** Why it could not be read; absent when the record is simply not there. */
  readonly unreadable?: DecodeError;
  /** The revision to write onto: the record's own, or — for an unconditional write on an
   * unreadable record only — the caller's snapshot. */
  readonly onto: number;
};

/** One write of change.json: the read of the record on disk, the caller's decision about what to
 * write, the downgrade fence, and the write — all inside the process-wide record lock that the
 * capability store's writer holds too. A decision and the write it guards therefore cannot
 * interleave with another writer in this process.
 *
 * `decide` gets the record as it stands, so a read-modify-write (an extension's bag) merges inside
 * the lock rather than CAS-ing a snapshot merged outside it. The revision moves on every write,
 * whichever store writes it: the lifecycle's optimistic check compares it, so an edit that lands
 * between a transition's read and its write makes that transition conflict rather than overwrite
 * the edit. The revision on disk is authoritative; a fresh record starts at 1. The winning record
 * — the one with the new revision — is the answer, so a caller never reports the snapshot it
 * wrote from. */
const writeRecord = <E>(
  start: Change,
  decide: (before: BeforeWrite) => Effect.Effect<Change, E>,
): Effect.Effect<Change, ChangeFormatTooNew | E> =>
  changeRecordLock.withPermits(1)(
    Effect.gen(function* () {
      const dir = (yield* existingDir(start.id)) ?? changeDir(start);
      yield* fs(() => mkdir(dir, { recursive: true }));
      const read = yield* readChange(start.id).pipe(Effect.result);
      const before: BeforeWrite =
        read._tag === "Success"
          ? {
              current: read.success,
              onto: Number((read.success as { revision?: unknown } | null)?.revision ?? 0),
            }
          : {
              current: null,
              unreadable: read.failure,
              onto: Number((start as { revision?: unknown }).revision ?? 0),
            };
      const record = yield* decide(before);
      // The fence covers both the record about to be written and the one on disk: a newer format
      // is never flattened, even when the caller's value does not carry its version.
      const newest = Math.max(record.formatVersion ?? 0, before.current?.formatVersion ?? 0);
      if (newest > FORMAT_VERSION) return yield* formatTooNew(ChangeId.make(start.id), newest);
      const written = { ...record, revision: before.onto + 1, formatVersion: FORMAT_VERSION };
      yield* fs(() => writeAtomic(join(dir, "change.json"), JSON.stringify(written, null, 2) + "\n"));
      return written;
    }),
  );

/** Write a record unconditionally — creation and a seeded fixture: the value is the whole record
 * and there is no observed revision to be held to. An unreadable record falls back to the
 * caller's revision here and only here; every other writer is conditional (`writeChangeAt`, or a
 * read-modify-write through `writeRecord`'s `decide`). */
export const writeChange = (change: Change): Effect.Effect<Change, ChangeFormatTooNew> =>
  writeRecord(change, () => Effect.succeed(change));

/** Write a record only onto the revision the caller read. The optimistic check that makes a
 * hand edit safe: a PATCH that loses a race gets a `ChangeConflict` instead of overwriting the
 * winner, and the caller runs its side effects (the ticket move) only after the write landed.
 * A record that is gone or unreadable is refused too — a conditional write cannot claim to be
 * onto a revision the disk never confirmed. */
export const writeChangeAt = (
  change: Change,
  expectedRevision: number,
): Effect.Effect<Change, ChangeFormatTooNew | ChangeConflict | DecodeError> =>
  writeRecord(change, (before) => {
    const changeId = ChangeId.make(change.id);
    if (before.current === null)
      return Effect.fail(
        before.unreadable ??
          new ChangeConflict({
            changeId,
            expected: expectedRevision,
            actual: 0,
            message: `${change.id} is no longer on disk: reload the change and try again`,
          }),
      );
    return before.onto === expectedRevision
      ? Effect.succeed(change)
      : Effect.fail(
          new ChangeConflict({
            changeId,
            expected: expectedRevision,
            actual: before.onto,
            message:
              `${change.id} changed since it was read (expected revision ${expectedRevision}, ` +
              `found ${before.onto}): reload the change and try again`,
          }),
        );
  });

/** A file beside change.json — notes, completion progress — which therefore travels into the
 * archive with it. Read from wherever the change currently lives. A missing or unreadable
 * sidecar reads as empty, which is what `.catch(() => "")` did. */
export const readSidecar = (id: string, name: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    const dir = yield* existingDir(id);
    if (!dir) return "";
    return yield* fs(() => file(join(dir, name)).text()).pipe(Effect.catchDefect(() => Effect.succeed("")));
  });

export const writeSidecar = (
  id: string,
  name: string,
  text: string,
): Effect.Effect<void, ChangeFormatTooNew> =>
  // Under the record lock: the archive move renames the directory, and a write that resolved the
  // old path would otherwise recreate an empty active change behind it.
  changeRecordLock.withPermits(1)(
    Effect.gen(function* () {
      yield* guardFormat(id);
      const dir = (yield* existingDir(id)) ?? changeDir({ id });
      yield* fs(() => mkdir(dir, { recursive: true }));
      yield* fs(() => write(join(dir, name), text));
    }),
  );

/** Where one extension's files live inside a change: `extensions/<name>/`, resolved through
 * the change's current directory so they travel into the archive with it. Not created here;
 * writing creates it on demand. */
const extensionDir = (change: Change, name: string): Effect.Effect<string> =>
  Effect.map(existingDir(change.id), (dir) => join(dir ?? changeDir(change), "extensions", name));

/** Resolve a path against the extension's directory, rejecting anything that escapes it. The
 * confinement is what keeps `../change.json` and the core's own sidecars out of reach. */
const confinedPath = (base: string, path: string): Effect.Effect<string, BadRequestError> => {
  const target = resolve(base, path);
  const rel = relative(base, target);
  return rel.startsWith("..") || isAbsolute(rel)
    ? Effect.fail(new BadRequestError({ message: `extension path escapes its directory: ${path}` }))
    : Effect.succeed(target);
};

/** The files under one extension's directory, recursively, as paths relative to it. A directory
 * that does not exist yet reads as empty, which is an extension that has stored nothing. */
export const listExtensionFiles = (change: Change, name: string): Effect.Effect<string[], BadRequestError> =>
  Effect.gen(function* () {
    const base = yield* extensionDir(change, name);
    const walk = (dir: string, prefix: string): Effect.Effect<string[], BadRequestError> =>
      Effect.gen(function* () {
        const entries: Dirent[] = yield* fs(() => readdir(dir, { withFileTypes: true })).pipe(
          Effect.catchDefect(() => Effect.succeed([] as Dirent[])),
        );
        const found: string[] = [];
        for (const entry of entries) {
          const path = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) found.push(...(yield* walk(join(dir, entry.name), path)));
          else if (entry.isFile()) found.push(path);
        }
        return found;
      });
    return (yield* walk(base, "")).sort();
  });

/** Read one file of an extension's own store. A file that is not there is a typed miss rather
 * than an empty string, so a typo does not read as "nothing stored". */
export const readExtensionFile = (
  change: Change,
  name: string,
  path: string,
): Effect.Effect<string, BadRequestError | NotFoundError> =>
  Effect.gen(function* () {
    const base = yield* extensionDir(change, name);
    const target = yield* confinedPath(base, path);
    if (!(yield* fileExists(target))) {
      return yield* new NotFoundError({ message: `no such file: ${name}/${path}` });
    }
    return yield* fs(() => file(target).text());
  });

/** Write one file of an extension's own store, creating its directory on demand. */
export const writeExtensionFile = (
  change: Change,
  name: string,
  path: string,
  text: string,
): Effect.Effect<void, BadRequestError | ChangeFormatTooNew> =>
  // Same lock as the record: an extension file belongs to the change directory the archive move
  // renames, so the path and the write must be one step.
  changeRecordLock.withPermits(1)(
    Effect.gen(function* () {
      yield* guardFormat(change.id);
      const base = yield* extensionDir(change, name);
      const target = yield* confinedPath(base, path);
      yield* fs(() => mkdir(dirname(target), { recursive: true }));
      yield* fs(() => write(target, text));
    }),
  );

/** Replace one extension's entry in the change's `extensions` bag and write change.json once.
 * `undefined` removes the entry, matching the wizard's "nothing picked" payload.
 *
 * The merge happens inside the record lock, onto the record as it stands there — never onto the
 * `change` the caller passed, which can be older than another contribution's write. Two updates
 * therefore both land, each on the other's bag entries; the only failure is a record that is
 * missing or cannot be read, where there is nothing to merge onto. */
export const setExtensionData = (
  change: Change,
  name: string,
  data: unknown,
): Effect.Effect<Change, ChangeFormatTooNew | DecodeError | NotFoundError> =>
  writeRecord(change, (before) => {
    const current = before.current;
    if (current === null)
      return Effect.fail(before.unreadable ?? new NotFoundError({ message: `no such change: ${change.id}` }));
    const extensions = { ...(current.extensions ?? {}) };
    if (data === undefined) delete extensions[name];
    else extensions[name] = data;
    return Effect.succeed({ ...current, extensions });
  });

/** Move a completed change out of the way, into its workspace's archive root. Its worktrees are
 * gone by then, so nothing but change.json and whatever an extension left beside it travels.
 * A change already in an archive — or one no scope holds — is left alone. */
const directoriesIn = (dir: string): Effect.Effect<string[]> =>
  Effect.tryPromise(() => readdir(dir, { withFileTypes: true })).pipe(
    Effect.map((entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name)),
    Effect.catch(() => Effect.succeed([])), // directory does not exist yet
  );

/** Active changes first, then archived ones, across every scope's roots; both are listed, the
 * archive is not a hiding place. A change whose change.json cannot be read or decoded — one
 * being written mid-list, or one corrupted by hand — is skipped, so one bad file cannot take the
 * whole listing down. The skip is deliberate (a coordinator ruling on the review), and the
 * single change's error still surfaces everywhere that change is asked for by id. */
export const listChanges = (): Effect.Effect<Change[]> =>
  Effect.gen(function* () {
    const listings = yield* Effect.all(
      changePairs().flatMap(({ root, archiveRoot }) => [directoriesIn(root), directoriesIn(archiveRoot)]),
    );
    // A completed change can leave its directory behind — a terminal writing in it, a build
    // dropping target/ into it — while change.json has already moved to the archive. Both names
    // then resolve to the same change, and it must still be listed once.
    const entries = [...new Set(listings.flat())];
    const changes = yield* Effect.forEach(
      entries,
      (name) =>
        readChange(name).pipe(
          Effect.map((c) => (c ? [c] : [])),
          Effect.catch(() => Effect.succeed([] as Change[])),
        ),
      { concurrency: "unbounded" },
    );
    const byId = new Map(changes.flat().map((c) => [c.id, c]));
    return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });

/** Whether a filesystem failure is "the path is not there" — the one read error a strict read
 * treats as "nothing to read" rather than a failure. */
const describeCause = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** The directory names under one root, read strictly: a root that does not exist yet is empty,
 * any other read failure propagates. */
const directoriesInStrict = (dir: string): Effect.Effect<readonly string[], InternalError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      } catch (cause) {
        if (isNotFound(cause)) return [] as string[];
        throw cause;
      }
    },
    catch: (cause) => new InternalError({ message: `cannot read ${dir}: ${describeCause(cause)}` }),
  });

/** One change.json, read strictly: a missing file is `undefined`, any other read failure is an
 * error. */
const readChangeTextStrict = (path: string): Effect.Effect<string | undefined, InternalError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        return await readFile(path, "utf8");
      } catch (cause) {
        if (isNotFound(cause)) return undefined;
        throw cause;
      }
    },
    catch: (cause) => new InternalError({ message: `cannot read ${path}: ${describeCause(cause)}` }),
  });

/** Read one change by id, strictly for the power monitor: an absent change is null, but an
 * unreadable or undecodable change.json propagates instead of reading as "no change". */
const readChangeStrict = (id: string): Effect.Effect<Change | null, DecodeError | InternalError> =>
  Effect.gen(function* () {
    for (const dir of candidatesFor(id)) {
      const text = yield* readChangeTextStrict(join(dir, "change.json"));
      if (text === undefined) continue;
      return yield* decodeChange(text, dir);
    }
    return null;
  });

/** The changes, read strictly for the power monitor: a root, or a `change.json`, that cannot be
 * read is an error rather than "no changes", because a hidden change could hide a working agent
 * and let the countdown run. The dedup and ordering match `listChanges`, and the page's own
 * best-effort listing stays exactly as it is. */
export const listChangesStrict = (): Effect.Effect<Change[], DecodeError | InternalError> =>
  Effect.gen(function* () {
    const listings = yield* Effect.forEach(
      changePairs().flatMap(({ root, archiveRoot }) => [root, archiveRoot]),
      directoriesInStrict,
      { concurrency: "unbounded" },
    );
    const names = [...new Set(listings.flat())];
    const changes = yield* Effect.forEach(names, readChangeStrict, { concurrency: "unbounded" });
    const byId = new Map(
      changes.flatMap((change) => (change === null ? [] : [change])).map((change) => [change.id, change]),
    );
    return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
