/** The desktop scripts' CLI helper: run a command to completion and hand back its exit code and
 * output, the same shape the server's `sh` returns. The desktop host is not a request and has
 * no workspace, so this is a plain spawn with the process's own environment.
 */
import { spawn } from "node:child_process";

export type Result = { code: number; stdout: string; stderr: string };

export const sh = (cmd: readonly string[], cwd?: string): Promise<Result> =>
  new Promise((resolve) => {
    const [tool, ...args] = cmd;
    if (tool === undefined) {
      resolve({ code: 127, stdout: "", stderr: "empty command" });
      return;
    }
    const child = spawn(tool, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", (error) => resolve({ code: 127, stdout, stderr: error.message }));
    child.once("close", (code) => resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
