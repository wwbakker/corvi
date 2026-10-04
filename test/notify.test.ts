import { test, expect } from "bun:test";
import {
  hostNotice,
  isViewing,
  noticeOf,
  noticeText,
  shouldNotify,
  type Notice,
} from "../apps/web/src/app-root/notify.tsx";
import type { TerminalWindow } from "../apps/web/src/domain/terminal.ts";

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

const WINDOW = {
  index: 0,
  id: "w-1",
  label: "Build",
  detail: "",
  attention: true,
  active: true,
  activity: false,
  panes: [],
  activePane: "s-1",
} as const satisfies TerminalWindow;

const NOTICE: Notice = { change: "PROJ-1681", window: "w-1", label: "Build", sound: true };

test("a change's identity for suppression is its source as well as its id", () => {
  const onScreen = {
    source: "remote-client",
    change: NOTICE.change,
    page: "terminals" as const,
    windows: [WINDOW],
  };
  const remote: Notice = { ...NOTICE, source: "remote-client" };
  // Looking straight at the remote change's window: silent.
  expect(isViewing(onScreen, remote)).toBe(true);
  // A local change sharing the id is a different change: looking at it is NOT looking at the
  // remote one, so the remote notice is not wrongly suppressed.
  expect(isViewing({ ...onScreen, source: "" }, remote)).toBe(false);
  // And the local notice is suppressed only by the local change, not by the remote one.
  const local: Notice = { ...NOTICE, source: "" };
  expect(isViewing({ ...onScreen, source: "" }, local)).toBe(true);
  expect(isViewing(onScreen, local)).toBe(false);
});

test("a local notify and a remote source envelope both read as a notice", () => {
  expect(noticeOf("notify", JSON.stringify(NOTICE))).toEqual({ notice: NOTICE, source: "" });
  const envelope = { source: "remote-client", event: "notify", data: JSON.stringify(NOTICE) };
  expect(noticeOf("source", JSON.stringify(envelope))).toEqual({
    notice: NOTICE,
    source: "remote-client",
  });
  // Another event in the envelope, and anything unreadable, is no notice.
  expect(
    noticeOf("source", JSON.stringify({ source: "x", event: "changes", data: "" })),
  ).toBeUndefined();
  expect(noticeOf("notify", "not json")).toBeUndefined();
  expect(noticeOf("source", "{")).toBeUndefined();
});

test("the host payload carries the source, and names it in the banner", () => {
  const local = hostNotice({ ...NOTICE, source: "" }, noticeText(NOTICE));
  expect(local.source).toBe("");
  expect(local.change).toBe(NOTICE.change);
  expect(local.window).toBe(NOTICE.window);
  // A local notice's banner says only the change.
  expect(local.subtitle).toBe(NOTICE.change);

  const remote = hostNotice({ ...NOTICE, source: "remote-client" }, noticeText(NOTICE));
  expect(remote.source).toBe("remote-client");
  // The banner names the server, the way the toast does, so two servers with the same id differ.
  expect(remote.subtitle).toBe(`remote-client · ${NOTICE.change}`);
  // A local and a remote notice for the same change id and window are different banners.
  expect(remote.id).not.toBe(local.id);
});

test("hyphens in ids do not collide two notices' banner keys", () => {
  const key = (notice: Notice): string => hostNotice(notice, noticeText(notice)).id;
  // ("a", "b-c") and ("a-b", "c") are different notices; a "-" separator would give both
  // "a-b-c-w" and let one replace the other's banner.
  const first = { ...NOTICE, source: "a", change: "b-c", window: "w" };
  const second = { ...NOTICE, source: "a-b", change: "c", window: "w" };
  expect(key(first)).not.toBe(key(second));
  // The same notice repeats its own key: a repeat replaces its banner rather than stacking one.
  expect(key(first)).toBe(key({ ...first }));
});
