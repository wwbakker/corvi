import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { ExtensionStore } from "../src/integrations/types.ts";
import { extensionStoreLayer } from "../src/extension-host/services.ts";
import { archiveChange, changeDir, createChange, readChange } from "../src/change/server/index.ts";
import { config } from "../src/workspace/server/index.ts";
import type { Change } from "../src/domain/change.ts";
import { runEffect } from "./helpers.ts";

/**
 * The single-writer `ExtensionStore`: the namespaced files and the bag entry an extension
 * keeps inside a change, resolved through the change's current location.
 */

let tmp: string;
const savedWorkspaces = config.workspaces;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "corvi-extension-store-"));
  process.env.CORVI_ROOT = join(tmp, "changes");
  process.env.CORVI_ARCHIVE_ROOT = join(tmp, "changes-archive");
  config.workspaces = [{ id: "test", name: "test" }];
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
  config.workspaces = savedWorkspaces;
});

/** Run a store effect with the extension's name bound, exactly as the host binds it. */
const runStore = <A, E>(
  name: string,
  effect: Effect.Effect<A, E, ExtensionStore>,
): Promise<A> => Effect.runPromise(Effect.provide(effect, extensionStoreLayer(name)));

test("ExtensionStore.update replaces the extension's bag entry and leaves the rest of change.json intact", async () => {
  const change = await runEffect(
    createChange({
      id: "PROJ-5",
      repos: ["/r"],
      extensions: { keep: { a: 1 }, mine: { old: true } },
    }),
  );

  const updated = await runStore(
    "mine",
    Effect.gen(function* () {
      const store = yield* ExtensionStore;
      return yield* store.update(change, { fresh: true });
    }),
  );
  expect(updated.extensions).toEqual({ keep: { a: 1 }, mine: { fresh: true } });

  const onDisk = (await runEffect(readChange("PROJ-5")))!;
  expect(onDisk.extensions).toEqual({ keep: { a: 1 }, mine: { fresh: true } });
  // Everything the store does not own is exactly as it was.
  expect(onDisk.branch).toBe(change.branch);
  expect(onDisk.createdAt).toBe(change.createdAt);
  expect(onDisk.repos).toEqual(["/r"]);
});

test("two updates through separate ExtensionStore layers both survive", async () => {
  const change = await runEffect(
    createChange({
      id: "PROJ-5b",
      repos: ["/r"],
      extensions: { keep: { a: 1 } },
    }),
  );

  // Both stores are handed the same snapshot, as two concurrent contributions would each hold
  // the change they were given. The store merges onto the current file, not onto that snapshot,
  // so the second write cannot erase the first contribution's entry.
  await runStore(
    "first",
    Effect.gen(function* () {
      const store = yield* ExtensionStore;
      yield* store.update(change, { one: true });
    }),
  );
  await runStore(
    "second",
    Effect.gen(function* () {
      const store = yield* ExtensionStore;
      yield* store.update(change, { two: true });
    }),
  );

  const onDisk = (await runEffect(readChange("PROJ-5b")))!;
  expect(onDisk.extensions).toEqual({
    keep: { a: 1 },
    first: { one: true },
    second: { two: true },
  });
});

test("store files land under extensions/<name>/ and are still readable after the change is archived", async () => {
  const change = await runEffect(createChange({ id: "PROJ-6", repos: ["/r"] }));

  await runStore(
    "mine",
    Effect.gen(function* () {
      const store = yield* ExtensionStore;
      yield* store.write(change, "notes/one.md", "hello");
    }),
  );

  // On disk under the change's own directory, not the change root.
  expect(
    await Bun.file(join(changeDir("PROJ-6"), "extensions", "mine", "notes", "one.md")).text(),
  ).toBe("hello");

  expect(
    await runStore(
      "mine",
      Effect.gen(function* () {
        const store = yield* ExtensionStore;
        return yield* store.list(change);
      }),
    ),
  ).toEqual(["notes/one.md"]);

  await runEffect(archiveChange("PROJ-6"));

  // The change's current location moved, and the store resolves through it, so the same read
  // still finds the file in the archive rather than failing on the old path.
  expect(
    await runStore(
      "mine",
      Effect.gen(function* () {
        const store = yield* ExtensionStore;
        return yield* store.read(change, "notes/one.md");
      }),
    ),
  ).toBe("hello");
});

test("ExtensionStore rejects a path that escapes the extension's directory", async () => {
  const change: Change = await runEffect(createChange({ id: "PROJ-7", repos: ["/r"] }));

  await expect(
    runStore(
      "mine",
      Effect.gen(function* () {
        const store = yield* ExtensionStore;
        yield* store.write(change, "../change.json", "hacked");
      }),
    ),
  ).rejects.toThrow(/escapes its directory/);

  await expect(
    runStore(
      "mine",
      Effect.gen(function* () {
        const store = yield* ExtensionStore;
        return yield* store.read(change, "../../change.json");
      }),
    ),
  ).rejects.toThrow(/escapes its directory/);
});
