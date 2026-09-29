/**
 * Load node-pty under whatever runtime is running this file and see how it behaves. Prints one
 * JSON object so the same probe can be run under system Node, Electron's Node and Bun and the
 * results compared mechanically.
 *
 *   node spike/terminal-host/probe.ts --label node [--scenario exec|interactive|delayed]
 *   ELECTRON_RUN_AS_NODE=1 <electron> spike/terminal-host/probe.ts --label electron
 *   bun spike/terminal-host/probe.ts --label bun
 *
 * Scenarios:
 *   exec         /bin/sh -c "echo PROBE_MARKER; sleep 5"  (output at spawn)
 *   interactive  /bin/sh, then write "echo INTER_7_MARK"  (output after input)
 *   delayed      /bin/sh -c "sleep .5; echo EARLY; sleep 1; echo LATE_MARK"  (later output)
 */
import { loadNodePty, type IPty } from "./pty.ts";

const argOf = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
};

const label = argOf("--label") ?? "node";
const scenario = argOf("--scenario") ?? "exec";
const runtime = {
  label,
  execPath: process.execPath,
  node: process.versions.node,
  electron: process.versions.electron ?? null,
  bun: process.versions.bun ?? null,
};

const loaded = loadNodePty();
if ("error" in loaded) {
  console.log(JSON.stringify({ runtime, nodePty: { error: loaded.error }, result: "load-failed" }));
  await flush();
  process.exit(0);
}

const nodePty = { path: loaded.path, prebuild: loaded.prebuild, built: loaded.built };
const options = {
  name: "xterm-256color",
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: { ...process.env, TERM: "xterm-256color" },
};

let output = "";
let child: IPty;
const spawnStart = performance.now();
try {
  child =
    scenario === "interactive"
      ? loaded.module.spawn("/bin/sh", [], options)
      : scenario === "delayed"
        ? loaded.module.spawn("/bin/sh", ["-c", "sleep 0.5; echo EARLY; sleep 1; echo LATE_MARK"], options)
        : loaded.module.spawn("/bin/sh", ["-c", "echo PROBE_MARKER; sleep 5"], options);
} catch (e) {
  console.log(
    JSON.stringify({
      runtime,
      nodePty,
      scenario,
      spawn: { error: e instanceof Error ? e.message : String(e) },
      result: "spawn-failed",
    }),
  );
  await flush();
  process.exit(0);
}
const spawnedMs = performance.now() - spawnStart;
let markerMs: number | undefined;
child.onData((data) => {
  output += data;
  const marker = scenario === "interactive" ? "INTER_7_MARK" : "PROBE_MARKER";
  if (markerMs === undefined && output.includes(marker)) markerMs = performance.now() - spawnStart;
});

if (scenario === "interactive") {
  await sleep(500);
  child.write("echo INTER_$(( 7 + 0 ))_MARK\n");
  const deadline = Date.now() + 3000;
  while (markerMs === undefined && Date.now() < deadline) await sleep(10);
} else if (scenario === "delayed") {
  await sleep(3000);
} else {
  const deadline = Date.now() + 3000;
  while (markerMs === undefined && Date.now() < deadline) await sleep(10);
}

const delivered =
  scenario === "interactive" ? markerMs !== undefined : scenario === "delayed" ? output.includes("LATE_MARK") : markerMs !== undefined;
try {
  child.kill();
} catch {
  // already gone
}

console.log(
  JSON.stringify({
    runtime,
    nodePty,
    scenario,
    spawn: { pid: child.pid, spawnedMs: Number(spawnedMs.toFixed(2)) },
    output: {
      delivered,
      markerMs: markerMs === undefined ? null : Number(markerMs.toFixed(2)),
      bytes: output.length,
      snippet: output.slice(0, 160),
    },
    result: delivered ? "output-delivered" : "output-missing",
  }),
);
await flush();
process.exit(0);
