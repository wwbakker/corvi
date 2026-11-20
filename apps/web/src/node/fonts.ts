/**
 * The icon font every monospace surface falls back to, fetched at `bun install`.
 *
 * Programs in a terminal (pi's footer, prompts, file listings) print Nerd Font icons from the
 * Unicode Private Use Area, which no system font draws. Corvi serves the official symbols-only
 * Nerd Font so those icons render without the user installing anything. The font is fetched
 * rather than committed (2.6 MB of binary in git) and pinned by checksum, as `electron` and
 * `node-pty` fetch their binaries at install. The licences travel beside it: `LICENSE` covers
 * the patcher, the README's table lists each icon set's own licence.
 *
 * A failed fetch only warns, so an install without network still completes: the page then renders
 * as it did before the font existed, with the icons as empty boxes.
 *
 *   bun run fonts   # the root `postinstall` runs this too
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The Nerd Fonts release the files are pinned to. Bumping it means updating every checksum. */
const NERD_FONTS_TAG = "v3.5.1";

/** Where the pinned files are published: the release tag's symbols-only directory. */
export const NERD_FONTS_SOURCE = `https://raw.githubusercontent.com/ryanoasis/nerd-fonts/${NERD_FONTS_TAG}/patched-fonts/NerdFontsSymbolsOnly`;

/** The served font's file name; the stylesheet's `@font-face` names the same file. */
export const SYMBOLS_FONT_FILE = "SymbolsNerdFontMono-Regular.ttf";

interface PinnedFile {
  readonly name: string;
  readonly sha256: string;
}

/** The Mono variant: every icon fits one cell, as a terminal grid needs. */
const PINNED_FILES: readonly PinnedFile[] = [
  { name: SYMBOLS_FONT_FILE, sha256: "fe471e538392f51910faab985fa8e192a39dd3426125edd15b71b3680df0e749" },
  { name: "LICENSE", sha256: "84a7a98c82140fb12c37fe42b93805baa16024cb3e5acc599b7ffe612c55d847" },
  { name: "README.md", sha256: "ad2ab32b8e88e894f6a364c18774a0b6bc8dcb50f587d3ddb35090c33102ef5d" },
];

/** Where the fetched files live: `apps/web/fonts`, outside `src` (the build watches `src`) and
 * ignored by git. */
export const fontsDir: string = fileURLToPath(new URL("../../fonts", import.meta.url));

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const hasPinnedFile = async (dir: string, file: PinnedFile): Promise<boolean> => {
  try {
    return sha256Of(await readFile(join(dir, file.name))) === file.sha256;
  } catch {
    return false;
  }
};

/** Fetch one file, check it against its pin, and write it through a temp file: a reader never
 * sees a half-written or unverified font. */
const fetchPinnedFile = async (source: string, dir: string, file: PinnedFile): Promise<void> => {
  const response = await fetch(`${source}/${file.name}`);
  if (!response.ok) throw new Error(`${file.name}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = sha256Of(bytes);
  if (actual !== file.sha256) throw new Error(`${file.name}: sha256 ${actual}, expected ${file.sha256}`);
  const destination = join(dir, file.name);
  const temporary = `${destination}.tmp-${process.pid}`;
  await writeFile(temporary, bytes);
  await rename(temporary, destination);
};

/** Make `dir` hold the pinned files, fetched from `source` (`NERD_FONTS_SOURCE`, or a mirror of
 * it). Files already present and intact are kept, so a repeat install needs no network. Rejects
 * when a file cannot be fetched or does not match its pin; files fetched before it are kept. */
export async function ensureFonts(source: string, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const file of PINNED_FILES) {
    if (!(await hasPinnedFile(dir, file))) await fetchPinnedFile(source, dir, file);
  }
}

if (import.meta.main) {
  try {
    await ensureFonts(NERD_FONTS_SOURCE, fontsDir);
    console.log(`fonts: Nerd Fonts symbols ${NERD_FONTS_TAG} in ${fontsDir}`);
  } catch (e: unknown) {
    console.warn(
      `fonts: could not fetch the Nerd Fonts symbols (${e instanceof Error ? e.message : String(e)}); ` +
        "terminal icons will show as boxes. Retry with `bun run fonts`.",
    );
  }
}
