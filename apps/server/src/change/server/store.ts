import { join, dirname, isAbsolute, relative, resolve } from "node:path";
import type { Dirent } from "node:fs";
import { readdir, mkdir, rename } from "node:fs/promises";
import { Effect, ParseResult, Schema } from "effect";
import type { Change } from "../../domain/change.ts";
import { FORMAT_VERSION, PLAN_FILE } from "../../domain/change.ts";
import { ChangeId } from "@corvi/contracts/changes";
import { ChangeFormatTooNew } from "@corvi/changes/errors";
import { LegacyChangeRecord, migrateRecord } from "@corvi/changes/legacy";
import { Change as ChangeSchema } from "./schema.ts";
import { BadRequestError, DecodeError, NotFoundError } from "@corvi/contracts/errors";
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
export const changeDir = (change: {
  readonly id: string;
  readonly workspace?: string;
}): string => join(settingsOf(workspaceById(change.workspace)).changesRoot, change.id);

/** Where one change travels to when it is done: its workspace's archive root. */
export const archiveDir = (change: {
  readonly id: string;
  readonly workspace?: string;
}): string => join(settingsOf(workspaceById(change.workspace)).archiveRoot, change.id);

/** File-backed change records and associated documents. */

const fileExists = (path: string): Effect.Effect<boolean> => fs(() => file(path).exists());

/** The change-root files the change module writes for itself. `Changes.readSidecar` refuses
 * these names, so the capability's migration read cannot be turned on the core's own record or
 * journal; a legacy sidecar from a former feature (notes.md) stays reachable. `wt.toml` is
 * deliberately not here any more: Corvi computes the worktree path itself (apps/server/src/vendors/git.ts),
 * so a file left by the days when wt owned it is an ordinary leftover. */
export const CORE_SIDECARS: ReadonlySet<string> = new Set([
  "change.json",
  "completion.json",
  PLAN_FILE,
]);

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

/** The downgrade fence, for the writers that do not hold the record: a change written by a
 * newer Corvi is read but never written, documents and journal included. */
const guardFormat = (id: string): Effect.Effect<void, ChangeFormatTooNew> =>
  Effect.gen(function* () {
    const dir = yield* existingDir(id);
    const text = dir
      ? yield* fs(() => file(join(dir, "change.json")).text()).pipe(
          Effect.catchAllDefect(() => Effect.succeed("")),
        )
      : "";
    const raw = yield* Schema.decodeUnknown(Schema.parseJson(Schema.Record({ key: Schema.String, value: Schema.Unknown })))(
      text,
    ).pipe(Effect.orElseSucceed(() => ({}) as Record<string, unknown>));
    const recordFormat = typeof raw.formatVersion === "number" ? raw.formatVersion : 1;
    if (recordFormat > FORMAT_VERSION)
      return yield* new ChangeFormatTooNew({
        changeId: ChangeId.make(id),
        recordFormat,
        appFormat: FORMAT_VERSION,
        message:
          `change ${id} was written by a newer version of Corvi ` +
          `(record format ${recordFormat}, this one writes ${FORMAT_VERSION}); upgrade to edit it`,
      });
  });

