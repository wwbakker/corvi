import { expect, test } from "bun:test";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { testTempDir } from "./helpers.ts";

/**
 * The one-time move from the old names: the directories, the changes and their archive, the
 * `wt.toml` worktree paths, the git worktrees that moved with them, and the pi sessions whose
 * working directory was under the old root. A dry run touches nothing, a custom changes root is
 * refused rather than guessed at, and a destination that exists aborts.
 */
const script = join(import.meta.dir, "..", "scripts", "migrate-from-iwe.ts");

const runScript = (
  home: string,
  args: string[] = [],
  cwd?: string,
): { exitCode: number; stdout: Buffer; stderr: Buffer } =>
  Bun.spawnSync({
    cmd: ["bun", script, "--home", home, ...args],
    ...(cwd ? { cwd } : {}),
    env: { ...process.env, XDG_STATE_HOME: join(home, ".local", "state") },
    stdout: "pipe",
    stderr: "pipe",
  });

const exists = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** pi's own session-directory encoding, the one the migration has to read. */
const encodeCwd = (path: string): string =>
  `--${path.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString();
}

type Seeded = {
  home: string;
  repo: string;
  change: string;
  archived: string;
  sessions: string;
};

/** A home holding an old install: config, cache, state, an active change with a real worktree,
 * an archived change, and pi sessions for both plus one unrelated. */
async function seed(config: Record<string, unknown> = {}): Promise<Seeded> {
  const home = await testTempDir("migration");
  const repo = join(home, "Repos", "example");
  const change = join(home, "changes", "PROJ-1");
  const archived = join(home, "changes", "archive", "PROJ-0");
  const sessions = join(home, ".pi", "agent", "sessions");

  await mkdir(join(home, ".config", "iwe"), { recursive: true });
  await writeFile(join(home, ".config", "iwe", "config.json"), JSON.stringify(config));
  await mkdir(join(home, ".cache", "iwe"), { recursive: true });
  await writeFile(join(home, ".cache", "iwe", "state.json"), "{}");
  await mkdir(join(home, ".local", "state", "iwe"), { recursive: true });
  await writeFile(join(home, ".local", "state", "iwe", "log"), "old log\n");
  await writeFile(join(home, ".local", "state", "iwe", "iwe-app-123.pid"), "123\n");

  await mkdir(repo, { recursive: true });
  await git(repo, ["init", "-q", "-b", "main"]);
  await writeFile(join(repo, "README.md"), "hi\n");
  await git(repo, ["add", "."]);
  await git(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);

  await mkdir(change, { recursive: true });
  await writeFile(
    join(change, "change.json"),
    JSON.stringify({ id: "PROJ-1", branch: "PROJ-1", repos: [repo], createdAt: "2026-01-01" }),
  );
  await writeFile(join(change, "wt.toml"), `worktree-path = "${change}/{{ repo }}"\n`);
  await git(repo, ["worktree", "add", "-q", join(change, "example"), "-b", "PROJ-1"]);

  await mkdir(archived, { recursive: true });
  await writeFile(
    join(archived, "change.json"),
    JSON.stringify({ id: "PROJ-0", branch: "PROJ-0", repos: [], createdAt: "2025-12-31" }),
  );
  await writeFile(join(archived, "wt.toml"), `worktree-path = "${archived}/{{ repo }}"\n`);

  const session = async (cwd: string, name: string): Promise<void> => {
    await mkdir(join(sessions, encodeCwd(cwd)), { recursive: true });
    await writeFile(
      join(sessions, encodeCwd(cwd), `${name}.jsonl`),
      `${JSON.stringify({ type: "session", version: 3, id: name, timestamp: "t", cwd })}\n` +
        `${JSON.stringify({ type: "message", id: "m" })}\n`,
    );
  };
  await session(change, "active");
  await session(archived, "archived");
  await session(join(home, "Work"), "unrelated");

  return { home, repo, change, archived, sessions };
}

test("an old install moves to the new names, and only the old names", async () => {
  const { home, repo, change, archived, sessions } = await seed();
  const result = runScript(home, ["--apply"]);

  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");

  // The directories.
  expect(await exists(join(home, ".config", "corvi", "config.json"))).toBe(true);
  expect(await exists(join(home, ".config", "iwe"))).toBe(false);
  expect(await exists(join(home, ".cache", "corvi", "state.json"))).toBe(true);
  expect(await exists(join(home, ".local", "state", "corvi", "log"))).toBe(true);
  expect(await exists(join(home, ".local", "state", "corvi", "iwe-app-123.pid"))).toBe(false);
  expect(await exists(join(home, ".local", "state", "iwe"))).toBe(false);

  // The changes and the archive.
  const movedChange = join(home, "corvi", "changes", "PROJ-1");
  const movedArchive = join(home, "corvi", "changes-archive", "PROJ-0");
  expect(await exists(join(movedChange, "change.json"))).toBe(true);
  expect(await exists(join(movedArchive, "change.json"))).toBe(true);
  expect(await exists(join(home, "changes"))).toBe(false);

  // The wt.toml points at the new directory, and git agrees the worktree is there.
  const wt = await readFile(join(movedChange, "wt.toml"), "utf8");
  expect(wt).toContain(`worktree-path = "${movedChange}/{{ repo }}"`);
  const list = await git(repo, ["worktree", "list"]);
  expect(list).toContain(join(movedChange, "example"));
  expect(list).not.toContain("prunable");

  // The pi sessions: directory, header, and the unrelated one left alone.
  const movedSession = join(sessions, encodeCwd(movedChange), "active.jsonl");
  expect(await exists(movedSession)).toBe(true);
  expect(await exists(join(sessions, encodeCwd(change)))).toBe(false);
  const header = JSON.parse((await readFile(movedSession, "utf8")).split("\n")[0]!) as {
    cwd: string;
  };
  expect(header.cwd).toBe(movedChange);
  expect(
    await exists(join(sessions, encodeCwd(join(home, "corvi", "changes-archive", "PROJ-0", "x")))),
  ).toBe(false);
  expect(await exists(join(sessions, encodeCwd(join(home, "Work")), "unrelated.jsonl"))).toBe(true);
  expect(await exists(join(sessions, encodeCwd(archived)))).toBe(false);
  expect(await exists(join(sessions, encodeCwd(movedArchive), "archived.jsonl"))).toBe(true);
});

test("a dry run moves nothing and says what it would", async () => {
  const { home } = await seed();
  const result = runScript(home);

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("would move");
  expect(await exists(join(home, ".config", "iwe", "config.json"))).toBe(true);
  expect(await exists(join(home, "corvi"))).toBe(false);
  expect(await exists(join(home, "changes", "PROJ-1"))).toBe(true);
});

test("a run from inside the changes root warns before moving it", async () => {
  const { home } = await seed();
  const result = runScript(home, [], join(home, "changes", "PROJ-1"));

  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toContain("inside the changes root it moves");
  expect(await exists(join(home, "corvi"))).toBe(false); // a dry run still moves nothing
});

test("an existing state directory is refused with the way out", async () => {
  const { home } = await seed();
  await mkdir(join(home, ".local", "state", "corvi", "client"), { recursive: true });
  const result = runScript(home, ["--apply"]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("remove it and run again");
  expect(await exists(join(home, "changes", "PROJ-1"))).toBe(true); // nothing moved
});

test("a custom changesRoot is refused rather than guessed at", async () => {
  const { home } = await seed({ changesRoot: "~/somewhere/else" });
  const result = runScript(home, ["--apply"]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("custom changesRoot");
  expect(await exists(join(home, ".config", "iwe", "config.json"))).toBe(true);
  expect(await exists(join(home, "corvi"))).toBe(false);
});

test("an explicit default changesRoot does not survive the move", async () => {
  const { home } = await seed({ changesRoot: "~/changes" });
  const result = runScript(home, ["--apply"]);

  expect(result.exitCode).toBe(0);
  const config = JSON.parse(await readFile(join(home, ".config", "corvi", "config.json"), "utf8")) as {
    changesRoot?: string;
  };
  expect(config.changesRoot).toBeUndefined();
  expect(await exists(join(home, "corvi", "changes", "PROJ-1"))).toBe(true);
});
