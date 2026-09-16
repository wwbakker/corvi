import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { writeAtomic } from "../capabilities/files.ts";
import { stateDir } from "../capabilities/identity.ts";
import { loaded } from "./index.ts";

/**
 * The browser halves of out-of-tree extensions, built for the page.
 *
 * A discovered extension's client.tsx is TypeScript the page cannot bundle — it was written
 * after the page was built, or changes without one. So the server builds it, once at startup
 * into the state directory, and serves it at /extensions/<name>/client.js; the page imports
 * that URL at runtime when a step's extension has no static entry (src/extension-host/client.tsx).
 *
 * The chunk is built with react and its jsx runtimes external, and the import map in the page
 * (src/app-root/index.html) resolves those specifiers to the vendor chunks built here from the
 * app's own react entrypoints — so an out-of-tree step runs on the same react the page runs,
 * as nearly as serving allows. Two reacts break hooks and context; a chunk that bundled its
 * own would be a step that crashes the moment it called useState.
 *
 * esbuild, rather than Bun's bundler: this runs inside the server, which is Node now
 * (docs/decisions/node-server.md), and esbuild runs on both.
 */

/** Where the built chunks live, alongside the app's other writable state. */
export const chunkRoot = join(stateDir(), "client-chunks");

const vendorDir = join(chunkRoot, "vendor");

/** Where an extension's built client chunk lives. The extension's name is the route's
 * identity, so it is the file's name; basename keeps a strange name inside the directory. */
export const clientChunkPath = (name: string): string => join(chunkRoot, `${basename(name)}.js`);

/** The specifiers an out-of-tree client chunk may not bundle: the react family comes from the
 * page, through the import map, never from the chunk itself. */
const external = [
  "react",
  "react-dom",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom/client",
];

/** Resolve a package specifier against this module — the app's own node_modules, which is the
 * point: the vendor chunks must be the react the page's bundle was built from. */
const require = createRequire(import.meta.url);
const entrypointOf = (specifier: string): string => require.resolve(specifier);

/** One browser bundle from one entrypoint. The three options below are the whole contract:
 * ESM (the page imports it as a module), react (and its family) left to the page's import map,
 * and the tsconfig's own jsx setting, which esbuild reads. Written into place atomically: a
 * running server serves the chunk directory, and a rebuild must not race its readers. */
const browserBundle = async (entrypoint: string, outfile: string, externals: string[]): Promise<void> => {
  const result = await build({
    entryPoints: [entrypoint],
    outfile,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: externals,
    logLevel: "silent",
    write: false,
  });
  for (const file of result.outputFiles) await writeAtomic(file.path, file.contents);
};

/** The vendor chunks, one build per file because the entrypoints are all called index.js and a
 * shared naming template would name them alike. The jsx chunk's entry (vendor-jsx.ts) re-exports
 * both jsx runtimes, so /vendor/react-jsx-runtime.js answers both specifiers the import map
 * points at it — whichever of the two the client chunk was transpiled against. */
async function buildVendorChunks(): Promise<void> {
  const entries: [string, string][] = [
    ["react.js", entrypointOf("react")],
    ["react-dom.js", entrypointOf("react-dom")],
    ["react-jsx-runtime.js", join(import.meta.dirname, "vendor-jsx.ts")],
    ["react-dom-client.js", entrypointOf("react-dom/client")],
  ];
  for (const [file, entrypoint] of entries) {
    await browserBundle(entrypoint, join(vendorDir, file), []);
  }
}

/** Build every discovered extension's client.tsx, and the vendor chunks beneath them. Called
 * once at startup, after the extensions have loaded — so the discovered client paths are
 * known — and before the server listens, so the first page never races the chunks. A failed
 * build is that extension without a client half on the page: the wizard says so, and the
 * server stands. */
export async function buildClientChunks(): Promise<void> {
  mkdirSync(vendorDir, { recursive: true });
  await buildVendorChunks();
  for (const ext of loaded) {
    if (!ext.clientPath) continue;
    try {
      await browserBundle(ext.clientPath, clientChunkPath(ext.name), external);
    } catch (e) {
      console.error(
        `the client half of "${ext.name}" did not build: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
}
