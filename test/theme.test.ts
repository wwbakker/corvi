import { expect, test } from "bun:test";
import {
  CORVI_COLOURS,
  DEFAULT_THEME,
  isThemeId,
  THEMES,
  themeOf,
  coloursOf,
} from "../apps/web/src/domain/theme.ts";

/**
 * The theme vocabulary: which looks exist, which one a page starts in, and the fixed colours a
 * change wears in Spaces. The stylesheet owns what a theme looks like; these are the facts the
 * page and the settings picker share, and the ones a stored preference is read against.
 */

test("four themes are offered, Dusk first and as the default", () => {
  expect(THEMES.map((theme) => theme.id)).toEqual(["dusk", "ultramarine", "raven", "spaces"]);
  expect(THEMES[0]!.id).toBe(DEFAULT_THEME);
  expect(THEMES.map((theme) => theme.name)).toEqual(["Dusk", "Ultramarine", "Raven Black", "Spaces"]);
  // Every one names what it is, so the picker needs no second table of prose.
  for (const theme of THEMES) expect(theme.blurb.length).toBeGreaterThan(0);
});

test("a preference that names no known theme reads as Dusk", () => {
  expect(themeOf(null)).toBe("dusk");
  expect(themeOf(undefined)).toBe("dusk");
  expect(themeOf("")).toBe("dusk");
  expect(themeOf("dark")).toBe("dusk");
  expect(isThemeId("dark")).toBe(false);
  for (const theme of THEMES) {
    expect(themeOf(theme.id)).toBe(theme.id);
    expect(isThemeId(theme.id)).toBe(true);
  }
});

test("ideas and the overview keep Corvi's own pair", () => {
  expect(CORVI_COLOURS).toEqual({ from: "#2b1bd6", to: "#fd6701" });
  // An idea is not a job yet, and no id gives it a colour of its own.
  expect(coloursOf("PROJ-1", true)).toEqual(CORVI_COLOURS);
  expect(coloursOf("idea-agent-briefing", true)).toEqual(CORVI_COLOURS);
  // A change without an id cannot be derived from, so it keeps the pair too.
  expect(coloursOf("", false)).toEqual(CORVI_COLOURS);
});

test("a change's pair is its id's place in a fixed palette", () => {
  // Pinned: the pairs are stable, so a change looks the same on every device and after a
  // restart. Reordering the palette is a look change, not a refactor.
  expect(coloursOf("PROJ-1182", false)).toEqual({ from: "#0f8f7f", to: "#7be0b8" });
  expect(coloursOf("redesign-ui-layout", false)).toEqual({ from: "#3a20ff", to: "#fd6701" });

  // The same id is always the same pair, and it is not the pair of a different id.
  expect(coloursOf("PROJ-1182", false)).toEqual(coloursOf("PROJ-1182", false));
  expect(coloursOf("PROJ-1182", false)).not.toEqual(coloursOf("PROJ-1179", false));

  // The palette is colour pairs, not one hue: both halves are opaque hex colours and they
  // differ, so the gradient beside a name reads as two colours.
  for (const id of ["PROJ-1182", "PROJ-1179", "PROJ-1191", "PROJ-1168", "PROJ-1"]) {
    const pair = coloursOf(id, false);
    expect(pair.from).toMatch(/^#[0-9a-f]{6}$/);
    expect(pair.to).toMatch(/^#[0-9a-f]{6}$/);
    expect(pair.from).not.toBe(pair.to);
  }
});
