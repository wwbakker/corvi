import { Effect } from "effect";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { config, expandTilde } from "../config.ts";
import { workspaceById } from "../workspaces.ts";
import { capabilitiesLayer } from "./services.ts";
import { install } from "./registry.ts";
import type { ExtensionModule } from "./api.ts";

/**
 * Discovery and loading: the built-ins are joined, after them, by out-of-tree extensions
 * discovered from the config and imported from disk — through the same install/factory path, so
 * the contract (docs/guides/extensions.md) does not change with the extension's address.
 */

/** Install one module: a static description as-is, a factory run once with the startup
 * capabilities. A failed factory is an extension absent, with the error logged — a broken
 * optional plugin does not take the dashboard down. Shared by the built-ins and the
 * out-of-tree discovery, so the two load exactly alike. */
async function installModule(mod: ExtensionModule, clientPath?: string): Promise<void> {
  if (typeof mod !== "function") {
    install(mod, clientPath);
    return;
  }
  try {
    const ext = await Effect.runPromise(
      mod().pipe(
        // The default workspace stands in for the request's: there is no request at startup,
        // and load-time Shell runs with its environment (docs/guides/extensions.md).
        Effect.provide(capabilitiesLayer(workspaceById(undefined))),
      ),
    );
    install(ext, clientPath);
  } catch (e) {
    console.error(
      `an extension failed to load and is skipped: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Load every module, in order. A failed factory is an extension absent, with the error
 * logged — a broken optional plugin does not take the dashboard down.
 *
 * Awaited at module scope in the host, so the server does not start listening before the
 * extensions have loaded, and a test importing the host sees the fully-loaded registry. */
export async function loadAll(mods: readonly ExtensionModule[]): Promise<void> {
  for (const mod of mods) await installModule(mod);
}

/** The directory searched for out-of-tree extensions without being configured: it exists on a
 * machine that keeps extensions there, and is absent everywhere else — a convention, not a
 * setting, so it never appears in the config file the settings page edits. */
export const defaultExtensionDir = (): string =>
  join(homedir(), ".config", "iwe", "extensions");

/** Expand the configured extension paths into module files. A path that is a file is the
 * module; a directory contributes its immediate .ts files plus any subdirectory's index.ts, in directory
 * order. A path that does not exist is logged and skipped — one broken entry costs nothing.
 * Duplicates are ignored, first mention wins. Defaults to the configured paths plus the
 * implicit default directory, searched last — silently: its absence is the ordinary case,
 * not something to log. */
export function extensionModulePaths(
  paths: readonly string[] = [
    ...config.extensionPaths,
    ...(existsSync(defaultExtensionDir()) ? [defaultExtensionDir()] : []),
  ],
): string[] {
  const seen = new Set<string>();
  const modules: string[] = [];
  for (const raw of paths) {
    const path = expandTilde(raw);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      console.error(`extension path does not exist, skipped: ${path}`);
      continue;
    }
    const found: string[] = [];
    if (stat.isFile()) {
      found.push(path);
    } else if (stat.isDirectory()) {
      const entries = readdirSync(path, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".ts")) {
          found.push(join(path, entry.name));
        } else if (entry.isDirectory() && existsSync(join(path, entry.name, "index.ts"))) {
          found.push(join(path, entry.name, "index.ts"));
        }
      }
    } else {
      console.error(`extension path is neither a file nor a directory, skipped: ${path}`);
    }
    for (const module of found) {
      if (!seen.has(module)) {
        seen.add(module);
        modules.push(module);
      }
    }
  }
  return modules;
}

/** The sibling client.tsx of a discovered module file, when it exists — the half the server
 * builds into a chunk for the page (src/extensions/clientChunks.ts). */
const siblingClient = (modulePath: string): string | undefined => {
  const client = join(dirname(modulePath), "client.tsx");
  return existsSync(client) ? client : undefined;
};

/** Load the out-of-tree extensions: import each discovered module from disk and run it
 * through the same install/factory path as the built-ins. Every failure — a missing file, a
 * module that throws on import, one without a default export, a failed factory — is logged
 * and skipped: a broken optional extension is an extension absent, never a failed server. */
export async function loadDiscovered(paths?: readonly string[]): Promise<void> {
  for (const modulePath of extensionModulePaths(paths)) {
    try {
      const mod = (await import(pathToFileURL(modulePath).href)) as {
        default?: ExtensionModule;
      };
      if (!mod.default) {
        console.error(`an extension module without a default export is skipped: ${modulePath}`);
        continue;
      }
      await installModule(mod.default, siblingClient(modulePath));
    } catch (e) {
      console.error(
        `an extension failed to load and is skipped: ${modulePath}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
}
