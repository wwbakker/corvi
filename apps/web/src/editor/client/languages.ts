import type { LanguageDescription } from "@codemirror/language";

/**
 * The languages a fenced code block may name, for the editor to highlight inside the fence.
 *
 * The page is one bundle with no runtime imports (`test/bundle.test.ts`), so every language here
 * is statically bundled and this list is the bundle's weight. It starts empty — fences then read
 * as one plain tone — and is filled with a measured, curated set once the growth is known.
 */
export const fencedCodeLanguages: readonly LanguageDescription[] = [];
