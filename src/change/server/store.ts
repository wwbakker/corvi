import { join, dirname, isAbsolute, relative, resolve } from "node:path";
import type { Dirent } from "node:fs";
import { readdir, mkdir, rename } from "node:fs/promises";
import { Effect, ParseResult, Schema } from "effect";
import type { Change } from "../../core/domain/change.ts";
import { Change as ChangeSchema } from "./schema.ts";
import { BadRequestError, DecodeError, NotFoundError } from "../../core/platform/effect/errors.ts";
import { fs } from "../../core/platform/effect/support.ts";
import { config } from "../../workspace/server/index.ts";

/** Root of the per-change directories. Override with IWE_ROOT (tests do). */
export const root = (): string => process.env.IWE_ROOT ?? config.changesRoot;

/** Completed changes move here, so the list stays the work in flight. */
export const ARCHIVE = "archive";

export const changeDir = (id: string): string => join(root(), id);
export const archiveDir = (id: string): string => join(root(), ARCHIVE, id);

/** The Effect API. Failures go through the typed taxonomy
 * (docs/guides/effect-conventions.md), each carrying a human-readable message. */

const fileExists = (path: string): Effect.Effect<boolean> => fs(() => Bun.file(path).exists());

/** Active directory if it exists, otherwise the archived one. */
const existingDir = (id: string): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    for (const dir of [changeDir(id), archiveDir(id)]) {
      if (yield* fileExists(join(dir, "change.json"))) return dir;
    }
    return null;
  });

const changeFile = (id: string): string => join(changeDir(id), "change.json");

/** wt user-config for this change, so its worktrees land in the change directory instead of
 * next to their repositories. Passed to every wt invocation with --config.
 *
 * Pure sync path logic; nothing to wrap in an Effect. */
export const wtConfigPath = (id: string): string => join(changeDir(id), "wt.toml");

// Decode with unknown keys preserved: a change.json carries whatever the code that wrote it
// put there, and rewriting it must not drop fields another version added. Failures become
// DecodeError with the ParseResult issues rendered one line per problem, path included.
const decodeChange = (text: string, dir: string): Effect.Effect<Change, DecodeError> =>
  Schema.decodeUnknown(Schema.parseJson(ChangeSchema), { onExcessProperty: "preserve" })(text).pipe(
    Effect.mapError((error) => {
      const detail = ParseResult.ArrayFormatter.formatIssueSync(error.issue)
        .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
        .join("; ");
      return new DecodeError({ source: "file", message: `malformed change.json in ${dir}: ${detail}` });
    }),
  );

/** Read one change's change.json through its Schema. `null` means no change.json in the change
 * directory or the archive. A malformed or wrongly-shaped file is a typed DecodeError (see
 * docs/guides/effect-conventions.md). */
export const readChange = (id: string): Effect.Effect<Change | null, DecodeError> =>
  Effect.gen(function* () {
    const dir = yield* existingDir(id);
    if (!dir) return null;
    const text = yield* Effect.tryPromise(() => Bun.file(join(dir, "change.json")).text()).pipe(
      Effect.orDie,
    );
    return yield* decodeChange(text, dir);
  });

export const writeChange = (change: Change): Effect.Effect<void> =>
  Effect.gen(function* () {
    const dir = (yield* existingDir(change.id)) ?? changeDir(change.id);
    yield* fs(() => mkdir(dir, { recursive: true }));
    yield* fs(() => Bun.write(join(dir, "change.json"), JSON.stringify(change, null, 2) + "\n"));
  });

/** A file beside change.json — notes, completion progress — which therefore travels into the
 * archive with it. Read from wherever the change currently lives. A missing or unreadable
 * sidecar reads as empty, which is what `.catch(() => "")` did. */
export const readSidecar = (id: string, name: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    const dir = yield* existingDir(id);
    if (!dir) return "";
    return yield* fs(() => Bun.file(join(dir, name)).text()).pipe(
      Effect.catchAllDefect(() => Effect.succeed("")),
    );
  });


export const writeSidecar = (id: string, name: string, text: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const dir = (yield* existingDir(id)) ?? changeDir(id);
    yield* fs(() => mkdir(dir, { recursive: true }));
    yield* fs(() => Bun.write(join(dir, name), text));
  });

/** Where one extension's files live inside a change: `extensions/<name>/`, resolved through
 * the change's current directory so they travel into the archive with it. Not created here;
 * writing creates it on demand. */
const extensionDir = (change: Change, name: string): Effect.Effect<string> =>
  Effect.map(existingDir(change.id), (dir) => join(dir ?? changeDir(change.id), "extensions", name));

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
    return yield* fs(() => Bun.file(target).text());
  });

/** Write one file of an extension's own store, creating its directory on demand. */
export const writeExtensionFile = (
  change: Change,
  name: string,
  path: string,
  text: string,
): Effect.Effect<void, BadRequestError> =>
  Effect.gen(function* () {
    const base = yield* extensionDir(change, name);
    const target = yield* confinedPath(base, path);
    yield* fs(() => mkdir(dirname(target), { recursive: true }));
    yield* fs(() => Bun.write(target, text));
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
): Effect.Effect<Change, DecodeError> =>
  Effect.gen(function* () {
    const current = (yield* readChange(change.id)) ?? change;
    const extensions = { ...(current.extensions ?? {}) };
    if (data === undefined) delete extensions[name];
    else extensions[name] = data;
    const updated: Change = { ...current, extensions };
    yield* writeChange(updated);
    return updated;
  });

/** Move a completed change out of the way. Its worktrees are gone by then, so nothing but
 * change.json and the wt config travels. */
export const archiveChange = (id: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (!(yield* fileExists(changeFile(id)))) return; // already archived
    yield* fs(() => mkdir(join(root(), ARCHIVE), { recursive: true }));
    yield* fs(() => rename(changeDir(id), archiveDir(id)));
  });

const directoriesIn = (dir: string): Effect.Effect<string[]> =>
  Effect.tryPromise(() => readdir(dir, { withFileTypes: true })).pipe(
    Effect.map((entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name)),
    Effect.catchAll(() => Effect.succeed([])), // directory does not exist yet
  );

/** Active changes first, then archived ones; both are listed, the archive is not a hiding place.
 * A change whose change.json cannot be read or decoded — one being written mid-list, or one
 * corrupted by hand — is skipped, so one bad file cannot take the whole listing down. The skip
 * is deliberate (a coordinator ruling on the review), and the single change's error still
 * surfaces everywhere that change is asked for by id. */
export const listChanges = (): Effect.Effect<Change[]> =>
  Effect.gen(function* () {
    const [active, archived] = yield* Effect.all([
      directoriesIn(root()),
      directoriesIn(join(root(), ARCHIVE)),
    ]);
    // A completed change can leave its directory behind — a terminal writing in it, a build
    // dropping target/ into it — while change.json has already moved to the archive. Both names
    // then resolve to the same change, and it must still be listed once.
    const entries = [...new Set([...active.filter((name) => name !== ARCHIVE), ...archived])];
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

export const writeWtConfig = (id: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    const path = wtConfigPath(id);
    if (!(yield* fileExists(path))) {
      const dir = changeDir(id).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
      yield* fs(() => mkdir(changeDir(id), { recursive: true }));
      yield* fs(() => Bun.write(path, `worktree-path = "${dir}/{{ repo }}"\n`));
    }
    return path;
  });
