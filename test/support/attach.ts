/**
 * Runs the product's terminal attach path under Node — the runtime the app's own server uses for
 * it, and the one where node-pty is a real pty rather than the shim Bun has (which spawns but
 * never delivers output, apps/server/src/terminals/server/session.ts). test/tmuxSessionEnv.test.ts
 * drives this to exercise the real `attachCommand` under the real `spawnPty` without the suite
 * itself having to leave Bun.
 *
 *   node test/support/attach.ts <change-id> <change-dir>   # with CORVI_TMUX_SOCKET naming the socket
 *
 * The pty attaches the change's tmux session and holds it, exactly as one browser connection
 * does; SIGTERM detaches it, which is how the matrix closes a case.
 */
import { attachCommand } from "../../apps/server/src/terminals/server/tmux.ts";
import { spawnPty } from "../../apps/server/src/terminals/server/session.ts";

const [id, dir] = process.argv.slice(2) as [string, string];
if (id === undefined || dir === undefined) {
  console.error("usage: node test/support/attach.ts <change-id> <change-dir>");
  process.exit(2);
}

const child = spawnPty({ command: attachCommand(id, dir), cwd: dir, cols: 80, rows: 24, id, dir });
process.on("SIGTERM", () => {
  child.kill();
  process.exit(0);
});
