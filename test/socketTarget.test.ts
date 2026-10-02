import { expect, test } from "bun:test";

import { shouldKeepSocket } from "../apps/web/src/terminals/client/socketTarget.ts";

/**
 * The pane's socket-target guard. The page has one socket; when the pane it names changes it must
 * close and reconnect — except for the unnamed first connect, which the server resolves to the
 * same pane the window list then names.
 */
test("the unnamed first connect keeps its socket once the window list names the resolved pane", () => {
  expect(shouldKeepSocket({ unnamed: true, resolved: "A", sessionId: "A" })).toBe(true);
});

test("a switch to another pane reconnects", () => {
  // A -> B: the current socket is the unnamed first connect but resolved A, and the page now B.
  expect(shouldKeepSocket({ unnamed: true, resolved: "A", sessionId: "B" })).toBe(false);
});

test("a same-named target after a switch reconnects: a stale resolved id is not evidence", () => {
  // A -> B -> A. The current socket was opened for a named pane (B), so it is not the unnamed
  // first connect; a resolved id still reading A belongs to the socket that was already closed.
  expect(shouldKeepSocket({ unnamed: false, resolved: "A", sessionId: "A" })).toBe(false);
  // Or the current socket is B's and its own frame has arrived.
  expect(shouldKeepSocket({ unnamed: false, resolved: "B", sessionId: "A" })).toBe(false);
  // Or the current socket is still unnamed but its frame resolved B.
  expect(shouldKeepSocket({ unnamed: true, resolved: "B", sessionId: "A" })).toBe(false);
});

test("a target with no named pane never keeps a stray socket", () => {
  expect(shouldKeepSocket({ unnamed: true, resolved: "A", sessionId: null })).toBe(false);
  expect(shouldKeepSocket({ unnamed: true, resolved: null, sessionId: "A" })).toBe(false);
});
