import { test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { ExtensionStore } from "../src/core/host/api.ts";
import {
  afterChange,
  applyCreatingHooks,
  beforeChange,
  install,
  loaded,
  provision,
} from "../src/core/host/index.ts";
import { extensionStoreLayer } from "../src/core/host/services.ts";
import { archiveChange, changeDir, createChange, readChange } from "../src/change/server/index.ts";
import { BadRequestError, ConflictError } from "../src/core/platform/effect/errors.ts";
import { config } from "../src/workspace/server/index.ts";
import type { Change, Change as ChangeShape } from "../src/core/domain/change.ts";
import { runEffect, TestError } from "./helpers.ts";

/**
 * The lifecycle event pairs and the single-writer `ExtensionStore`: creation's before-hook that
 * transforms a draft (and is re-validated by the core), the before-hooks that veto completing and
 * cancelling, the after-hooks that report but never fail, and the namespaced files an extension
 * keeps inside a change.
 */

let tmp: string;
const savedWorkspaces = config.workspaces;
let savedLoaded: typeof loaded = [];

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "iwe-lifecycle-"));
  process.env.IWE_ROOT = join(tmp, "changes");
  // Enablement is the workspace's own list; naming none means every loaded extension applies, so
  // this workspace exercises the default answer and lets the stubs below be the only contributors.
  config.workspaces = [{ id: "test", name: "test" }];
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
  config.workspaces = savedWorkspaces;
});

// Each test starts from the registry the host loaded and restores it after: the built-in
// extensions would otherwise provision worktrees and move tickets during these tests.
beforeEach(() => {
  savedLoaded = loaded.splice(0, loaded.length);
});

afterEach(() => {
  loaded.splice(0, loaded.length, ...savedLoaded);
});

/** Run a store effect with the extension's name bound, exactly as the host binds it. */
const runStore = <A, E>(
  name: string,
  effect: Effect.Effect<A, E, ExtensionStore>,
): Promise<A> => Effect.runPromise(Effect.provide(effect, extensionStoreLayer(name)));

const drafted = (id: string): ChangeShape => ({
  id,
  branch: id,
  repos: [],
  createdAt: new Date().toISOString(),
});

test("a change:creating hook transforms the draft and the change is written with the patch", async () => {
  install({
    name: "rename",
    title: "Rename",
    events: {
      "change:creating": [
        (draft) => Effect.succeed({ id: `${draft.id}-x`, branch: `custom-${draft.id}` }),
      ],
    },
  });

  const patched = await runEffect(applyCreatingHooks({ id: "PROJ-1", repos: ["/r"] }));
  expect(patched.id).toBe("PROJ-1-x");
  expect(patched.branch).toBe("custom-PROJ-1");

  const change = await runEffect(createChange(patched));
  expect(change.id).toBe("PROJ-1-x");
  expect(change.branch).toBe("custom-PROJ-1");
  // The core re-runs every invariant on the patched draft and writes what came out.
  expect((await runEffect(readChange("PROJ-1-x")))?.branch).toBe("custom-PROJ-1");
});

test("chained change:creating hooks see each other's patches, in load order", async () => {
  const seen: string[] = [];
  install({
    name: "first",
    title: "First",
    events: {
      "change:creating": [
        (draft) => {
          seen.push(draft.id);
          return Effect.succeed({ branch: `${draft.id}-first` });
        },
      ],
    },
  });
  install({
    name: "second",
    title: "Second",
    events: {
      "change:creating": [
        (draft) => {
          seen.push(draft.branch ?? "");
          return Effect.succeed({ branch: `${draft.branch}-second` });
        },
      ],
    },
  });

  const patched = await runEffect(applyCreatingHooks({ id: "PROJ-2", repos: ["/r"] }));
  expect(seen).toEqual(["PROJ-2", "PROJ-2-first"]);
  expect(patched.branch).toBe("PROJ-2-first-second");
});

test("a creating hook's patch is still re-validated by the core", async () => {
  install({
    name: "suggest",
    title: "Suggest",
    events: {
      "change:creating": [
        (draft) => Effect.succeed(draft.id === "PROJ-9" ? { repos: [] } : { id: "../escape" }),
      ],
    },
  });

  // The hook may suggest an empty repository list; the core still refuses to write it.
  const emptied = await runEffect(applyCreatingHooks({ id: "PROJ-9", repos: ["/r"] }));
  await expect(runEffect(createChange(emptied))).rejects.toThrow("at least one repository");

  const escaped = await runEffect(applyCreatingHooks({ id: "PROJ-10", repos: ["/r"] }));
  await expect(runEffect(createChange(escaped))).rejects.toThrow("invalid change id");
});

test("a failing change:creating hook vetoes the create and the error surfaces", async () => {
  install({
    name: "veto",
    title: "Veto",
    events: {
      "change:creating": [() => Effect.fail(new TestError({ message: "no changes today" }))],
    },
  });

  await expect(runEffect(applyCreatingHooks({ id: "PROJ-3", repos: ["/r"] }))).rejects.toThrow(
    "no changes today",
  );
  // A veto happens before the core writes anything.
  expect(await runEffect(readChange("PROJ-3"))).toBeNull();
});

test("a failing before-hook vetoes completing and cancelling", async () => {
  install({
    name: "veto-before",
    title: "Veto",
    events: {
      "change:completing": [() => Effect.fail(new BadRequestError({ message: "not yet" }))],
      "change:cancelling": [() => Effect.fail(new ConflictError({ message: "hold on" }))],
    },
  });
  const change = drafted("PROJ-8");

  await expect(runEffect(beforeChange("change:completing", change))).rejects.toThrow("not yet");
  await expect(runEffect(beforeChange("change:cancelling", change))).rejects.toThrow("hold on");
});

test("a failing after-hook is reported under the extension's name and never fails the operation", async () => {
  install({
    name: "after",
    title: "After",
    events: {
      "change:created": [() => Effect.fail(new TestError({ message: "created boom" }))],
      "change:completed": [() => Effect.fail(new TestError({ message: "completed boom" }))],
      "change:cancelled": [() => Effect.fail(new TestError({ message: "cancelled boom" }))],
    },
  });
  const change = drafted("PROJ-4");

  // The results are values, not a failed effect: the change is already committed, so the
  // operation succeeded and what went wrong is attributable to the extension that did it.
  expect(await runEffect(provision(change))).toEqual([
    { integration: "after", ok: false, error: "created boom" },
  ]);
  expect(await runEffect(afterChange("change:completed", change))).toEqual([
    { integration: "after", ok: false, error: "completed boom" },
  ]);
  expect(await runEffect(afterChange("change:cancelled", change))).toEqual([
    { integration: "after", ok: false, error: "cancelled boom" },
  ]);
});

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
