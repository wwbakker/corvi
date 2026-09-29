/**
 * Records the stress stream once, from a real pty, into `stream.bin`. The committed `stream.bin`
 * is the source of truth; re-running this regenerates it (the `top` capture may differ run to
 * run, which is exactly why it is committed).
 *
 *   node spike/screen/record.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadNodePty } from "../terminal-host/pty.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const emitPath = fileURLToPath(new URL("./emit.ts", import.meta.url));
const outPath = fileURLToPath(new URL("./stream.bin", import.meta.url));

const loaded = loadNodePty();
if ("error" in loaded) throw new Error(`cannot load node-pty: ${loaded.error}`);

const chunks: Buffer[] = [];
const child = loaded.module.spawn("/bin/sh", ["-c", `${process.execPath} ${emitPath}`], {
  name: "xterm-256color",
  cols: 120,
  rows: 40,
  cwd: here,
  encoding: null,
  env: { ...process.env, TERM: "xterm-256color" },
});
child.onData((data) => chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8")));
const timer = setTimeout(() => {
  console.error("record: timed out");
  process.exit(1);
}, 60_000);
child.onExit(() => {
  clearTimeout(timer);
  mkdirSync(dirname(outPath), { recursive: true });
  const stream = Buffer.concat(chunks);
  writeFileSync(outPath, stream);
  process.stdout.write(`recorded ${stream.length} bytes to ${outPath}\n`);
  process.exit(0);
});
