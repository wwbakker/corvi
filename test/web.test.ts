import { test, expect, beforeEach, afterEach } from "bun:test";
import type { Change } from "../src/domain/change.ts";
import { aborted } from "../src/app-root/api.ts";
import { stateClass } from "../src/app-root/stateClass.ts";
import { changeNav, resolveChangePage } from "../src/change-page/client/changeTabs.ts";
import { moment } from "../src/app-root/moment.ts";
import { getPref, setPref } from "../src/app-root/prefs.ts";
import {
  ALL,
  DEFAULT_WORKSPACE,
  inWorkspace,
  workspaceOf,
  type Workspace,
} from "../src/workspace/client/workspaces.ts";

/**
 * The web client's pure logic: the pieces that decide what the sidebar shows, how a state is
 * coloured, how a timestamp reads, what a preference round-trips, and how the shared API client
 * turns a response into a value or an error.
 *
 * The React hooks in workspaces.ts (useWorkspaces/usePages) are deliberately not exercised here:
 * they need a mounted renderer and an effect loop, and there is no DOM in this test run. The
 * pure functions they are built on — workspaceOf/inWorkspace — are what the filtering rules
 * actually are.
 */

/** A change with only the fields the workspace filter reads; the rest is fixture noise. */
const change = (fields: Partial<Change> = {}): Change => ({
  id: "PROJ-1",
  branch: "PROJ-1-x",
  repos: ["/repos/example-api"],
  createdAt: "2024-01-02T03:04:05Z",
  ...fields,
});

const client: Workspace = { id: "client", name: "Client" };
const mine: Workspace = { id: "mine", name: "Mine" };
const both: Workspace[] = [client, mine];

test("a change with no workspace belongs to the first one, which is where it was written", () => {
  expect(workspaceOf(change(), both)).toBe("client");
  // An explicit workspace wins over the first.
  expect(workspaceOf(change({ workspace: "mine" }), both)).toBe("mine");
  // With nothing configured there is still one answer: everything.
  expect(workspaceOf(change(), [])).toBe(ALL);
  // An empty id is present, not absent: `??` keeps it.
  expect(workspaceOf(change({ workspace: "" }), both)).toBe("");
});

test("the everything filter keeps every change, and a workspace keeps its own", () => {
  const untagged = change({ id: "untagged" });
  const tagged = change({ id: "tagged", workspace: "mine" });
  const changes = [untagged, tagged];

  expect(inWorkspace(changes, ALL, both)).toEqual(changes);

  // "client" is where untagged changes live, so the untagged one is included and the mine one is
  // not.
  expect(inWorkspace(changes, "client", both).map((c) => c.id)).toEqual(["untagged"]);
  expect(inWorkspace(changes, "mine", both).map((c) => c.id)).toEqual(["tagged"]);

  // A workspace that is no longer in the config still filters by the id it was written with:
  // the change itself is the source of truth, not the survivor list.
  expect(inWorkspace([change({ workspace: "gone" }), untagged], "gone", both)).toHaveLength(1);
});

test("the default workspace is the one src/domain/config.ts defines", () => {
  expect(DEFAULT_WORKSPACE).toEqual({ id: "default", name: "Default workspace" });
  // "everything" is a filter, not a workspace: it is not one of the configured ids.
  expect(both.map((w) => w.id)).not.toContain(ALL);
});

test("a state becomes one class, lowercased with spaces as dashes", () => {
  expect(stateClass("In Progress")).toBe("state-in-progress");
  expect(stateClass("Awaiting Review")).toBe("state-awaiting-review");
  expect(stateClass("Blocked")).toBe("state-blocked");
  expect(stateClass("Completed")).toBe("state-completed");
  expect(stateClass("Cancelled")).toBe("state-cancelled");
  // Absent means the default state: "In Progress".
  expect(stateClass()).toBe("state-in-progress");
  expect(stateClass(undefined)).toBe("state-in-progress");
  // A state an extension wrote is still a safe class name: runs of whitespace collapse to one
  // dash each, not one per character.
  expect(stateClass("Some  Weird\tState")).toBe("state-some-weird-state");
});

