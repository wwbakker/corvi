import { test, expect, beforeEach, afterEach } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { checkoutsOf } from "./helpers.ts";
import type { Change } from "@corvi/changes/record";
import { aborted } from "../apps/web/src/app-root/api.ts";
import { stateClass } from "../apps/web/src/app-root/stateClass.ts";
import { changeNav, resolveChangePage } from "../apps/web/src/change-page/client/changeTabs.ts";
import { moment } from "../apps/web/src/app-root/moment.ts";
import { getPref, setPref } from "../apps/web/src/app-root/prefs.ts";
import {
  initials,
  pageGlyph,
  paletteIndex,
  PALETTE_SIZE,
  windowGlyph,
} from "../apps/web/src/app-root/rail.ts";
import { WindowIcon } from "../apps/web/src/app-root/icons.tsx";
import {
  ALL,
  DEFAULT_WORKSPACE,
  inWorkspace,
  workspaceOf,
  type Workspace,
} from "../apps/web/src/workspace/client/workspaces.ts";

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
  checkouts: checkoutsOf(["/repos/example-api"]),
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

test("the default workspace is the one @corvi/configuration/config defines", () => {
  expect(DEFAULT_WORKSPACE).toEqual({ id: "default", name: "Default workspace" });
  // "everything" is a filter, not a workspace: it is not one of the configured ids.
  expect(both.map((w) => w.id)).not.toContain(ALL);
});

test("a state becomes one class, lowercased with spaces as dashes", () => {
  expect(stateClass("Implementation")).toBe("state-implementation");
  expect(stateClass("Verification")).toBe("state-verification");
  expect(stateClass("Blocked")).toBe("state-blocked");
  expect(stateClass("Completed")).toBe("state-completed");
  expect(stateClass("Cancelled")).toBe("state-cancelled");
  // Absent means the default state: "Implementation".
  expect(stateClass()).toBe("state-implementation");
  expect(stateClass(undefined)).toBe("state-implementation");
  // A state an extension wrote is still a safe class name: runs of whitespace collapse to one
  // dash each, not one per character.
  expect(stateClass("Some  Weird\tState")).toBe("state-some-weird-state");
});

test("a change's page id resolves to the core, an offered tab, or the plan", () => {
  const review = { id: "review", title: "Review changes", extension: "review" };
  const tab = { id: "ci", title: "CI", extension: "ci" };
  const tabs = [review, tab];

  expect(resolveChangePage("dashboard", tabs)).toEqual({ kind: "dashboard" });
  expect(resolveChangePage("plan", tabs)).toEqual({ kind: "plan" });
  expect(resolveChangePage("terminals", tabs)).toEqual({ kind: "terminals" });
  expect(resolveChangePage("ci", tabs)).toEqual({ kind: "tab", tab });
  // "Review changes" is an extension tab now, so it resolves through the offered list.
  expect(resolveChangePage("review", tabs)).toEqual({ kind: "tab", tab: review });

  // An id nobody offered — a stale URL, a tab the extension stopped declaring, `review` on a
  // workspace that dropped the extension — is the plan, where a change opens, so the page
  // still renders something rather than a blank page.
  expect(resolveChangePage("gone", tabs)).toEqual({ kind: "plan" });
  expect(resolveChangePage("gone", [])).toEqual({ kind: "plan" });
  expect(resolveChangePage("review", [])).toEqual({ kind: "plan" });
  expect(resolveChangePage("review", [tab])).toEqual({ kind: "plan" });
});

