/**
 * The looks Corvi wears, and the colours a change carries in the Spaces theme.
 *
 * A theme is a set of design tokens in `apps/web/src/app-root/styles.css`: the stylesheet owns
 * every colour, and this module owns only which theme is which and what a change's colours are.
 * The choice itself is per device and lives in a cookie (`apps/web/src/app-root/theme.ts`).
 */

export type ThemeId = "dusk" | "ultramarine" | "raven" | "spaces";

/** A theme as Settings offers it: the id the stylesheet keys on, and the words beside it. */
export interface ThemeChoice {
  readonly id: ThemeId;
  readonly name: string;
  readonly blurb: string;
}

/** The themes, in the order Settings lists them. */
export const THEMES: readonly ThemeChoice[] = [
  {
    id: "dusk",
    name: "Dusk",
    blurb: "The dusk sky behind frosted panels: ultramarine, violet and orange, with hills below.",
  },
  {
    id: "ultramarine",
    name: "Ultramarine",
    blurb: "A solid ultramarine column, a deep-navy page and translucent blue cards.",
  },
  {
    id: "raven",
    name: "Raven Black",
    blurb:
      "Pure black, and colour as solid blocks: ultramarine for the selection, orange for what wants you.",
  },
  {
    id: "spaces",
    name: "Spaces",
    blurb: "Every change lights the page with its own colour, drawn from its id.",
  },
];

/** Dusk is the default: a stored preference that names no known theme falls back to it. */
export const DEFAULT_THEME: ThemeId = "dusk";

export const isThemeId = (value: string | null | undefined): value is ThemeId =>
  THEMES.some((theme) => theme.id === value);

export const themeOf = (value: string | null | undefined): ThemeId =>
  isThemeId(value) ? value : DEFAULT_THEME;

/** Two colours that belong together: the page's light, and the accent beside it. */
export interface ColourPair {
  readonly from: string;
  readonly to: string;
}

/** Corvi's own pair: ultramarine and orange. The overview and ideas keep it in every theme. */
export const CORVI_COLOURS: ColourPair = { from: "#2b1bd6", to: "#fd6701" };

/** The fixed palette a change's pair comes from in Spaces. Its order is part of the look: a
 * change's index is derived from its id, so the pairs are never shuffled. */
const SPACE_COLOURS: readonly ColourPair[] = [
  { from: "#3a20ff", to: "#fd6701" },
  { from: "#0f8f7f", to: "#7be0b8" },
  { from: "#006e8f", to: "#36d1c4" },
  { from: "#8a1fb8", to: "#ff4fa0" },
  { from: "#7a1030", to: "#ff7a59" },
  { from: "#1f5fd6", to: "#7ad1ff" },
  { from: "#0b6b3a", to: "#8ff0a4" },
  { from: "#8a5a10", to: "#ffd166" },
];

/** FNV-1a: small, stable, and spread well enough for ids that only differ in their digits. */
const hash = (id: string): number => {
  let value = 2166136261;
  for (let index = 0; index < id.length; index++) {
    value ^= id.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
};

/** The pair a change wears in Spaces. An idea is not a job yet and keeps Corvi's own colours;
 * a change's pair is its id's place in the palette, so it is the same on every device. */
export const coloursOf = (id: string, idea: boolean): ColourPair =>
  idea || id === "" ? CORVI_COLOURS : SPACE_COLOURS[hash(id) % SPACE_COLOURS.length]!;
