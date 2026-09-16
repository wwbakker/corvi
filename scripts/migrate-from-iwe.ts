/**
 * Moves an install from the old IWE names to Corvi's.
 *
 *   bun run migrate:iwe              # print what would move
 *   bun run migrate:iwe --apply      # move it
 *   bun run migrate:iwe --home DIR   # act on DIR as the home directory (tests use this)
 *
 * One-time and temporary: once an install has moved, this script has no work left and can be
 * deleted (a follow-up change does). It moves
 *
 *   ~/.config/iwe            -> ~/.config/corvi
 *   ~/.cache/iwe             -> ~/.cache/corvi
 *   ~/.local/state/iwe       -> ~/.local/state/corvi
 *   ~/changes/<id>           -> ~/corvi/changes/<id>
 *   ~/changes/archive/<id>   -> ~/corvi/changes-archive/<id>
 *
 * rewrites every moved change's `wt.toml` to the new root, repairs the git worktrees that moved
 * with it, and renames the pi sessions whose working directory was under the old root — the
 * session's directory and the `cwd` in its header. A destination that already exists aborts
 * rather than merges, and nothing happens without `--apply`.
 *
 * Stop Corvi, its terminals and any agent working in a change before running it: the change
 * directories move out from under whatever is sitting in them.
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const homeFlag = argv.indexOf("--home");
if (homeFlag !== -1 && argv[homeFlag + 1] === undefined) {
  console.error("--home needs a directory");
  process.exit(64);
}
const home = homeFlag === -1 ? homedir() : resolve(argv[homeFlag + 1]!);

const fail = (message: string): never => {
  console.error(`not migrating: ${message}`);
  process.exit(1);
};
const exists = async (path: string): Promise<boolean> =>
  await stat(path).then(
    () => true,
    () => false,
  );
const expand = (path: string): string =>
  path.startsWith("~") ? join(home, path.slice(1)) : path;

/** The old locations: what the app wrote before the rename. */
const oldConfigDir = join(home, ".config", "iwe");
const oldCacheDir = join(home, ".cache", "iwe");
const stateHome = process.env.XDG_STATE_HOME ?? join(home, ".local", "state");
const oldStateDir = join(stateHome, "iwe");
const sessionsDir = join(home, ".pi", "agent", "sessions");

/** The new ones. The defaults only: a config's custom `changesRoot` is refused below rather
 * than guessed at. */
const newConfigDir = join(home, ".config", "corvi");
const newCacheDir = join(home, ".cache", "corvi");
const newStateDir = join(stateHome, "corvi");
const newRoot = join(home, "corvi", "changes");
const newArchive = join(home, "corvi", "changes-archive");
const oldDefaultRoot = join(home, "changes");
const oldArchive = join(oldDefaultRoot, "archive");

/** The changes root the old config was using. A custom one is not this script's to move: it does
 * not carry the old name, so there is nothing to rename and guessing a destination would only
 * lose data. */
const oldConfig = await readFile(join(oldConfigDir, "config.json"), "utf8")
  .then((text) => JSON.parse(text) as { changesRoot?: string })
  .catch(() => ({}) as { changesRoot?: string });
const oldRoot = oldConfig.changesRoot ? expand(oldConfig.changesRoot) : oldDefaultRoot;
if (oldRoot !== oldDefaultRoot) {
  fail(
    `the config at ${join(oldConfigDir, "config.json")} names a custom changesRoot (${oldConfig.changesRoot}). ` +
      `This script moves the default ${oldDefaultRoot} to ${newRoot}; move the custom root by hand ` +
      "and point the new config at it, or clear changesRoot and run again.",
  );
}

/** Refuse a half-migrated or freshly used install: the script moves, it does not merge. */
for (const destination of [newConfigDir, newCacheDir, newStateDir, newRoot, newArchive]) {
  if (await exists(destination)) fail(`${destination} already exists`);
}

type Move = { from: string; to: string; change?: string };
const moves: Move[] = [];
const plan = async (from: string, to: string, change?: string): Promise<void> => {
  if (await exists(from)) moves.push({ from, to, change });
};
await plan(oldConfigDir, newConfigDir);
await plan(oldCacheDir, newCacheDir);
await plan(oldStateDir, newStateDir);

// Active changes and archive entries, each moved to its new root. A change that left a directory
// behind after completing is moved like any other active entry; the archive entry is the one
// with the change.json.
const rootEntries = await readdir(oldRoot, { withFileTypes: true }).catch(() => []);
for (const entry of rootEntries) {
  if (entry.name === "archive") {
    const archived = await readdir(join(oldRoot, "archive"), { withFileTypes: true }).catch(() => []);
    for (const one of archived) {
      await plan(join(oldRoot, "archive", one.name), join(newArchive, one.name), join(newArchive, one.name));
    }
    continue;
  }
  await plan(join(oldRoot, entry.name), join(newRoot, entry.name), join(newRoot, entry.name));
}

/** The pi session directory name for a working directory: `<cwd>` with `/` and `:` replaced,
 * wrapped in `--…--` (pi's own encoding, `session-manager.ts`). */
