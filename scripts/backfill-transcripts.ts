/**
 * Keep the agent transcripts of changes archived before archiving kept them.
 *
 * Completing or cancelling a change copies the agent sessions that ran in it into its
 * `transcripts/` (the lifecycle's `transcripts` step). Changes archived before that have none;
 * this runs the same collection once for each of them, from the directory the change lived in
 * (`<changes root>/<id>`, where the agents' sessions are filed) into the archived directory.
 *
 *   bun scripts/backfill-transcripts.ts           # say what would be copied
 *   bun scripts/backfill-transcripts.ts --write   # copy it
 *
 * The roots are the configured workspaces' (`CORVI_ROOT`/`CORVI_ARCHIVE_ROOT` override them, as
 * for the server). Only each archived change's own `transcripts/` is written; the agents' stores
 * are only read. A change that already has transcripts is left alone, so running it twice copies
 * nothing new. A one-off: remove it once the archives on every machine are done.
 */
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { AbsolutePath } from "@corvi/contracts/paths";
import { AgentTranscripts, TRANSCRIPTS_DIRECTORY } from "@corvi/agents/transcripts";
import { opencodeIfUsed, piSessionRoots, transcriptsLayer } from "@corvi/agents/node";
import { changePairs } from "../apps/server/src/change/server/store.ts";

const write = process.argv.includes("--write");

const program = Effect.gen(function* () {
  const transcripts = yield* AgentTranscripts;
  let copied = 0;
  const empty: string[] = [];
  for (const { root, archiveRoot } of changePairs()) {
    const ids = existsSync(archiveRoot)
      ? (yield* Effect.promise(() => readdir(archiveRoot, { withFileTypes: true })))
          .filter((entry) => entry.isDirectory() && existsSync(join(archiveRoot, entry.name, "change.json")))
          .map((entry) => entry.name)
          .sort()
      : [];
    for (const id of ids) {
      const archived = join(archiveRoot, id);
      if (existsSync(join(archived, TRANSCRIPTS_DIRECTORY))) continue;
      const from = AbsolutePath.make(join(root, id));
      // A dry run collects into a scratch directory, so what it reports is what --write copies.
      const scratch = write ? undefined : yield* Effect.promise(() => mkdtemp(join(tmpdir(), "backfill-transcripts-")));
      const to = AbsolutePath.make(scratch ?? join(archived, TRANSCRIPTS_DIRECTORY));
      const collected = yield* transcripts.collect({ from, to });
      if (scratch) yield* Effect.promise(() => rm(scratch, { recursive: true, force: true }));
      if (collected.copied === 0) {
        empty.push(id);
        continue;
      }
      copied += collected.copied;
      const notes = collected.notes.length ? ` (${collected.notes.join("; ")})` : "";
      console.log(`${write ? "copied" : "would copy"} ${collected.copied} session(s) for ${id}${notes}`);
    }
  }
  console.log(`${write ? "copied" : "would copy"} ${copied} session(s) in total`);
  if (empty.length) console.log(`nothing left to keep for: ${empty.join(", ")}`);
  if (!write && copied > 0) console.log("run again with --write to copy them");
});

const layer = Effect.gen(function* () {
  const roots = yield* piSessionRoots();
  const opencode = yield* opencodeIfUsed();
  return transcriptsLayer({ piSessionRoots: roots, ...(opencode ? { opencode } : {}) });
});

await Effect.runPromise(Effect.flatMap(layer, (built) => Effect.provide(program, built)));
