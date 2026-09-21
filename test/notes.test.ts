import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  archiveChange,
  archiveDir,
  changeDir,
  createChange,
  readSidecar,
  writeSidecar,
} from "../src/change/server/index.ts";
import { dispatchExtensionRoute, widgetsFor } from "../src/extension-host/index.ts";
import { resolveChangePage } from "../src/change-page/client/changeTabs.ts";
import { Changes } from "../src/integrations/types.ts";
import { config } from "../src/workspace/server/index.ts";
import type { Change } from "../src/domain/change.ts";
import { runEffect } from "./helpers.ts";

/**
 * The notes extension: a dashboard widget backed by `ExtensionStore`, plus the one migration it
 * needed — notes written before the store existed, as a `notes.md` sidecar in the change root,
 * still read through `Changes.readSidecar`. Every route goes through the real dispatcher, so the
 * namespace, the change lookup and the status-code mapping are exercised as the app uses them.
 */
let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "corvi-notes-"));
  process.env.CORVI_ROOT = join(tmp, "changes");
  process.env.CORVI_ARCHIVE_ROOT = join(tmp, "changes-archive");
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const changeFor = (id: string): Promise<Change> =>
  runEffect(createChange({ id, branch: `${id}-work`, repos: [join(tmp, "example-api")] }));

/** Call the extension's own namespace (the path after `/api/ext/notes/`), as the page does. */
const ext = async (path: string, method = "GET", body?: unknown): Promise<Response> => {
  const response = dispatchExtensionRoute(
    new Request(`http://localhost/api/ext/notes/${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    }),
  );
  if (!response) throw new Error(`no route: ${method} ${path}`);
  return response;
};

const textAt = (path: string): Promise<string> => Bun.file(path).text();

test("the Notes widget is offered only when the extension is enabled, and its old URL falls back", () => {
  const saved = config.workspaces;
  config.workspaces = [
    { id: "with-notes", name: "With notes", extensions: ["notes"] },
    { id: "without-notes", name: "Without notes", extensions: [] },
  ];
  try {
    const change: Change = { id: "PROJ-NOTES-W", branch: "PROJ-NOTES-W", repos: [], createdAt: "" };
    expect(widgetsFor({ ...change, workspace: "with-notes" })).toEqual([
      { id: "notes", title: "Notes", extension: "notes", column: "left" },
    ]);
    // A workspace that dropped notes has no widget for it, and /changes/:id/notes is the dashboard.
    expect(widgetsFor({ ...change, workspace: "without-notes" })).toEqual([]);
    expect(resolveChangePage("notes", [])).toEqual({ kind: "dashboard" });
  } finally {
    config.workspaces = saved;
  }
});

test("notes written before the store still show, and the first write lands under the extension", async () => {
  const change = await changeFor("PROJ-NOTES-MIGRATE");

  // The legacy sidecar the core used to write: a notes.md beside change.json.
  await runEffect(writeSidecar(change.id, "notes.md", "ask about the flag\n"));

  // Read: nothing under extensions/notes yet, so the legacy file answers.
  const migrated = await ext(`changes/${change.id}/notes`);
  expect(migrated.status).toBe(200);
  expect(await migrated.json()).toEqual({ text: "ask about the flag\n" });

  // Write: the extension's own file, never the legacy one.
  const saved = await ext(`changes/${change.id}/notes`, "PUT", { text: "answered: keep it\n" });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ text: "answered: keep it\n" });
  expect(await textAt(join(changeDir(change.id), "extensions", "notes", "notes.md"))).toBe(
    "answered: keep it\n",
  );
  // The legacy file is left exactly as it was.
  expect(await textAt(join(changeDir(change.id), "notes.md"))).toBe("ask about the flag\n");

  // The store now answers, so the legacy file no longer shadows the newer text.
  const reread = await ext(`changes/${change.id}/notes`);
  expect(await reread.json()).toEqual({ text: "answered: keep it\n" });

  // Archiving moves the whole change directory: both the store's file and the legacy one travel.
  await runEffect(archiveChange(change.id));
  const archived = await ext(`changes/${change.id}/notes`);
  expect(await archived.json()).toEqual({ text: "answered: keep it\n" });
  expect(await textAt(join(archiveDir(change.id), "extensions", "notes", "notes.md"))).toBe(
    "answered: keep it\n",
  );
  expect(await textAt(join(archiveDir(change.id), "notes.md"))).toBe("ask about the flag\n");
});

test("the notes route answers an unknown change with 404 and a malformed body with 400", async () => {
  const missing = await ext("changes/PROJ-NOPE/notes");
  expect(missing.status).toBe(404);
  expect((await missing.json() as { error: string }).error).toMatch(/no such change/);

  const change = await changeFor("PROJ-NOTES-BODY");
  const badBody = dispatchExtensionRoute(
    new Request(`http://localhost/api/ext/notes/changes/${change.id}/notes`, {
      method: "PUT",
      body: "not json",
      headers: { "content-type": "application/json" },
    }),
  )!;
  expect((await badBody).status).toBe(400);
});

test("the readSidecar migration access reads a bare change-root file and refuses a path or a core file", async () => {
  const change = await changeFor("PROJ-NOTES-SIDECAR");
  await runEffect(writeSidecar(change.id, "notes.md", "legacy\n"));

  const read = (name: string): Promise<string> =>
    runEffect(
      Effect.gen(function* () {
        const changes = yield* Changes;
        return yield* changes.readSidecar(change, name);
      }),
    );

  expect(await read("notes.md")).toBe("legacy\n");
  expect(await read("missing.md")).toBe("");
  // A name with a separator is not a change-root file, and reads as absent rather than escaping.
  expect(await read("../change.json")).toBe("");
  expect(await read("extensions/notes/notes.md")).toBe("");
  // Nor are the directory components, which a bare-name check would otherwise let through.
  expect(await read("..")).toBe("");
  expect(await read(".")).toBe("");

  // The store's own files are reserved: they exist, but the capability refuses them, so the
  // migration read cannot be turned on the change record or the completion journal. `wt.toml` is
  // no longer one of them — Corvi owns the worktree path itself — so a file left behind by wt is
  // an ordinary change-root file the migration read can see.
  await runEffect(writeSidecar(change.id, "completion.json", "{}\n"));
  await runEffect(writeSidecar(change.id, "wt.toml", 'worktree-path = "x"\n'));
  expect(await read("change.json")).toBe("");
  expect(await read("completion.json")).toBe("");
  expect(await read("wt.toml")).toBe('worktree-path = "x"\n');
  // The refusal is the guard, not an absent file: the store's own read still sees them.
  expect(await runEffect(readSidecar(change.id, "completion.json"))).toBe("{}\n");
  expect(await runEffect(readSidecar(change.id, "wt.toml"))).toBe('worktree-path = "x"\n');
});
