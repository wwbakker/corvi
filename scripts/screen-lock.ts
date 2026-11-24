/**
 * What a run's lock file says, whether the run it names is still in the way, and the file work
 * both walks share.
 *
 * The rule: a lock naming a live pid is never touched; one naming a pid that is gone is a crashed
 * run's and may be taken over, but only once nothing that run owned is still alive. Both walks
 * call this module so that rule, the `wx` write and the token-checked release have one home.
 */
import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { leftoversOf, pidAlive } from "./clean-test.ts";

/** The run a lock names: its token, and the pid that wrote the file. */
export type LockHolder = {
  readonly token: string;
  readonly pid: number;
};

/** What a lock path holds.
 *
 * `free` is no file at all — the lock is available. `held` is a lock whose pid is a live process:
 * it is never touched. `stale` is a lock whose pid is gone, which is a crashed run's: its
 * resources are checked before it is taken over. `unreadable` is a file that is not a lock at all,
 * refused but never taken over — what it guards cannot be known, and the fix is for a person to
 * look. */
export type LockState =
  | { readonly kind: "free" }
  | { readonly kind: "held"; readonly holder: LockHolder }
  | { readonly kind: "stale"; readonly holder: LockHolder }
  | { readonly kind: "unreadable"; readonly contents: string };

/** The contents a run writes when it takes the lock. */
export const lockContents = (holder: LockHolder): string => `${JSON.stringify(holder)}\n`;

/** Parse one lock file's contents and decide whether it is in the way. `contents` is `undefined`
 * when there is no file; `isLive` answers whether a pid is a process that still exists, which is
 * the only part of this that needs the system. A file exists but holds nothing parseable, or a
 * holder without a token and a positive pid, is unreadable rather than free: a lock that cannot
 * be read is not a lock that may be overwritten. */
export const lockStateOf = (contents: string | undefined, isLive: (pid: number) => boolean): LockState => {
  if (contents === undefined) return { kind: "free" };
  const unreadable: LockState = { kind: "unreadable", contents: contents.trim() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return unreadable;
  }
  if (typeof parsed !== "object" || parsed === null) return unreadable;
  const { token, pid } = parsed as { readonly token?: unknown; readonly pid?: unknown };
  if (typeof token !== "string" || token === "") return unreadable;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return unreadable;
  return { kind: isLive(pid) ? "held" : "stale", holder: { token, pid } };
};

/** The holder as one line, for a refusal that names who is in the way. */
export const describeLockHolder = (state: LockState): string => {
  switch (state.kind) {
    case "free":
      return "nobody";
    case "held":
    case "stale":
      return `run token ${state.holder.token}, pid ${state.holder.pid}`;
    case "unreadable":
      return `unreadable contents: ${state.contents}`;
  }
};

/** Whether a pid is a process that still exists. `EPERM` is a live process this user may not
 * signal, which is still a holder. */
export const isRunning = (pid: number): boolean => pidAlive(pid);

/** What a lock path holds, or `free` when there is no file. */
export const readLock = async (path: string): Promise<LockState> =>
  lockStateOf(await readFile(path, "utf8").catch(() => undefined), isRunning);

const isCode = (error: unknown, code: string): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === code;

/** A refusal when a crashed run's processes or live paths are still there, otherwise nothing. */
const staleRefusal = async (path: string, label: string, holder: LockHolder): Promise<string | undefined> => {
  const leftovers = await leftoversOf(holder.token);
  const found = [
    leftovers.processes.length > 0 ? `${leftovers.processes.length} live process(es)` : undefined,
    leftovers.paths.length > 0 ? `${leftovers.paths.length} live path(s)` : undefined,
  ].filter((part): part is string => part !== undefined);
  if (found.length === 0) return undefined;
  const command = `bun run test:clean --kill --run=${holder.token}`;
  const prune = leftovers.paths.length > 0 ? " (add --prune to remove its paths)" : "";
  return (
    `${label}: refusing to run: ${path} names run token ${holder.token}, pid ${holder.pid} (gone), ` +
    `but it still owns ${found.join(" and ")}. End them with \`${command}\`${prune} and retry.`
  );
};

/** Take the lock, or say who holds it. A stale lock is taken over by renaming it aside and reading
 * it back: if another run replaced it in between, what was moved is put back and that run's lock is
 * reported instead. */
export const takeLock = async (path: string, label: string, token: string): Promise<string | undefined> => {
  await mkdir(dirname(path), { recursive: true });
  const content = lockContents({ token, pid: process.pid });
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await writeFile(path, content, { flag: "wx" });
      return undefined;
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
    }
    // One read is both the decision and the contents the take-over compares against: a second read
    // could see another run's fresh lock and then rename that instead.
    const contents = await readFile(path, "utf8").catch(() => undefined);
    const state = lockStateOf(contents, isRunning);
    if (state.kind === "free") continue;
    if (state.kind !== "stale")
      return `${label}: refusing to run: another run holds ${path} (${describeLockHolder(state)}).`;
    const refused = await staleRefusal(path, label, state.holder);
    if (refused !== undefined) return refused;
    const aside = `${path}.${token}.${attempt}.taking-over`;
    try {
      await rename(path, aside);
    } catch (error) {
      if (isCode(error, "ENOENT")) continue;
      throw error;
    }
    const moved = await readFile(aside, "utf8").catch(() => undefined);
    if (moved !== contents) {
      // Put back what was moved, unless someone else has already written the lock. Either way the
      // lock belongs to another run now.
      await link(aside, path).catch(() => undefined);
      await unlink(aside).catch(() => undefined);
      const current = await readLock(path);
      return `${label}: refusing to run: another run holds ${path} (${describeLockHolder(current)}).`;
    }
    await unlink(aside).catch(() => undefined);
  }
  return `${label}: refusing to run: ${path} was replaced while this run was reading it.`;
};

/** Remove the lock, but only this run's: a file another run wrote is not this run's to delete. */
export const releaseLock = async (path: string, token: string): Promise<void> => {
  const state = await readLock(path);
  if ((state.kind === "held" || state.kind === "stale") && state.holder.token === token) {
    await unlink(path).catch(() => undefined);
  }
};