const encodeCwd = (path: string): string =>
  `--${path.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

/** Where a session directory moves to, or undefined when its working directory is not under the
 * old changes root. Comparing encoded prefixes is safe: the prefix ends at a `-`, and an entry
 * that merely starts with the same letters (a sibling directory like `changes-2`) does not. */
const mapSessionDir = (name: string): string | undefined => {
  const base = (path: string): string => encodeCwd(path).slice(0, -2);
  const under = (oldBase: string, newBase: string): string | undefined => {
    if (name === `${oldBase}--`) return `${newBase}--`;
    if (name.startsWith(`${oldBase}-`)) return `${newBase}${name.slice(oldBase.length)}`;
    return undefined;
  };
  return under(base(oldArchive), base(newArchive)) ?? under(base(oldRoot), base(newRoot));
};

/** The same mapping for an absolute path: a session's header carries its working directory. */
const mapPath = (path: string): string | undefined => {
  if (path === oldArchive || path.startsWith(`${oldArchive}/`)) {
    return `${newArchive}${path.slice(oldArchive.length)}`;
  }
  if (path === oldRoot || path.startsWith(`${oldRoot}/`)) {
    return `${newRoot}${path.slice(oldRoot.length)}`;
  }
  return undefined;
};

const sessionDirs = await readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
const sessionMoves = sessionDirs
  .filter((entry) => entry.isDirectory() && mapSessionDir(entry.name))
  .map((entry) => ({ from: join(sessionsDir, entry.name), to: join(sessionsDir, mapSessionDir(entry.name)!) }));

if (!moves.length && !sessionMoves.length) {
  console.log("nothing to migrate: no old install found");
  process.exit(0);
}

// The shell may be sitting in a directory this run moves (the script itself is already loaded,
// so it survives). Its cwd and everything running in it — an agent, a build — go stale, which is
// easy to do by running this from a change's own worktree; say so before it happens.
const here = process.cwd();
if (here === oldRoot || here.startsWith(`${oldRoot}/`)) {
  console.warn(
    `warning: this shell is inside the changes root it moves (${here}); run the script from ` +
      "outside it, so the shell's working directory does not go stale.",
  );
}

for (const move of moves) console.log(`${apply ? "moving" : "would move"} ${move.from} -> ${move.to}`);
for (const move of sessionMoves) console.log(`${apply ? "moving" : "would move"} ${move.from} -> ${move.to}`);
if (!apply) {
  console.log(`\n${moves.length} path(s) and ${sessionMoves.length} session(s); run with --apply to move them`);
  process.exit(0);
}

/** One directory to its new place; the parent exists by the time the rename happens. */
const perform = async (from: string, to: string): Promise<void> => {
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
};

for (const move of moves) await perform(move.from, move.to);

// The old config may name `changesRoot: "~/changes"` explicitly — the path the app resolves to
// the default is the one that just moved away. Absence means the new default; drop the field.
{
  const file = join(newConfigDir, "config.json");
  const config = await readFile(file, "utf8")
    .then((text) => JSON.parse(text) as Record<string, unknown>)
    .catch(() => undefined);
  if (config && "changesRoot" in config) {
    delete config.changesRoot;
    await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
  }
}

// The emptied old roots: every entry moved, the archive included.
await rm(oldArchive, { recursive: true, force: true });
await rm(oldRoot, { recursive: true, force: true });

// The moved changes: their wt.toml still names the old directory, and their worktrees still
// register with their repositories under the old path.
const changed = moves.filter((move) => move.change !== undefined);
for (const move of changed) {
  const wtConfig = join(move.to, "wt.toml");
  const text = await readFile(wtConfig, "utf8").catch(() => undefined);
  if (text !== undefined) {
    const rewritten = text.replaceAll(move.from, move.to);
    if (rewritten !== text) await writeFile(wtConfig, rewritten);
  }
  for (const entry of await readdir(move.to, { withFileTypes: true }).catch(() => [])) {
    if (entry.isSymbolicLink()) continue;
    const child = join(move.to, entry.name);
    const git = await stat(join(child, ".git")).catch(() => undefined);
    // A `.git` file is a worktree: git can repair its own record now that the directory is back
    // where it is. A `.git` directory is a clone, and a missing one is not ours.
    if (!git?.isFile()) continue;
    const repaired = Bun.spawnSync(["git", "-C", child, "worktree", "repair"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (repaired.exitCode !== 0) {
      console.error(`could not repair the worktree in ${child}: ${repaired.stderr.toString().trim()}`);
    }
  }
}

// Stale pid-files name servers that are not running any more; the new app writes its own.
for (const entry of await readdir(newStateDir).catch(() => [])) {
  if (/^(iwe|corvi)-app-.*\.pid$/.test(entry)) await rm(join(newStateDir, entry), { force: true });
}

// pi sessions: the directory is keyed by the working directory, and the header records it.
for (const move of sessionMoves) {
  await perform(move.from, move.to);
  for (const entry of await readdir(move.to).catch(() => [])) {
    if (!entry.endsWith(".jsonl")) continue;
    const file = join(move.to, entry);
    const text = await readFile(file, "utf8");
    const newline = text.indexOf("\n");
    const first = newline === -1 ? text : text.slice(0, newline);
    const header = JSON.parse(first) as { type?: unknown; cwd?: unknown };
    if (header.type !== "session" || typeof header.cwd !== "string") continue;
    const mapped = mapPath(header.cwd);
    if (mapped === undefined) continue;
    header.cwd = mapped;
    const rewritten = JSON.stringify(header) + (newline === -1 ? "" : text.slice(newline));
    await writeFile(file, rewritten);
  }
}

console.log(`\nmigrated ${moves.length} path(s) and ${sessionMoves.length} session(s)`);
console.log("install the app again (`bun run app:install`) so the launcher, entry and icons are Corvi's");
