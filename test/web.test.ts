import { test, expect, beforeEach, afterEach } from "bun:test";
import type { Change } from "../src/core/domain/change.ts";
import { aborted, api, del, patch, post, put, type ApiError } from "../src/web/api.ts";
import { stateClass } from "../src/change/client/changeState.tsx";
import { moment } from "../src/web/moment.ts";
import { getPref, setPref } from "../src/web/prefs.ts";
import {
  ALL,
  DEFAULT_WORKSPACE,
  inWorkspace,
  workspaceOf,
  type Workspace,
} from "../src/web/workspaces.ts";

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

test("the default workspace is the one src/config.ts creates", () => {
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
  expect(getPref("iwe:workspace")).toBeNull();

  cookie = "theme=dark; iwe:workspace=mine; other=1";
  expect(getPref("iwe:workspace")).toBe("mine");
  expect(getPref("other")).toBe("1");

  // The decoded value is what was stored, not the percent-encoded form.
  cookie = "iwe:workspace=My%20Client%2Fteam";
  expect(getPref("iwe:workspace")).toBe("My Client/team");

  // A key that is a prefix of another cookie's name is not that cookie.
  cookie = "iwe:workspace2=x";
  expect(getPref("iwe:workspace")).toBeNull();
});

test("a preference is written with the attributes that survive a fresh port", () => {
  setPref("iwe:workspace", "My Client");
  expect(cookie).toBe(
    "iwe:workspace=My%20Client; max-age=315360000; path=/; SameSite=Lax",
  );

  // The key is written as-is, the value is encoded.
  setPref("iwe:workspace", "a/b&c=d");
  expect(cookie.startsWith("iwe:workspace=a%2Fb%26c%3Dd;")).toBe(true);
});

test("a preference written and read back is the value that was set", () => {
  setPref("iwe:workspace", "My Client / team");
  expect(getPref("iwe:workspace")).toBe("My Client / team");
});

// The API client is shared by every page, so its response handling is stubbed at `fetch` rather
// than driven through a server. Each call records what it asked for.
type FetchCall = { url: string; init?: RequestInit };
let calls: FetchCall[] = [];
const realFetch = globalThis.fetch;

const stubFetch = (respond: (url: string, init?: RequestInit) => Response): void => {
  calls = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return Promise.resolve(respond(url, init));
  }) as typeof fetch;
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("a JSON body comes back parsed, from /api", async () => {
  stubFetch(() => json({ workspaces: [{ id: "default" }] }));
  expect(await api<{ workspaces: unknown[] }>("/workspaces")).toEqual({
    workspaces: [{ id: "default" }],
  });
  expect(calls[0]!.url).toBe("/api/workspaces");
});

test("a POST body is sent as JSON with the content type it needs", async () => {
  stubFetch(() => json({ ok: true }));
  await post("/changes", { id: "PROJ-1" });
  expect(calls[0]!.url).toBe("/api/changes");
  expect(calls[0]!.init?.method).toBe("POST");
  expect(calls[0]!.init?.body).toBe('{"id":"PROJ-1"}');
  expect(calls[0]!.init?.headers).toEqual({ "content-type": "application/json" });
});

test("PATCH, PUT and DELETE carry their method, and DELETE carries no body", async () => {
  stubFetch(() => json({ ok: true }));
  await patch("/changes/PROJ-1", { title: "renamed" });
  await put("/changes/PROJ-1/notes", { notes: "hi" });
  await del("/changes/PROJ-1/leftovers/x");

  expect(calls.map((c) => c.init?.method)).toEqual(["PATCH", "PUT", "DELETE"]);
  expect(calls[0]!.init?.body).toBe('{"title":"renamed"}');
  expect(calls[1]!.init?.body).toBe('{"notes":"hi"}');
  // No body means no content-type, so a DELETE cannot be mistaken for a payload.
  expect(calls[2]!.init?.body).toBeUndefined();
  expect(calls[2]!.init?.headers).toBeUndefined();
});

test("a non-JSON response is read as an out-of-date server, not a parse error", async () => {
  stubFetch(
    () =>
      new Response("<html>the app</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
  );

  const error = await api("/settings").then(
    () => null,
    (e: unknown) => e as ApiError,
  );
  expect(error).toBeInstanceOf(Error);
  expect(error!.message).toBe(
    "the server has no /settings — it is probably running older code, restart it",
  );
  expect(error!.status).toBe(200);
  // The HTML is not a body the caller can use, so the error does not pretend it is JSON.
  expect(error!.body).toBeUndefined();
});

test("a missing content type is also treated as no such route", async () => {
  stubFetch(() => new Response("plain", { status: 404 }));
  const error = await api("/nope").then(
    () => null,
    (e: unknown) => e as ApiError,
  );
  expect(error!.status).toBe(404);
  expect(error!.message).toContain("the server has no /nope");
});

test("a JSON error body names the failure and rides along with its status", async () => {
  stubFetch(() => json({ error: "branch already exists" }, 409));
  const error = await api("/changes").then(
    () => null,
    (e: unknown) => e as ApiError,
  );
  expect(error!.message).toBe("branch already exists");
  expect(error!.status).toBe(409);
  expect(error!.body).toEqual({ error: "branch already exists" });
});

test("a JSON error without an error field falls back to the status text", async () => {
  stubFetch(
    () =>
      new Response(JSON.stringify({ detail: "no message here" }), {
        status: 500,
        statusText: "Internal Server Error",
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
  );
  const error = await api("/changes").then(
    () => null,
    (e: unknown) => e as ApiError,
  );
  expect(error!.message).toBe("Internal Server Error");
  expect(error!.status).toBe(500);
  expect(error!.body).toEqual({ detail: "no message here" });
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
