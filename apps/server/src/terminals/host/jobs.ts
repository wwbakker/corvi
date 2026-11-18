/**
 * What a pty is running in the foreground, read from `ps`.
 *
 * The kernel keeps a terminal's foreground process group: the shell while it waits at a prompt, the
 * job while one runs. `tpgid` on the pty's own child reports it, and `comm` names the group — the
 * leader's name, which is what a terminal shows in brackets beside the title (`pi`, `gradle`,
 * `nvim`). Pure parsing, apart from `host.ts`, so the mapping from a pty to its job is unit-tested
 * without a pty; the single `ps` those names come from is read once and reused.
 */
import { execFile } from "node:child_process";
import { basename } from "node:path";

/** How long one sample serves. The window list is polled, and a `ps` per session per call would be
 * a process per window per second; a second is finer than a label needs. */
const JOB_SAMPLE_MS = 1000;

/** `comm` is a process's own name or the path it was executed from; one label's worth, never a
 * whole command line. */
const JOB_NAME_CAP = 40;

export type JobSample = {
  readonly at: number;
  /** The foreground process group of every process that owns a terminal, by pid. */
  readonly foregroundOf: ReadonlyMap<number, number>;
  /** A process group's name: its leader's, or the first member's when the leader is gone. */
  readonly nameOfGroup: ReadonlyMap<number, string>;
};

/** Read `pid pgid tpgid comm` for every process. A program that sets its process title (`pi`) is
 * named the way it asked to be. */
export const parseJobs = (listing: string, at: number): JobSample => {
  const foregroundOf = new Map<number, number>();
  const nameOfGroup = new Map<number, string>();
  for (const line of listing.split("\n")) {
    const found = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(.+)$/.exec(line);
    if (found === null) continue;
    const pid = Number(found[1]);
    const pgid = Number(found[2]);
    const tpgid = Number(found[3]);
    const name = basename((found[4] ?? "").trim()).slice(0, JOB_NAME_CAP);
    if (name === "") continue;
    // A process without a terminal (or a dead one) reports no foreground group.
    if (tpgid > 0) foregroundOf.set(pid, tpgid);
    // The group leader names the job; a member names it only when the leader is already gone.
    if (pid === pgid || !nameOfGroup.has(pgid)) nameOfGroup.set(pgid, name);
  }
  return { at, foregroundOf, nameOfGroup };
};

const readJobs = (): Promise<string | undefined> =>
  new Promise((resolve) => {
    execFile("ps", ["-axo", "pid=,pgid=,tpgid=,comm="], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) =>
      resolve(error ? undefined : stdout),
    );
  });

/** A cached reader: at most one `ps` a second, and a call that arrives while one runs joins it.
 * A failed `ps` answers with the names it last had — a window list never fails over a label. */
export const makeJobSampler = (): (() => Promise<JobSample | undefined>) => {
  let sample: JobSample | undefined;
  let inFlight: Promise<JobSample | undefined> | undefined;
  return () => {
    if (sample !== undefined && Date.now() - sample.at < JOB_SAMPLE_MS) return Promise.resolve(sample);
    inFlight ??= readJobs()
      .then((listing) => {
        if (listing !== undefined) sample = parseJobs(listing, Date.now());
        return sample;
      })
      .catch(() => sample)
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
};