// Decode with unknown keys preserved: a change.json carries whatever the code that wrote it
// put there, and rewriting it must not drop fields another version added. A format-1 record is
// projected to format 2 first (the one migration), so the schema only ever describes the
// current shape. Failures become DecodeError with the ParseResult issues rendered one line per
// problem, path included.
const decodeChange = (text: string, dir: string): Effect.Effect<Change, DecodeError> =>
  Effect.gen(function* () {
    const raw = yield* Schema.decodeUnknown(
      Schema.parseJson(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
    )(text).pipe(
      Effect.mapError(() => new DecodeError({ source: "file", message: `malformed change.json in ${dir}` })),
    );
    const recordFormat = typeof raw.formatVersion === "number" ? raw.formatVersion : 1;
    const value = recordFormat >= FORMAT_VERSION ? raw : migrateRecord(raw);
    return yield* Schema.decodeUnknown(ChangeSchema, { onExcessProperty: "preserve" })(value).pipe(
      Effect.mapError((error) => {
        const detail = ParseResult.ArrayFormatter.formatIssueSync(error.issue)
          .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
          .join("; ");
        return new DecodeError({ source: "file", message: `malformed change.json in ${dir}: ${detail}` });
      }),
    );
  });

/** Read one change's change.json through its Schema. `null` means no change.json in the change
 * directory or the archive. A malformed or wrongly-shaped file is a typed DecodeError. A
 * format-1 record is migrated and persisted here — atomically, so no record is ever
 * half-migrated; a persist that fails anyway is reported and never fatal, because the read
 * itself succeeded and the startup sweep will try again. */
export const readChange = (id: string): Effect.Effect<Change | null, DecodeError> =>
  Effect.gen(function* () {
    const dir = yield* existingDir(id);
    if (!dir) return null;
    const text = yield* Effect.tryPromise(() => file(join(dir, "change.json")).text()).pipe(
      Effect.orDie,
    );
    const raw = yield* Schema.decodeUnknown(
      Schema.parseJson(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
    )(text).pipe(
      Effect.mapError(() => new DecodeError({ source: "file", message: `malformed change.json in ${dir}` })),
    );
    const recordFormat = typeof raw.formatVersion === "number" ? raw.formatVersion : 1;
    if (recordFormat < FORMAT_VERSION) {
      const migrated = migrateRecord(raw);
      yield* fs(() => writeAtomic(join(dir, "change.json"), JSON.stringify(migrated, null, 2) + "\n")).pipe(
        Effect.catchAllDefect((error) =>
          Effect.sync(() => console.error(`could not migrate change.json in ${dir}:`, error)),
        ),
      );
    }
    return yield* decodeChange(text, dir);
  });

/** The downgrade fence (see `guardFormat`): this writer holds the record, so it can read the
 * version off the value it is about to write. */
export const writeChange = (change: Change): Effect.Effect<void, ChangeFormatTooNew> =>
  Effect.gen(function* () {
    const recordFormat = change.formatVersion ?? FORMAT_VERSION;
    if (recordFormat > FORMAT_VERSION)
      return yield* new ChangeFormatTooNew({
        changeId: ChangeId.make(change.id),
        recordFormat,
        appFormat: FORMAT_VERSION,
        message:
          `change ${change.id} was written by a newer version of Corvi ` +
          `(record format ${recordFormat}, this one writes ${FORMAT_VERSION}); upgrade to edit it`,
      });
    const dir = (yield* existingDir(change.id)) ?? changeDir(change);
    yield* fs(() => mkdir(dir, { recursive: true }));
    // The record's revision moves on every write, whichever store writes it: the lifecycle's
    // optimistic check compares it, so an edit that lands between a transition's read and its
    // write makes that transition conflict rather than overwrite the edit. The revision on disk
    // is authoritative; a fresh record starts at 1.
    const prior = yield* readChange(change.id).pipe(
      Effect.map((current) => Number((current as { revision?: unknown } | null)?.revision ?? 0)),
      Effect.catchAll(() =>
        Effect.succeed(Number((change as { revision?: unknown }).revision ?? 0)),
      ),
    );
    const record = { ...change, revision: prior + 1, formatVersion: FORMAT_VERSION };
    yield* fs(() => writeAtomic(join(dir, "change.json"), JSON.stringify(record, null, 2) + "\n"));
  });

/** A file beside change.json — notes, completion progress — which therefore travels into the
 * archive with it. Read from wherever the change currently lives. A missing or unreadable
 * sidecar reads as empty, which is what `.catch(() => "")` did. */
export const readSidecar = (id: string, name: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    const dir = yield* existingDir(id);
    if (!dir) return "";
    return yield* fs(() => file(join(dir, name)).text()).pipe(
      Effect.catchAllDefect(() => Effect.succeed("")),
    );
  });


export const writeSidecar = (id: string, name: string, text: string): Effect.Effect<void, ChangeFormatTooNew> =>
  Effect.gen(function* () {
    yield* guardFormat(id);
    const dir = (yield* existingDir(id)) ?? changeDir({ id });
    yield* fs(() => mkdir(dir, { recursive: true }));
    yield* fs(() => write(join(dir, name), text));
  });

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
          Effect.catchAllDefect(() => Effect.succeed([] as Dirent[])),
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
  Effect.gen(function* () {
    yield* guardFormat(change.id);
    const base = yield* extensionDir(change, name);
    const target = yield* confinedPath(base, path);
    yield* fs(() => mkdir(dirname(target), { recursive: true }));
    yield* fs(() => write(target, text));
  });

/** Replace one extension's entry in the change's `extensions` bag and write change.json once.
 * `undefined` removes the entry, matching the wizard's "nothing picked" payload.
 *
 * The current change is re-read inside the effect and the entry is merged onto it, not onto the
 * `change` the caller passed: cards and contributions run concurrently, and a caller's snapshot
 * can be older than another contribution's write. Merging on the latest value is what keeps two
 * updates in the same window from clobbering each other's bag entries. */
export const setExtensionData = (
  change: Change,
  name: string,
  data: unknown,
): Effect.Effect<Change, ChangeFormatTooNew | DecodeError> =>
  Effect.gen(function* () {
    const current = (yield* readChange(change.id)) ?? change;
    const extensions = { ...(current.extensions ?? {}) };
    if (data === undefined) delete extensions[name];
    else extensions[name] = data;
    const updated: Change = { ...current, extensions };
    yield* writeChange(updated);
    return updated;
  });

/** Move a completed change out of the way, into its workspace's archive root. Its worktrees are
 * gone by then, so nothing but change.json and whatever an extension left beside it travels.
 * A change already in an archive — or one no scope holds — is left alone. */
export const archiveChange = (id: string): Effect.Effect<void, ChangeFormatTooNew> =>
  Effect.gen(function* () {
    const dir = yield* existingDir(id);
    if (!dir) return;
    const pairs = changePairs();
    // The active copies win the lookup; reaching here under an archive root means it moved.
    if (!pairs.some(({ root }) => dir === join(root, id))) return;
    yield* guardFormat(id);
    const change = yield* readChange(id).pipe(Effect.catchAll(() => Effect.succeed(null)));
    const target = change ? archiveDir(change) : join(archiveRoot(), id);
    yield* fs(() => mkdir(dirname(target), { recursive: true }));
    yield* fs(() => rename(dir, target));
  });

const directoriesIn = (dir: string): Effect.Effect<string[]> =>
  Effect.tryPromise(() => readdir(dir, { withFileTypes: true })).pipe(
    Effect.map((entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name)),
    Effect.catchAll(() => Effect.succeed([])), // directory does not exist yet
  );

/** Active changes first, then archived ones, across every scope's roots; both are listed, the
 * archive is not a hiding place. A change whose change.json cannot be read or decoded — one
 * being written mid-list, or one corrupted by hand — is skipped, so one bad file cannot take the
 * whole listing down. The skip is deliberate (a coordinator ruling on the review), and the
 * single change's error still surfaces everywhere that change is asked for by id. */
export const listChanges = (): Effect.Effect<Change[]> =>
  Effect.gen(function* () {
    const listings = yield* Effect.all(
      changePairs().flatMap(({ root, archiveRoot }) => [
        directoriesIn(root),
        directoriesIn(archiveRoot),
      ]),
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
          Effect.catchAll(() => Effect.succeed([] as Change[])),
        ),
      { concurrency: "unbounded" },
    );
    const byId = new Map(changes.flat().map((c) => [c.id, c]));
    return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
