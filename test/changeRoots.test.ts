import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveChange,
  changeDir,
  createChange,
  listChanges,
  readChange,
} from "../apps/server/src/change/server/index.ts";
import { runEffect, withRuntimeConfig, type RuntimeConfigPatch } from "./helpers.ts";

/**
 * The change store spans every scope's roots: each workspace's changesRoot/archiveRoot holds
 * its own changes, lookup and listing scan them all, and the rules are the plan's — a new change
 * is created in its workspace's root (the first workspace's, when the record names none), ids
 * are unique across every root, and a change travels to its workspace's archive root when done,
 * wherever it was made.
 */
let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "corvi-change-roots-"));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const roots = (): RuntimeConfigPatch => ({
  changesRoot: join(tmp, "changes"),
  archiveRoot: join(tmp, "archive"),
  workspaces: [
    {
      id: "client",
      name: "Client",
      settings: {
        changesRoot: join(tmp, "client-changes"),
        archiveRoot: join(tmp, "client-archive"),
      },
    },
    { id: "own", name: "Own" },
  ],
});

test("each workspace's root holds its own changes, and lookup spans them all", async () => {
  // CORVI_ROOT and CORVI_ARCHIVE_ROOT win at every scope by design, and the suite sets them:
  // put them aside so the workspaces' roots are the ones being tested.
  const env = { root: process.env.CORVI_ROOT, archive: process.env.CORVI_ARCHIVE_ROOT };
  delete process.env.CORVI_ROOT;
  delete process.env.CORVI_ARCHIVE_ROOT;
  try {
    await withRuntimeConfig(roots(), async () => {
      // A change is created in its workspace's root…
      const mine = await runEffect(
        createChange({ id: "ROOT-CLIENT", state: "Ideation", workspace: "client" }),
      );
      expect(changeDir(mine)).toBe(join(tmp, "client-changes", "ROOT-CLIENT"));
      await expect(
        Bun.file(join(tmp, "client-changes", "ROOT-CLIENT", "change.json")).exists(),
      ).resolves.toBe(true);

      // …and one without a workspace lands in the first workspace's root, where it belongs.
      const first = await runEffect(createChange({ id: "ROOT-FIRST", state: "Ideation" }));
      expect(changeDir(first)).toBe(join(tmp, "client-changes", "ROOT-FIRST"));

      // A workspace that names no roots uses the global level's.
      const global = await runEffect(
        createChange({ id: "ROOT-OWN", state: "Ideation", workspace: "own" }),
      );
      expect(changeDir(global)).toBe(join(tmp, "changes", "ROOT-OWN"));

      // Every root is listed and read: one lookup across all of them.
      const listed = (await runEffect(listChanges())).map((c) => c.id);
      expect(listed).toContain("ROOT-CLIENT");
      expect(listed).toContain("ROOT-FIRST");
      expect(listed).toContain("ROOT-OWN");
      expect((await runEffect(readChange("ROOT-CLIENT")))?.id).toBe("ROOT-CLIENT");
      expect((await runEffect(readChange("ROOT-OWN")))?.id).toBe("ROOT-OWN");

      // An id is taken across every root: the same id in another workspace's root is refused.
      await expect(
        runEffect(createChange({ id: "ROOT-OWN", state: "Ideation", workspace: "client" })),
      ).rejects.toThrow(/already exists/);

      // A change that predates a root override stays where it is: lookup finds it by scanning,
      // and it still travels to its workspace's archive root when it is done.
      await runEffect(createChange({ id: "ROOT-OLD", state: "Ideation", workspace: "client" }));
      await Bun.write(
        join(tmp, "changes", "ROOT-OLD", "change.json"),
        JSON.stringify({
          id: "ROOT-OLD",
          branch: "ROOT-OLD",
          workspace: "client",
          state: "Ideation",
          createdAt: "2026-01-01T00:00:00.000Z",
          formatVersion: 2,
        }),
      );
      await rm(join(tmp, "client-changes", "ROOT-OLD"), { recursive: true, force: true });
      expect((await runEffect(readChange("ROOT-OLD")))?.id).toBe("ROOT-OLD");

      await runEffect(archiveChange("ROOT-OLD"));
      await expect(
        Bun.file(join(tmp, "client-archive", "ROOT-OLD", "change.json")).exists(),
      ).resolves.toBe(true);
      await expect(Bun.file(join(tmp, "changes", "ROOT-OLD")).exists()).resolves.toBe(false);
    });
  } finally {
    if (env.root === undefined) delete process.env.CORVI_ROOT;
    else process.env.CORVI_ROOT = env.root;
    if (env.archive === undefined) delete process.env.CORVI_ARCHIVE_ROOT;
    else process.env.CORVI_ARCHIVE_ROOT = env.archive;
  }
});
