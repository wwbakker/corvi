/**
 * The spawnable terminal host entry point: `node apps/server/src/terminals/host/main.ts
 * --socket <path> [--checkout <path>] [--build-id <id>] [--idle-ms <n>]`.
 *
 * It parses the arguments, starts the host, and translates signals into a clean close. The host
 * itself (`host.ts`) is side-effect-free and importable; this file is the process boundary. It
 * runs under Node's type stripping, so no build step is needed.
 */
import { startHost } from "./host.ts";

const argOf = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};

const socketPath = argOf("--socket");
if (socketPath === undefined) {
  console.error("usage: main.ts --socket <path> [--checkout <path>] [--build-id <id>] [--idle-ms <n>]");
  process.exit(2);
}

const idleMs = Number(argOf("--idle-ms") ?? 0);
try {
  const host = await startHost({
    socketPath,
    ...(argOf("--checkout") !== undefined ? { checkout: argOf("--checkout") } : {}),
    ...(argOf("--build-id") !== undefined ? { buildId: argOf("--build-id") } : {}),
    ...(Number.isFinite(idleMs) && idleMs > 0 ? { idleMs } : {}),
    onClosed: () => process.exit(0),
  });
  console.log(`host ${host.owner.pid} listening on ${socketPath}`);
  const stop = (): void => {
    void host.close();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} catch (error) {
  console.error(`terminal host: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
