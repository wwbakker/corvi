import { test, expect } from "bun:test";
import { noticeText, shouldNotify } from "../src/web/notify.tsx";

/**
 * The page's half of the notification decision. The rule is deliberately "everything except
 * looking straight at it": the strict reading — never notify for the tab you are on — would stay
 * silent exactly when a notification helps, with the app behind another window.
 */
test("only looking straight at the window that wants you is silent", () => {
  expect(shouldNotify({ viewing: true, visible: true, focused: true })).toBe(false);
  // Backgrounded: notify, even with the right tab open.
  expect(shouldNotify({ viewing: true, visible: true, focused: false })).toBe(true);
  expect(shouldNotify({ viewing: true, visible: false, focused: true })).toBe(true);
  // Another change, or another page of this one.
  expect(shouldNotify({ viewing: false, visible: true, focused: true })).toBe(true);
});

test("the notice reads as the session's name and what it just said", () => {
  const base = { change: "PROJ-1681", window: "@7", label: "Build PROJ-1681", sound: true };
  expect(noticeText(base)).toEqual({ title: "Build PROJ-1681", body: "waiting for you" });
  expect(noticeText({ ...base, note: "I fixed the layout." })).toEqual({
    title: "Build PROJ-1681",
    body: "I fixed the layout.",
  });
  // A presenter that said nothing falls back to the plain sentence.
  expect(noticeText({ ...base, note: "   " }).body).toBe("waiting for you");
});
