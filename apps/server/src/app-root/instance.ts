/**
 * The server's own record, for the CLI to find it.
 *
 * The app picks a fresh port at each launch, so nothing about where the server listens is stable
 * enough to be written into the launcher. The server writes one JSON file per port under the
 * state directory (`@corvi/configuration/node`'s `instanceRecordPath`) and removes it on a clean
 * shutdown; the CLI reads them as discovery *hints* and probes each URL before trusting it.
 *
 * A file left behind by a hard kill or a reboot would otherwise accumulate and cost every CLI
 * invocation a failed probe, so a starting server also sweeps the records whose process is gone
 * (`pruneInstanceRecords`); the CLI separately checks each record's pid before probing. A stale
 * hint is then never trusted or even tried, and the file does not grow without bound.
 */
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { ID, instanceRecordPath, pidAlive, stateDir } from "@corvi/configuration/node";
import type { InstanceRecord } from "@corvi/contracts/instance";
import { writeAtomic } from "../capabilities/files.ts";

/** Every instance record shares this prefix, in the state directory. */
const FILE_PREFIX = `${ID}-app-`;

/** Write the record for a listening server. Best effort: a state directory that cannot be
 * written is a discovery inconvenience, never a reason to refuse to serve. */
export const writeInstanceRecord = async (url: string, port: number): Promise<void> => {
  const path = instanceRecordPath(port);
  const record: InstanceRecord = {
    url,
    port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  try {
    await mkdir(dirname(path), { recursive: true });
    // Atomic, so a CLI probing while the server starts never reads half a record and drops the
    // only candidate it had.
    await writeAtomic(path, JSON.stringify(record));
  } catch (error) {
    console.error("could not record this server for discovery:", error);
  }
};

/** Remove the discovery records whose process is gone, so a hard kill or a reboot does not leave
 * the state directory accumulating records the CLI would read (and probe, or sort ahead of the
 * live server). A record that does not parse is left for a human: it names no pid to check.
 * Best effort — a sweep that cannot run only costs the CLI a failed probe. */
export const pruneInstanceRecords = async (dir: string = stateDir()): Promise<void> => {
  const names = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    names
      .filter((name) => name.startsWith(FILE_PREFIX) && name.endsWith(".json"))
      .map(async (name) => {
        const path = join(dir, name);
        const text = await readFile(path, "utf8").catch(() => undefined);
        if (text === undefined) return;
        let pid: unknown;
        try {
          pid = (JSON.parse(text) as { pid?: unknown }).pid;
        } catch {
          return;
        }
        if (typeof pid !== "number" || pidAlive(pid)) return;
        await rm(path, { force: true }).catch(() => undefined);
      }),
  );
};

/** Remove the record. Synchronous, because the caller is a signal handler that is about to exit. */
export const removeInstanceRecord = (port: number): void => {
  try {
    rmSync(instanceRecordPath(port), { force: true });
  } catch {
    // A record that cannot be removed is stale, and a stale hint only costs a failed probe.
  }
};
