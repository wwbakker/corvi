import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loaded } from "./index.ts";

/**
 * The browser halves of out-of-tree extensions, built for the page.
 *
 * A discovered extension's client.tsx is TypeScript the page cannot bundle — it was written
 * after the page was built, or changes without one. So the server builds it, once at startup
 * into the XDG state directory, and serves it at /extensions/<name>/client.js; the page
 * imports that URL at runtime when a step's extension has no static entry
 * (src/web/extensions.tsx).
 *
 * The chunk is built with react and its jsx runtimes external, and the import map in the page
 * (src/web/index.html) resolves those specifiers to the vendor chunks built here from the
 * app's own react entrypoints — so an out-of-tree step runs on the same react the page runs,
 * as nearly as serving allows. Two reacts break hooks and context; a chunk that bundled its
 * own would be a step that crashes the moment it called useState.
 */

/** Where the built chunks live, alongside the app's other writable state. */
export const chunkRoot = join(
  process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
  "iwe",
  "client-chunks",
);

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

/** Resolve a package specifier against this module — the app's own node_modules, which is
 * the point: the vendor chunks must be the react the page's bundle was built from. */
const entrypointOf = (specifier: string): string => {
  const resolved = Bun.resolveSync(specifier, import.meta.dir);
  return resolved.startsWith("file://") ? fileURLToPath(resolved) : resolved;
};

/** The vendor chunks, one build per file because the entrypoints are all called index.js and
 * a shared naming template would name them alike. The jsx chunk's entry (vendor-jsx.ts)
 * re-exports both jsx runtimes, so /vendor/react-jsx-runtime.js answers both specifiers the
 * import map points at it — whichever of the two the client chunk was transpiled against. */
async function buildVendorChunks(): Promise<void> {
  const entries: [string, string][] = [
    ["react.js", entrypointOf("react")],
    ["react-dom.js", entrypointOf("react-dom")],
    ["react-jsx-runtime.js", join(import.meta.dir, "vendor-jsx.ts")],
    ["react-dom-client.js", entrypointOf("react-dom/client")],
  ];
  for (const [file, entrypoint] of entries) {
    await Bun.build({
      entrypoints: [entrypoint],
      outdir: vendorDir,
      naming: file,
      target: "browser",
    });
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
      await Bun.build({
        entrypoints: [ext.clientPath],
        outdir: chunkRoot,
        naming: `${basename(ext.name)}.js`,
        target: "browser",
        external: [...external],
      });
    } catch (e) {
      console.error(
        `the client half of "${ext.name}" did not build: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
}