test("a change's page id resolves to the core, an offered tab, or the dashboard", () => {
  const review = { id: "review", title: "Review changes", extension: "review" };
  const tab = { id: "ci", title: "CI", extension: "ci" };
  const tabs = [review, tab];

  expect(resolveChangePage("dashboard", tabs)).toEqual({ kind: "dashboard" });
  expect(resolveChangePage("terminals", tabs)).toEqual({ kind: "terminals" });
  expect(resolveChangePage("ci", tabs)).toEqual({ kind: "tab", tab });
  // "Review changes" is an extension tab now, so it resolves through the offered list.
  expect(resolveChangePage("review", tabs)).toEqual({ kind: "tab", tab: review });

  // An id nobody offered — a stale URL, a tab the extension stopped declaring, `review` on a
  // workspace that dropped the extension — is the dashboard, so the page still renders
  // something rather than a blank page.
  expect(resolveChangePage("gone", tabs)).toEqual({ kind: "dashboard" });
  expect(resolveChangePage("gone", [])).toEqual({ kind: "dashboard" });
  expect(resolveChangePage("review", [])).toEqual({ kind: "dashboard" });
  expect(resolveChangePage("review", [tab])).toEqual({ kind: "dashboard" });
});

test("the change nav is the core's dashboard and then the extensions' in load order", () => {
  expect(changeNav([])).toEqual([{ id: "dashboard", title: "Dashboard" }]);
  expect(
    changeNav([
      { id: "review", title: "Review changes", extension: "review" },
      { id: "ci", title: "CI", extension: "ci" },
      { id: "jira", title: "Issues", extension: "jira" },
    ]),
  ).toEqual([
    { id: "dashboard", title: "Dashboard" },
    { id: "review", title: "Review changes" },
    { id: "ci", title: "CI" },
    { id: "jira", title: "Issues" },
  ]);
  // A contributed id that would shadow a core page is dropped: the core addressed it first.
  expect(changeNav([{ id: "terminals", title: "Terminals again", extension: "x" }])).toEqual([
    { id: "dashboard", title: "Dashboard" },
  ]);
});

test("a timestamp reads as local date and time, zero-padded to the minute", () => {
  // Local components in, local components out: the expected value is built from the same
  // wall-clock time the formatter should read, so the assertion holds in every timezone.
  const at = (y: number, mo: number, d: number, h: number, mi: number): string =>
    moment(new Date(y, mo, d, h, mi).toISOString());

  expect(at(2024, 2, 5, 9, 7)).toBe("2024-03-05 09:07");
  // Every field single-digit is still padded, including midnight.
  expect(at(2024, 0, 2, 3, 4)).toBe("2024-01-02 03:04");
  expect(at(2024, 5, 7, 0, 0)).toBe("2024-06-07 00:00");
  // And the shape is always YYYY-MM-DD HH:MM.
  expect(at(2024, 11, 31, 23, 59)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

// The cookie jar the browser would keep. `setPref` assigns the whole cookie string, and `getPref`
// reads it back, so a single string is enough to exercise both sides.
let cookie = "";

beforeEach(() => {
  cookie = "";
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: {
      get cookie(): string {
        return cookie;
      },
      set cookie(value: string) {
        cookie = value;
      },
    },
  });
});

afterEach(() => {
  // Bun has no document of its own; removing it is how the global is left as found.
  delete (globalThis as { document?: unknown }).document;
});

test("a preference is read from among the other cookies, or is absent", () => {
  expect(getPref("corvi:workspace")).toBeNull();

  cookie = "theme=dark; corvi:workspace=mine; other=1";
  expect(getPref("corvi:workspace")).toBe("mine");
  expect(getPref("other")).toBe("1");

  // The decoded value is what was stored, not the percent-encoded form.
  cookie = "corvi:workspace=My%20Client%2Fteam";
  expect(getPref("corvi:workspace")).toBe("My Client/team");

  // A key that is a prefix of another cookie's name is not that cookie.
  cookie = "corvi:workspace2=x";
  expect(getPref("corvi:workspace")).toBeNull();
});

test("a preference is written with the attributes that survive a fresh port", () => {
  setPref("corvi:workspace", "My Client");
  expect(cookie).toBe(
    "corvi:workspace=My%20Client; max-age=315360000; path=/; SameSite=Lax",
  );

  // The key is written as-is, the value is encoded.
  setPref("corvi:workspace", "a/b&c=d");
  expect(cookie.startsWith("corvi:workspace=a%2Fb%26c%3Dd;")).toBe(true);
});

test("a preference written and read back is the value that was set", () => {
  setPref("corvi:workspace", "My Client / team");
  expect(getPref("corvi:workspace")).toBe("My Client / team");
});

test("only an abort is an abort", () => {
  // Fetch aborts arrive as a DOMException with the AbortError name.
  expect(aborted(new DOMException("The operation was aborted.", "AbortError"))).toBe(true);
  expect(aborted(Object.assign(new Error("cancelled"), { name: "AbortError" }))).toBe(true);

  expect(aborted(new Error("boom"))).toBe(false);
  expect(aborted({ name: "AbortError" })).toBe(false);
  expect(aborted("AbortError")).toBe(false);
  expect(aborted(undefined)).toBe(false);
});