test("the change nav is the plan, the dashboard, the subagents, and then the extensions' tabs in load order", () => {
  expect(changeNav([])).toEqual([
    { id: "plan", title: "Plan" },
    { id: "dashboard", title: "Dashboard" },
    { id: "subagents", title: "Subagents" },
  ]);
  expect(
    changeNav([
      { id: "review", title: "Review changes", extension: "review" },
      { id: "ci", title: "CI", extension: "ci" },
      { id: "jira", title: "Issues", extension: "jira" },
    ]),
  ).toEqual([
    { id: "plan", title: "Plan" },
    { id: "dashboard", title: "Dashboard" },
    { id: "subagents", title: "Subagents" },
    { id: "review", title: "Review changes" },
    { id: "ci", title: "CI" },
    { id: "jira", title: "Issues" },
  ]);
  // A contributed id that would shadow a core page is dropped: the core addressed it first.
  expect(
    changeNav([
      { id: "terminals", title: "Terminals again", extension: "x" },
      { id: "plan", title: "Theirs", extension: "x" },
    ]),
  ).toEqual([
    { id: "plan", title: "Plan" },
    { id: "dashboard", title: "Dashboard" },
    { id: "subagents", title: "Subagents" },
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

test("an avatar takes one or two initials, falling back to the id", () => {
  // Two words: a letter from each.
  expect(initials("Anonymise customer names", "PROJ-1")).toBe("AC");
  // One word: its first two letters.
  expect(initials("Release", "PROJ-2")).toBe("RE");
  // Punctuation is stripped before a letter is taken, so it never becomes an initial.
  expect(initials("Fix #12 bug", "PROJ-3")).toBe("F1");
  // Nothing to name it by: the id, letters and digits only.
  expect(initials("", "PROJ-123")).toBe("PR");
  expect(initials(undefined, "PROJ-123")).toBe("PR");
  // An id with nothing usable still gives a mark rather than an empty avatar.
  expect(initials(undefined, "---")).toBe("?");
});

test("a change id maps to one stable palette hue in range", () => {
  const index = paletteIndex("PROJ-1");
  expect(index).toBeGreaterThanOrEqual(0);
  expect(index).toBeLessThan(PALETTE_SIZE);
  // The same id always wears the same hue, whatever the palette size.
  expect(paletteIndex("PROJ-1")).toBe(index);
  expect(paletteIndex("PROJ-1", 3)).toBeLessThan(3);
  expect(paletteIndex("PROJ-1", 1)).toBe(0);
  // Different ids are not all one bucket: the hue is identity, not a constant.
  const used = new Set(Array.from({ length: 40 }, (_, i) => paletteIndex(`PROJ-${i}`)).values());
  expect(used.size).toBeGreaterThan(1);
});

test("a page icon name maps to the glyph the core knows, or the generic page", () => {
  expect(pageGlyph("leftovers")).toBe("leftovers");
  expect(pageGlyph(undefined)).toBe("page");
  expect(pageGlyph("")).toBe("page");
  expect(pageGlyph("azure-devops")).toBe("page");
});

test("a window icon name maps to its glyph, terminal for anything unknown", () => {
  // A silent subagent is still a subagent: the name comes from the host session, not a reporter.
  expect(windowGlyph("subagent")).toBe("subagent");
  expect(windowGlyph("agent")).toBe("agent");
  expect(windowGlyph("terminal")).toBe("terminal");
  // An absent or unknown name is the plain terminal, not a second kind of agent.
  expect(windowGlyph(undefined)).toBe("terminal");
  expect(windowGlyph("something-else")).toBe("terminal");
});

test("a window's icon name renders the shape that names it", () => {
  const render = (icon: string | undefined): string =>
    renderToStaticMarkup(createElement(WindowIcon, { icon, title: "window" }));

  const terminal = render("terminal");
  const agent = render("agent");
  const subagent = render("subagent");

  // The three names are three different drawings...
  expect(new Set([terminal, agent, subagent]).size).toBe(3);
  // ...the terminal's prompt, the agent's head-with-antenna, and the subagent's two heads.
  expect(terminal).toContain("M2.5 4l3.5 4-3.5 4");
  expect(agent).toContain('x="3" y="5.5" width="10"');
  expect(subagent).toContain('x="1.5" y="1.8" width="9"');
  // An unknown name falls back to the terminal, the runtime rule `windowGlyph` owns.
  expect(render("something-else")).toBe(terminal);
  expect(render(undefined)).toBe(terminal);
});
