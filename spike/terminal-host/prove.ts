/**
 * One phase of the adoption/update proof, as a separate process so a "client exit" is a real
 * process exit and the only thing left holding the shell is the host.
 *
 *   node spike/terminal-host/prove.ts --phase open    --socket <p> --build-id v1 --marker FIRST
 *   node spike/terminal-host/prove.ts --phase adopt   --socket <p> --build-id v1 --marker SECOND
 *   node spike/terminal-host/prove.ts --phase stale   --socket <p> --build-id v2 --marker THIRD
 *   node spike/terminal-host/prove.ts --phase cleanup --socket <p> --build-id v2
 *
 * Each phase prints one JSON object. `run-adoption.sh` drives them and checks the pids.
 */
import { ensureHost, type HostOwner } from "./client.ts";

const argOf = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const socket = argOf("--socket");
const buildId = argOf("--build-id") ?? "unversioned";
const marker = argOf("--marker") ?? "MARK";
const checkout = argOf("--checkout") ?? process.cwd();
const phase = argOf("--phase");
if (socket === undefined || phase === undefined) {
  console.error("usage: prove.ts --phase <open|adopt|stale|cleanup> --socket <path> --build-id <id> [--marker M]");
  process.exit(2);
}

const sessionId = "proof";
const ensureStart = performance.now();
const { client, adopted } = await ensureHost({ socket, checkout, buildId });
const ensureMs = Number((performance.now() - ensureStart).toFixed(2));
const owner: HostOwner = await client.info();

let observed = "";
let found = false;
client.onData(sessionId, (data) => {
  observed += data.toString("utf8");
  if (observed.includes(marker)) found = true;
});

if (phase === "cleanup") {
  await client.shutdown().catch(() => undefined);
  client.close();
  console.log(JSON.stringify({ phase, hostPid: owner.pid }));
  process.exit(0);
}

if (phase === "open" || phase === "stale") {
  await client.open(sessionId, { cwd: process.cwd(), command: ["/bin/sh"], cols: 80, rows: 24 });
}
const attached = await client.attach(sessionId);
// A shell needs a moment to exist before it will read a line.
await sleep(300);
client.write(sessionId, `echo ${marker}\n`);

const deadline = Date.now() + 5000;
while (!found && Date.now() < deadline) await sleep(20);

console.log(
  JSON.stringify({
    phase,
    adopted,
    ensureMs,
    hostPid: owner.pid,
    hostBuildId: owner.buildId,
    attached: attached.attached,
    markerFound: found,
    output: observed.slice(-200),
  }),
);
// Detach, do not shut down: the host (and the shell) must outlive this process.
client.close();
process.exit(0);
