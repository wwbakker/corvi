/** Thin wrapper around child processes: integrations shell out to the vendors' own CLIs,
 * which means we inherit their auth (gh auth login, az login, ...) and store no secrets. */
export type Result = { code: number; stdout: string; stderr: string };

/** CLIs colour their errors even when not on a TTY; those codes would end up in the UI. */
const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "").trim();

/** Calls, and what they cost, when IWE_TRACE is set. The dashboard's cost is almost entirely
 * these processes, and which of them is expensive is not something to guess at. */
export const trace = new Map<string, { calls: number; cpu: number; wall: number }>();

/** How a call is grouped in the trace: the tool and its subcommand, not the arguments. */
const traceKey = (cmd: string[]): string =>
  ["git", "gh", "az", "jira", "tmux"].includes(cmd[0] ?? "")
    ? cmd.slice(0, cmd[0] === "az" ? 3 : 2).join(" ")
    : (cmd[0] ?? "");

export async function sh(cmd: string[], cwd?: string): Promise<Result> {
  const started = process.env.IWE_TRACE ? Bun.nanoseconds() : 0;
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (started) {
    const usage = proc.resourceUsage();
    const key = traceKey(cmd);
    const seen = trace.get(key) ?? { calls: 0, cpu: 0, wall: 0 };
    trace.set(key, {
      calls: seen.calls + 1,
      cpu: seen.cpu + (usage ? Number(usage.cpuTime.user + usage.cpuTime.system) / 1000 : 0),
      wall: seen.wall + (Bun.nanoseconds() - started) / 1e6,
    });
  }
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
