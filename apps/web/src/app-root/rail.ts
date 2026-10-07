/**
 * The rail's pure vocabulary: what an avatar says, what hue it wears, and which glyph a page
 * draws. Kept out of the components so the rules can be tested without a renderer, and so the
 * same change wears the same everything wherever it is drawn.
 */

/** How many hues the avatar palette names (`--avatar-1` … in styles.css). */
export const PALETTE_SIZE = 6;

/** One or two letters from a title's first word or words, uppercase; the id when there is no
 * title. Words are stripped to letters and digits first, so punctuation never becomes an avatar. */
export const initials = (title: string | undefined, id: string): string => {
  const words = (title ?? "")
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((word) => word !== "");
  if (words.length === 0) {
    return id.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2).toUpperCase() || "?";
  }
  const letters =
    words.length >= 2 ? `${words[0]![0] ?? ""}${words[1]![0] ?? ""}` : (words[0] ?? "").slice(0, 2);
  return letters.toUpperCase();
};

/** A stable index into the avatar palette for a change id: a change always looks the same, and
 * no call site chooses a colour. */
export const paletteIndex = (id: string, size: number = PALETTE_SIZE): number => {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % size;
};

/** The glyph a page draws. The core knows a small set of names; a page that declares none — or
 * one the core does not know — gets the generic page. */
export type PageGlyph = "leftovers" | "page";

export const pageGlyph = (icon: string | undefined): PageGlyph =>
  icon === "leftovers" ? "leftovers" : "page";
