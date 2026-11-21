import { expect, test } from "bun:test";

import { characterOf, digitOf, isLeaderChord, keysFor } from "../apps/web/src/app-root/leader.tsx";

const chord = (over: Partial<Parameters<typeof isLeaderChord>[0]>): Parameters<typeof isLeaderChord>[0] => ({
  code: "Space",
  ctrlKey: true,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  ...over,
});

test("the leader is Ctrl+Space and nothing else", () => {
  expect(isLeaderChord(chord({}))).toBe(true);
  // The space bar alone is a space; the other modifiers are somebody else's chord.
  expect(isLeaderChord(chord({ ctrlKey: false }))).toBe(false);
  expect(isLeaderChord(chord({ shiftKey: true }))).toBe(false);
  expect(isLeaderChord(chord({ altKey: true }))).toBe(false);
  expect(isLeaderChord(chord({ metaKey: true }))).toBe(false);
  expect(isLeaderChord(chord({ code: "KeyK" }))).toBe(false);
});

test("a key is read by its position, not by the character a layout composes", () => {
  expect(characterOf("KeyQ")).toBe("q");
  expect(characterOf("KeyP")).toBe("p");
  // macOS reports a composed character for a letter under Option; the code is still the position.
  expect(characterOf("BracketLeft")).toBe("[");
  expect(characterOf("BracketRight")).toBe("]");
  expect(characterOf("Digit1")).toBeUndefined();
  expect(characterOf("Enter")).toBeUndefined();
});

test("the numbers run 1-9 and 0 for the tenth", () => {
  expect(digitOf("Digit1")).toBe(0);
  expect(digitOf("Digit9")).toBe(8);
  expect(digitOf("Digit0")).toBe(9);
  expect(digitOf("Numpad1")).toBe(0);
  expect(digitOf("Numpad0")).toBe(9);
  expect(digitOf("KeyA")).toBeUndefined();
});

test("a group's keys stop at the end of its row", () => {
  expect(keysFor("qwertyuiop", 3)).toEqual(["q", "w", "e"]);
  // A slot past the row is still a slot: the entries keep their positions, the key is empty.
  const overflow = keysFor("qwertyuiop", 12);
  expect(overflow.length).toBe(12);
  expect(overflow[9]).toBe("p");
  expect(overflow[10]).toBeUndefined();
  expect(overflow[11]).toBeUndefined();
});
