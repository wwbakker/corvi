import { expect, test } from "bun:test";

import type { TerminalWindow } from "@corvi/contracts/terminal";
import { cursorRow } from "../apps/web/src/terminals/client/SelectTerminalDialog.tsx";

/**
 * The select-terminal dialog's cursor, which is what `Enter` picks. It is a window id rather than a
 * position, so a list that reorders or loses a row under the open dialog cannot make `Enter` pick
 * the row that moved into the place of the one the user was looking at.
 */
const terminalWindow = (id: string, active: boolean): TerminalWindow => ({
  index: 0,
  id,
  label: id,
  detail: "",
  attention: false,
  active,
  activity: false,
  panes: [id],
  activePane: id,
});

const windows = [terminalWindow("w0", false), terminalWindow("w1", true), terminalWindow("w2", false)];

test("before the arrows move, the cursor is on the window on screen", () => {
  expect(cursorRow(windows, null)).toBe(1);
});

test("an empty list has no active row, and the cursor still names its first", () => {
  expect(cursorRow([], null)).toBe(0);
});

test("a window that is still there keeps the cursor on its row, wherever it has moved to", () => {
  // The same windows in another order: the id follows the window, not the position it had.
  expect(cursorRow([windows[2]!, windows[0]!, windows[1]!], "w2")).toBe(0);
  expect(cursorRow(windows, "w2")).toBe(2);
});

test("a window that is gone takes the cursor with it, instead of handing it to its replacement", () => {
  // `w1` exited while the dialog was open; `w2` slid into its row. Nothing is highlighted, so
  // `Enter` picks nothing rather than picking `w2` by accident.
  expect(cursorRow([windows[0]!, windows[2]!], "w1")).toBe(-1);
});
