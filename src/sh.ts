/** Thin wrapper around child processes: integrations shell out to the vendors' own CLIs,
 * which means we inherit their auth (gh auth login, az login, ...) and store no secrets. */
export type Result = { code: number; stdout: string; stderr: string };

/** CLIs colour their errors even when not on a TTY; those codes would end up in the UI. */
const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "").trim();

export async function sh(cmd: string[], cwd?: string): Promise<Result> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) };
}

/** Run and throw on failure, for actions where the user should see what broke. */
export async function shOrThrow(cmd: string[], cwd?: string): Promise<string> {
  const r = await sh(cmd, cwd);
  if (r.code !== 0) throw new Error(`${cmd.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** Parse `--json` style output, tolerating a CLI that printed nothing. */
export function json<T>(out: string, fallback: T): T {
  try {
    return out ? (JSON.parse(out) as T) : fallback;
  } catch {
    return fallback;
  }
}
