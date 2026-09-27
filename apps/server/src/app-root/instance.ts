/**
 * The server's own record, for the CLI to find it.
 *
 * The app picks a fresh port at each launch, so nothing about where the server listens is stable
 * enough to be written into the launcher. The server writes one JSON file per port under the
 * state directory (`@corvi/configuration/node`'s `instanceRecordPath`) and removes it on a clean
 * shutdown; the CLI reads them as discovery *hints* and probes each URL before trusting it. A
 * file left behind by a crash is therefore harmless — it is read, the probe fails, and the next
 * candidate is tried.
 */
import { rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { instanceRecordPath } from "@corvi/configuration/node";
import type { InstanceRecord } from "@corvi/contracts/instance";

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
    await writeFile(path, JSON.stringify(record), "utf8");
  } catch (error) {
    console.error("could not record this server for discovery:", error);
  }
};

/** Remove the record. Synchronous, because the caller is a signal handler that is about to exit. */
export const removeInstanceRecord = (port: number): void => {
  try {
    rmSync(instanceRecordPath(port), { force: true });
  } catch {
    // A record that cannot be removed is stale, and a stale hint only costs a failed probe.
  }
};
