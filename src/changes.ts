import { join, basename } from "node:path";
import { readdir, mkdir, rename } from "node:fs/promises";
import { CHANGE_STATES, isFinished, type Change, type ChangeState } from "./types.ts";
import { config } from "./config.ts";
export { branchFor } from "./branch.ts";

/** Root of the per-change directories. Override with IWE_ROOT (tests do). */
export const root = (): string => process.env.IWE_ROOT ?? config.changesRoot;

/** Completed changes move here, so the list stays the work in flight. */
export const ARCHIVE = "archive";

export const changeDir = (id: string): string => join(root(), id);
export const archiveDir = (id: string): string => join(root(), ARCHIVE, id);

/** Active directory if it exists, otherwise the archived one. */
async function existingDir(id: string): Promise<string | null> {
  for (const dir of [changeDir(id), archiveDir(id)]) {
    if (await Bun.file(join(dir, "change.json")).exists()) return dir;
  }
  return null;
}

const changeFile = (id: string): string => join(changeDir(id), "change.json");

/** wt user-config for this change, so its worktrees land in the change directory instead of
 * next to their repositories. Passed to every wt invocation with --config. */
export const wtConfigPath = (id: string): string => join(changeDir(id), "wt.toml");

/** ponytail: worktrees are keyed by repository directory name, so two selected repositories
 * with the same basename would collide. Add {{ repo_path | sanitize }} if that ever happens. */
export async function writeWtConfig(id: string): Promise<string> {
  const path = wtConfigPath(id);
  if (!(await Bun.file(path).exists())) {
    const dir = changeDir(id).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    await mkdir(changeDir(id), { recursive: true });
    await Bun.write(path, `worktree-path = "${dir}/{{ repo }}"\n`);
  }
  return path;
}

export async function readChange(id: string): Promise<Change | null> {
  const dir = await existingDir(id);
  return dir ? ((await Bun.file(join(dir, "change.json")).json()) as Change) : null;
}

/**
 * The two fields you may edit by hand: what a change is called, and where it stands.
 *
 * Here rather than in the route, so what is allowed can be tested without a server — and so the
 * one rule that matters is stated once: a change ends by being completed or cancelled, which
 * merge, remove worktrees and archive. Setting the word by hand would do none of that and claim
 * it had happened.
 */
export function applyPatch(change: Change, patch: { state?: string; title?: string }): Change {
  if (patch.state && !CHANGE_STATES.includes(patch.state as ChangeState)) {
    throw new Error(`unknown state: ${patch.state}`);
  }
  if (patch.state && isFinished({ ...change, state: patch.state as ChangeState })) {
    throw new Error(`${patch.state} is what completing or cancelling a change sets`);
  }
  const title = patch.title?.trim();
  return {
    ...change,
    state: (patch.state as ChangeState) ?? change.state,
    // An empty title hands the name back to the ticket; anything else is yours to keep.
    ...(patch.title === undefined
      ? {}
      : title
        ? { title, titleEdited: true }
        : { title: undefined, titleEdited: undefined }),
  };
}

export async function writeChange(change: Change): Promise<void> {
  const dir = (await existingDir(change.id)) ?? changeDir(change.id);
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "change.json"), JSON.stringify(change, null, 2) + "\n");
}

/** A file beside change.json — notes, completion progress — which therefore travels into the
 * archive with it. Read from wherever the change currently lives. */
export async function readSidecar(id: string, name: string): Promise<string> {
  const dir = await existingDir(id);
  return dir ? await Bun.file(join(dir, name)).text().catch(() => "") : "";
}

export async function writeSidecar(id: string, name: string, text: string): Promise<void> {
  const dir = (await existingDir(id)) ?? changeDir(id);
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, name), text);
}

/** Free-text notes, kept beside change.json so they travel into the archive with it. */
export const readNotes = (id: string): Promise<string> => readSidecar(id, "notes.md");
export const writeNotes = (id: string, text: string): Promise<void> =>
  writeSidecar(id, "notes.md", text);

/** Move a completed change out of the way. Its worktrees are gone by then, so nothing but
 * change.json and the wt config travels. */
export async function archiveChange(id: string): Promise<void> {
  if (!(await Bun.file(changeFile(id)).exists())) return; // already archived
  await mkdir(join(root(), ARCHIVE), { recursive: true });
  await rename(changeDir(id), archiveDir(id));
}

async function directoriesIn(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return []; // directory does not exist yet
  }
}

/** Active changes first, then archived ones; both are listed, the archive is not a hiding place. */
export async function listChanges(): Promise<Change[]> {
  const [active, archived] = await Promise.all([
    directoriesIn(root()),
    directoriesIn(join(root(), ARCHIVE)),
  ]);
  // A completed change can leave its directory behind — a terminal writing in it, a build
  // dropping target/ into it — while change.json has already moved to the archive. Both names
  // then resolve to the same change, and it must still be listed once.
  const entries = [...new Set([...active.filter((name) => name !== ARCHIVE), ...archived])];
  const changes = await Promise.all(entries.map(readChange));
  const byId = new Map(changes.filter((c): c is Change => c !== null).map((c) => [c.id, c]));
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createChange(input: {
  id: string;
  branch?: string;
  repos?: string[];
  direct?: string[];
  base?: Record<string, string>;
  jira?: string;
  workspace?: string;
}): Promise<Change> {
  const id = input.id.trim();
  if (!id || id !== basename(id) || id.startsWith(".")) {
    throw new Error(`invalid change id: ${input.id}`);
  }
  if (await readChange(id)) throw new Error(`change already exists: ${id}`);
  const repos = (input.repos ?? []).map((r) => r.trim()).filter(Boolean);
  if (repos.length === 0) throw new Error("select at least one repository");
  const change: Change = {
    id,
    branch: input.branch?.trim() || id,
    repos,
    direct: input.direct?.filter((r) => repos.includes(r)),
    base: input.base,
    jira: input.jira?.trim() || undefined,
    // The context it was made in. Unknown means the first workspace, which is what every change
    // made before this belongs to.
    workspace: input.workspace?.trim() || undefined,
    state: "In Progress",
    createdAt: new Date().toISOString(),
  };
  await writeChange(change);
  await writeWtConfig(id);
  return change;
}
