/**
 * Loading node-pty from the spike's own directory.
 *
 * The spike lives outside every workspace package, so `import "node-pty"` would not resolve: the
 * addon is installed for `apps/server` (bun's isolated layout), not at the checkout root. This
 * loader reaches into that install by absolute path and hands back the module plus how it was
 * built, so the probe can report prebuild-vs-gyp honestly. The types are local because there is
 * no node_modules ancestor to pull the package's own typings from.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type IPty = {
  readonly pid: number;
  onData: (listener: (data: string) => void) => void;
  onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: (signal?: string) => void;
};

export type SpawnOptions = {
  readonly name?: string;
  readonly cols?: number;
  readonly rows?: number;
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly encoding?: string | null;
};

export type NodePty = {
  spawn: (file: string, args: readonly string[], options: SpawnOptions) => IPty;
};

export type NodePtyLoad =
  | { readonly module: NodePty; readonly path: string; readonly prebuild: boolean; readonly built: boolean }
  | { readonly error: string };

export const nodePtyDir = (): string =>
  join(fileURLToPath(new URL("../../", import.meta.url)), "apps", "server", "node_modules", "node-pty");

export const loadNodePty = (): NodePtyLoad => {
  const dir = nodePtyDir();
  if (!existsSync(dir)) return { error: `node-pty is not installed at ${dir}` };
  try {
    const require = createRequire(import.meta.url);
    const module = require(dir) as NodePty;
    return {
      module,
      path: dir,
      prebuild: existsSync(join(dir, "prebuilds", `${process.platform}-${process.arch}`, "pty.node")),
      built: existsSync(join(dir, "build", "Release", "pty.node")),
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
};
