import { Effect } from "effect";
import { Changes, ExtensionStore, type RouteError } from "../../core/host/api.ts";
import type { Change } from "../../core/domain/change.ts";

/**
 * The notes extension's server half: free text about a change, kept in the extension's own
 * store.
 *
 * The notes live at `extensions/notes/notes.md` through `ExtensionStore`, so the core never
 * touches them. Before this slice they were a `notes.md` sidecar in the change root, and a
 * change that has never been written through the store still reads from there — the one use of
 * the `Changes.readSidecar` migration access. Writing goes to the store alone; the legacy file
 * is left where it was, so the move is readable and nothing is destroyed.
 */

/** The file the notes live in, relative to the extension's own directory. */
const FILE = "notes.md";

/**
 * The notes for a change: the extension's own file first, and when it does not exist yet the
 * legacy change-root sidecar. A change with neither reads as "".
 */
export const readNotes = (
  change: Change,
): Effect.Effect<string, RouteError, ExtensionStore | Changes> =>
  Effect.gen(function* () {
    const store = yield* ExtensionStore;
    const stored = yield* store.read(change, FILE).pipe(
      Effect.catchTag("NotFoundError", () => Effect.succeed(null)),
    );
    if (stored !== null) return stored;
    const changes = yield* Changes;
    return yield* changes.readSidecar(change, FILE);
  });

/** Write the notes to the extension's own store, never the legacy path. */
export const writeNotes = (
  change: Change,
  text: string,
): Effect.Effect<void, RouteError, ExtensionStore> =>
  Effect.gen(function* () {
    const store = yield* ExtensionStore;
    yield* store.write(change, FILE, text);
  });
