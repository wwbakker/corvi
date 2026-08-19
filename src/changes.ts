import { join, basename } from "node:path";
import { readdir, mkdir, rename } from "node:fs/promises";
import type { Change } from "./types.ts";
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

export async function writeChange(change: Change): Promise<void> {
  const dir = (await existingDir(change.id)) ?? changeDir(change.id);
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "change.json"), JSON.stringify(change, null, 2) + "\n");
}

/** Free-text notes, kept beside change.json so they travel into the archive with it. */
export async function readNotes(id: string): Promise<string> {
  const dir = await existingDir(id);
  return dir ? await Bun.file(join(dir, "notes.md")).text().catch(() => "") : "";
}

export async function writeNotes(id: string, text: string): Promise<void> {
  const dir = (await existingDir(id)) ?? changeDir(id);
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "notes.md"), text);
}

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
  const entries = [...active.filter((name) => name !== ARCHIVE), ...archived];
  const changes = await Promise.all(entries.map(readChange));
  return changes
    .filter((c): c is Change => c !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createChange(input: {
  id: string;
  branch?: string;
  repos?: string[];
  jira?: string;
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
    jira: input.jira?.trim() || undefined,
    state: "In Progress",
    createdAt: new Date().toISOString(),
  };
  await writeChange(change);
  await writeWtConfig(id);
  return change;
}
