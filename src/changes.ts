import { join, basename } from "node:path";
import { readdir, mkdir, rename } from "node:fs/promises";
import { Effect, ParseResult, Schema } from "effect";
import { CHANGE_STATES, isFinished, type Change, type ChangeState } from "./types.ts";
import { Change as ChangeSchema } from "./schemas/change.ts";
import { BadRequestError, ConflictError, DecodeError } from "./effect/errors.ts";
import { config } from "./config.ts";
export { branchFor } from "./branch.ts";

/** Root of the per-change directories. Override with IWE_ROOT (tests do). */
export const root = (): string => process.env.IWE_ROOT ?? config.changesRoot;

/** Completed changes move here, so the list stays the work in flight. */
export const ARCHIVE = "archive";

export const changeDir = (id: string): string => join(root(), id);
export const archiveDir = (id: string): string => join(root(), ARCHIVE, id);

/** The Effect API beneath the Promise facades below. Where the old code threw, the Effect fails
 * with the typed taxonomy (docs/effect-conventions.md) carrying the same message; the facades
 * keep old callers compiling until the server-wiring task sweeps them. */

/** Filesystem failures are defects, not domain errors — the directories we read and write are
 * ours, and the old code let the raw rejection escape the same way. */
const fs = <A>(work: () => Promise<A>): Effect.Effect<A> =>
  Effect.orDie(Effect.tryPromise(work));

const fileExists = (path: string): Effect.Effect<boolean> => fs(() => Bun.file(path).exists());

/** Active directory if it exists, otherwise the archived one. */
const existingDirEffect = (id: string): Effect.Effect<string | null> =>
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
// DecodeError with the ParseResult issues rendered the way the old raw parse error would have
// been shown: one line per problem, path included.
const decodeChange = (text: string, dir: string): Effect.Effect<Change, DecodeError> =>
  Schema.decodeUnknown(Schema.parseJson(ChangeSchema), { onExcessProperty: "preserve" })(text).pipe(
    Effect.mapError((error) => {
      const detail = ParseResult.ArrayFormatter.formatIssueSync(error.issue)
        .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
        .join("; ");
      return new DecodeError({ source: "file", message: `malformed change.json in ${dir}: ${detail}` });
    }),
  );

/** Read one change's change.json through its Schema. `null` where the old code returned null:
 * no change.json in the change directory or the archive. A malformed or wrongly-shaped file —
 * which the old code handed back untyped or rejected with a raw parse error — is now a typed
 * DecodeError (sanctioned change; see docs/effect-conventions.md). */
export const readChangeEffect = (id: string): Effect.Effect<Change | null, DecodeError> =>
  Effect.gen(function* () {
    const dir = yield* existingDirEffect(id);
    if (!dir) return null;
    const text = yield* Effect.tryPromise(() => Bun.file(join(dir, "change.json")).text()).pipe(
      Effect.orDie,
    );
    return yield* decodeChange(text, dir);
  });

/** Promise facade over readChangeEffect, in the old signature. Kept for the test suite, which
 * must pass unmodified; the server uses readChangeEffect directly. */
export const readChange = (id: string): Promise<Change | null> =>
  Effect.runPromise(readChangeEffect(id));

/**
 * The two fields you may edit by hand: what a change is called, and where it stands.
 *
 * Here rather than in the route, so what is allowed can be tested without a server — and so the
 * one rule that matters is stated once: a change ends by being completed or cancelled, which
 * merge, remove worktrees and archive. Setting the word by hand would do none of that and claim
 * it had happened.
 *
 * Purely synchronous, so no Effect wrapper: the validation throws the typed taxonomy
 * (BadRequestError / ConflictError — both Errors, exactly where the old code threw plain
 * Errors), with the exact messages it always had.
 *
 * Sync; throws typed errors instead of plain Errors — the server route converts those throws
 * into failures at the boundary (Effect.try), exactly where the old route caught them.
 */
export function applyPatch(change: Change, patch: { state?: string; title?: string }): Change {
  if (patch.state && !CHANGE_STATES.includes(patch.state as ChangeState)) {
    throw new BadRequestError({ message: `unknown state: ${patch.state}` });
  }
  if (patch.state && isFinished({ ...change, state: patch.state as ChangeState })) {
    throw new ConflictError({
      message: `${patch.state} is what completing or cancelling a change sets`,
    });
  }
  const title = patch.title?.trim();
  return {
    ...change,
    state: (patch.state as ChangeState) ?? change.state,
    // An empty title hands the name back to the ticket; anything else is yours to keep.
    ...(patch.title === undefined
      ? {}
      : title
        ? { title, titleEdited: true }
        : { title: undefined, titleEdited: undefined }),
  };
}

export const writeChangeEffect = (change: Change): Effect.Effect<void> =>
  Effect.gen(function* () {
    const dir = (yield* existingDirEffect(change.id)) ?? changeDir(change.id);
    yield* fs(() => mkdir(dir, { recursive: true }));
    yield* fs(() => Bun.write(join(dir, "change.json"), JSON.stringify(change, null, 2) + "\n"));
  });

/** Promise facade over writeChangeEffect, in the old signature. Kept for the test suite, which
 * must pass unmodified. */
export const writeChange = (change: Change): Promise<void> =>
  Effect.runPromise(writeChangeEffect(change));

/** A file beside change.json — notes, completion progress — which therefore travels into the
 * archive with it. Read from wherever the change currently lives. A missing or unreadable
 * sidecar reads as empty, which is what `.catch(() => "")` did. */
export const readSidecarEffect = (id: string, name: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    const dir = yield* existingDirEffect(id);
    if (!dir) return "";
    return yield* fs(() => Bun.file(join(dir, name)).text()).pipe(
      Effect.catchAllDefect(() => Effect.succeed("")),
    );
  });


