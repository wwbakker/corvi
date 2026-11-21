import { expect, test } from "bun:test";

import { isConfirmChord } from "../apps/web/src/app-root/confirmShortcut.ts";

type Chord = Parameters<typeof isConfirmChord>[0];

const chord = (over: Partial<Chord> = {}): Chord => ({
  code: "Enter",
  ctrlKey: true,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

test("the confirm key is Ctrl+Enter and nothing else", () => {
  expect(isConfirmChord(chord())).toBe(true);
  expect(isConfirmChord(chord({ code: "NumpadEnter" }))).toBe(true);
  // Enter alone, and every other modifier, belongs to whoever else has it (the editor's
  // insertBlankLine, the dialog's focused button, the shell).
  expect(isConfirmChord(chord({ ctrlKey: false }))).toBe(false);
  expect(isConfirmChord(chord({ metaKey: true }))).toBe(false);
  expect(isConfirmChord(chord({ altKey: true }))).toBe(false);
  expect(isConfirmChord(chord({ shiftKey: true }))).toBe(false);
  expect(isConfirmChord(chord({ code: "KeyN" }))).toBe(false);
});