export const writeSidecarEffect = (id: string, name: string, text: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const dir = (yield* existingDirEffect(id)) ?? changeDir(id);
    yield* fs(() => mkdir(dir, { recursive: true }));
    yield* fs(() => Bun.write(join(dir, name), text));
  });

/** Promise facade over writeSidecarEffect, in the old signature. Kept for the test suite,
 * which must pass unmodified. */
export const writeSidecar = (id: string, name: string, text: string): Promise<void> =>
  Effect.runPromise(writeSidecarEffect(id, name, text));


/** Free-text notes, kept beside change.json so they travel into the archive with it. */
export const readNotesEffect = (id: string): Effect.Effect<string> =>
  readSidecarEffect(id, "notes.md");
export const writeNotesEffect = (id: string, text: string): Effect.Effect<void> =>
  writeSidecarEffect(id, "notes.md", text);

/** Promise facades over the notes effects, in the old signatures. Kept for the test suite,
 * which must pass unmodified; the server uses the effects directly. */
export const readNotes = (id: string): Promise<string> => Effect.runPromise(readNotesEffect(id));
export const writeNotes = (id: string, text: string): Promise<void> =>
  Effect.runPromise(writeNotesEffect(id, text));

/** Move a completed change out of the way. Its worktrees are gone by then, so nothing but
 * change.json and the wt config travels. */
export const archiveChangeEffect = (id: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (!(yield* fileExists(changeFile(id)))) return; // already archived
    yield* fs(() => mkdir(join(root(), ARCHIVE), { recursive: true }));
    yield* fs(() => rename(changeDir(id), archiveDir(id)));
  });

/** Promise facade over archiveChangeEffect, in the old signature. Kept for the test suite,
 * which must pass unmodified. */
export const archiveChange = (id: string): Promise<void> =>
  Effect.runPromise(archiveChangeEffect(id));

const directoriesIn = (dir: string): Effect.Effect<string[]> =>
  Effect.tryPromise(() => readdir(dir, { withFileTypes: true })).pipe(
    Effect.map((entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name)),
    Effect.catchAll(() => Effect.succeed([])), // directory does not exist yet
  );

/** Active changes first, then archived ones; both are listed, the archive is not a hiding place.
 * A change whose change.json cannot be read or decoded — one being written mid-list, or one
 * corrupted by hand — is skipped, so one bad file cannot take the whole listing down. The old
 * code threw on a malformed file and failed the whole listing; the skip is deliberate (a
 * coordinator ruling on the review), and the single change's error still surfaces everywhere
 * that change is asked for by id. */
export const listChangesEffect = (): Effect.Effect<Change[]> =>
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
        readChangeEffect(name).pipe(
          Effect.map((c) => (c ? [c] : [])),
          Effect.catchAll(() => Effect.succeed([] as Change[])),
        ),
      { concurrency: "unbounded" },
    );
    const byId = new Map(changes.flat().map((c) => [c.id, c]));
    return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });

/** Promise facade over listChangesEffect, in the old signature. Kept for the test suite and
 * events.ts's stream (both fine as Promises); the server uses the effect directly. */
export const listChanges = (): Promise<Change[]> => Effect.runPromise(listChangesEffect());

export const writeWtConfigEffect = (id: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    const path = wtConfigPath(id);
    if (!(yield* fileExists(path))) {
      const dir = changeDir(id).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
      yield* fs(() => mkdir(changeDir(id), { recursive: true }));
      yield* fs(() => Bun.write(path, `worktree-path = "${dir}/{{ repo }}"\n`));
    }
    return path;
  });


export const createChangeEffect = (input: {
  id: string;
  branch?: string;
  repos?: string[];
  direct?: string[];
  base?: Record<string, string>;
  jira?: string;
  /** Extensions' own data about the change, keyed by extension name — what the wizard's
   * extension steps picked. Stored verbatim on the change; the core never looks inside. */
  extensions?: Record<string, unknown>;
  workspace?: string;
}): Effect.Effect<Change, BadRequestError | ConflictError | DecodeError> =>
  Effect.gen(function* () {
    const id = input.id.trim();
    if (!id || id !== basename(id) || id.startsWith(".")) {
      yield* Effect.fail(new BadRequestError({ message: `invalid change id: ${input.id}` }));
    }
    if (yield* readChangeEffect(id)) {
      yield* Effect.fail(new ConflictError({ message: `change already exists: ${id}` }));
    }
    const repos = (input.repos ?? []).map((r) => r.trim()).filter(Boolean);
    if (repos.length === 0) {
      yield* Effect.fail(new BadRequestError({ message: "select at least one repository" }));
    }
    const change: Change = {
      id,
      branch: input.branch?.trim() || id,
      repos,
      direct: input.direct?.filter((r) => repos.includes(r)),
      base: input.base,
      jira: input.jira?.trim() || undefined,
      extensions: input.extensions,
      // The context it was made in. Unknown means the first workspace, which is what every change
      // made before this belongs to.
      workspace: input.workspace?.trim() || undefined,
      state: "In Progress",
      createdAt: new Date().toISOString(),
    };
    yield* writeChangeEffect(change);
    yield* writeWtConfigEffect(id);
    return change;
  });

/** Promise facade over createChangeEffect, in the old signature. Kept for the test suite,
 * which must pass unmodified; the server uses the effect directly. */
export const createChange = (input: {
  id: string;
  branch?: string;
  repos?: string[];
  direct?: string[];
  base?: Record<string, string>;
  jira?: string;
  extensions?: Record<string, unknown>;
  workspace?: string;
}): Promise<Change> => Effect.runPromise(createChangeEffect(input));
