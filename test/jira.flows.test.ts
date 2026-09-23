import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, Either } from "effect";
import { Cache, Settings } from "@corvi/contracts/capabilities";
import { clearCache } from "../apps/server/src/capabilities/cache.ts";
import { CacheLive } from "../apps/server/src/integrations/services.ts";
import { runtimeConfig, type Workspace } from "../apps/server/src/workspace/server/index.ts";
import type { Change } from "../apps/server/src/domain/change.ts";
import jiraExtension from "@corvi/jira";
import {
  boardIssues,
  createIssue,
  globalOf,
  issueByKey,
  issueFrom,
  issuesByKeys,
  listSprints,
  moveIssue,
  siteFor,
  siteOf,
  siteOfWorkspace,
  ticketOf,
} from "@corvi/jira/jira";
import { jiraFetch } from "@corvi/jira/jiraHttp";
import { accountId } from "@corvi/jira/account";
import { legacyConfig, runEffect } from "./helpers.ts";

/**
 * The Jira extension's server half, driven through a stubbed `fetch`. Every test states its site
 * as the settings Corvi actually reads — a `Site` value, or a workspace carrying one — and stubs
 * only the HTTP boundary, so URL building, auth, error mapping and the request bodies are
 * exercised as the server produces them.
 */

// --- The fetch stub ---------------------------------------------------------------------------

type FetchCall = { url: URL; init: RequestInit | undefined };
type FetchHandler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

const originalFetch: typeof fetch = globalThis.fetch;
const fetchCalls: FetchCall[] = [];

/** Replace `fetch` for one test. The handler's synchronous throw becomes a rejected call, which
 * is how a real network failure reaches `jiraFetch`. */
const stubFetch = (handler: FetchHandler): void => {
  fetchCalls.length = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    fetchCalls.push({ url, init });
    return Promise.resolve().then(() => handler(url, init));
  }) as typeof fetch;
};

const json = (body: unknown, status = 200, statusText?: string): Response =>
  new Response(JSON.stringify(body), { status, statusText });

const text = (body: string, status = 200, statusText?: string): Response =>
  new Response(body, { status, statusText });

const noContent = (): Response => new Response(null, { status: 204 });

const runEither = <A, E>(
  effect: Effect.Effect<A, E, Settings | Cache>,
): Promise<Either.Either<A, E>> =>
  Effect.runPromise(
    Effect.either(Effect.provide(Effect.provideService(effect, Settings, runtimeConfig()), CacheLive)),
  );

/** What was sent as authorization, which is the whole of what basic auth is. */
const authHeader = (call: FetchCall): string =>
  (call.init?.headers as Record<string, string>)["authorization"] ?? "";

// --- The site every test speaks to ------------------------------------------------------------

/** A working site: the server, the account, the project, and the board explicitly so no test
 * depends on the project→board lookup it is not about. */
const SITE = {
  server: "https://example.atlassian.net",
  email: "someone@example.com",
  project: "PROJ",
  board: "169",
};

/** The same site in a workspace's own bag, so a test that clears the config root's default still
 * has one, and `settings` overrides one field without restating the rest. */
const jiraWorkspace = (id: string, settings: Record<string, string> = {}): Workspace => ({
  id,
  name: id,
  extensionSettings: { jira: { ...SITE, ...settings } },
});

/** A workspace with nothing configured at all — the state every workspace is in until the
 * settings page is visited once. */
const bareWorkspace = (id: string): Workspace => ({
  id,
  name: id,
  extensionSettings: { jira: {} },
});

const change = (over: Partial<Change> = {}): Change => ({
  id: "PROJ-1",
  branch: "PROJ-1-thing",
  repos: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

// --- Environment and config isolation ---------------------------------------------------------

const ENV_KEYS = [
  "JIRA_API_TOKEN",
  "OTHER_JIRA_TOKEN",
  "CORVI_JIRA_SPRINT_STATES",
  "CORVI_JIRA_ISSUE_TYPES",
  "CORVI_JIRA_ISSUE_TYPE",
  "CORVI_JIRA_ASSIGNEE",
] as const;

const originalEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
const setEnv = (key: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

// The config object is shared by reference across the server; the tests mutate and restore it.
// The preserved flat jira fields are typed for what they are by legacyConfig() in
// test/helpers.ts, so the fallback these tests exercise reads them without a cast here.
const originalWorkspaces = runtimeConfig().workspaces;
const originalAssignee = legacyConfig().jiraAssignee;
const originalExtensionSettings = runtimeConfig().extensionSettings;

beforeEach(() => {
  clearCache();
  // Every test starts from a clean default site: what the machine's own config file happens to
  // hold is not what these tests are about, and a default leaking in would make one pass for the
  // wrong reason.
  runtimeConfig().extensionSettings = undefined;
});

afterEach(() => {
  runtimeConfig().workspaces = originalWorkspaces;
  legacyConfig().jiraAssignee = originalAssignee;
  runtimeConfig().extensionSettings = originalExtensionSettings;
  globalThis.fetch = originalFetch;
  for (const [key, value] of originalEnv) setEnv(key, value);
  fetchCalls.length = 0;
  clearCache();
});

// --- jiraFetch: URL, auth and error mapping ---------------------------------------------------

test("jiraFetch asks the site with basic auth and only the defined query parameters", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  stubFetch(() => json({ ok: true }));

  const result = await runEffect(
    jiraFetch<{ ok: boolean }>("/rest/api/3/issue/PROJ-1", {
      site: SITE,
      query: { fields: "summary", nextPageToken: undefined },
    }),
  );

  expect(result).toEqual({ ok: true });
  const call = fetchCalls[0]!;
  expect(call.url.origin + call.url.pathname).toBe(
    "https://example.atlassian.net/rest/api/3/issue/PROJ-1",
  );
  expect(call.url.searchParams.get("fields")).toBe("summary");
  // An undefined query value is not sent at all, rather than sent as the string "undefined".
  expect(call.url.searchParams.has("nextPageToken")).toBe(false);
  const headers = call.init?.headers as Record<string, string>;
  expect(call.init?.method).toBe("GET");
  expect(headers["authorization"]).toBe(`Basic ${btoa("someone@example.com:secret")}`);
  expect(headers["content-type"]).toBeUndefined();
});

test("jiraFetch sends a body as JSON with the content-type that implies", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  stubFetch(() => json({ key: "PROJ-1" }));

  await runEffect(
    jiraFetch("/rest/api/3/issue", {
      site: SITE,
      method: "POST",
      body: { fields: { summary: "Do it" } },
    }),
  );

  const call = fetchCalls[0]!;
  expect(call.init?.method).toBe("POST");
  expect((call.init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
  expect(JSON.parse(call.init?.body as string)).toEqual({ fields: { summary: "Do it" } });
});

test("jiraFetch reads an empty response body as no value", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  stubFetch(() => noContent());
  expect(await runEffect(jiraFetch("/rest/api/3/issue/PROJ-1", { site: SITE }))).toBeUndefined();
});

test("jiraFetch maps Jira's errorMessages and errors onto one line", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  stubFetch(() =>
    json({ errorMessages: ["Issue does not exist"], errors: { summary: "is required" } }, 400),
  );

  const either = await runEither(jiraFetch("/rest/api/3/issue/PROJ-1", { site: SITE }));
  expect(Either.isLeft(either)).toBe(true);
  if (Either.isLeft(either)) {
    expect(either.left.message).toBe("jira 400: Issue does not exist; is required");
  }
});

test("jiraFetch falls back to the first line, then the status text, for an unexplained error", async () => {
  setEnv("JIRA_API_TOKEN", "secret");

  stubFetch(() => text("server exploded\nmore noise", 502, "Bad Gateway"));
  const firstLine = await runEither(jiraFetch("/x", { site: SITE }));
  if (Either.isLeft(firstLine)) expect(firstLine.left.message).toBe("jira 502: server exploded");

  // An empty body has no first line, so the status text is the only thing left to say.
  stubFetch(() => text("", 500, "Internal Server Error"));
  const empty = await runEither(jiraFetch("/x", { site: SITE }));
  if (Either.isLeft(empty)) expect(empty.left.message).toBe("jira 500: Internal Server Error");
});

test("jiraFetch reports a failed request and a failed body read as BadRequestError", async () => {
  setEnv("JIRA_API_TOKEN", "secret");

  stubFetch(() => {
    throw new Error("connection refused");
  });
  const network = await runEither(jiraFetch("/x", { site: SITE }));
  if (Either.isLeft(network)) {
    expect(network.left.message).toBe("jira request failed: connection refused");
  } else {
    throw new Error("expected the request to fail");
  }

  stubFetch(
    () =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        text: () => Promise.reject(new Error("body gone")),
      }) as Response,
  );
  const body = await runEither(jiraFetch("/x", { site: SITE }));
  if (Either.isLeft(body)) expect(body.left.message).toBe("jira response failed: body gone");
});

test("jiraFetch reads a non-JSON success body as a BadRequestError", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  stubFetch(() => text("not json", 200));
  const either = await runEither(jiraFetch("/x", { site: SITE }));
  expect(Either.isLeft(either)).toBe(true);
  if (Either.isLeft(either)) expect(either.left.message.length).toBeGreaterThan(0);
});

test("jiraFetch names the field that is not configured, and asks Jira nothing", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  stubFetch(() => json({ ok: true }));

  // Nothing at all.
  const noServer = await runEither(jiraFetch("/x"));
  expect(Either.isLeft(noServer)).toBe(true);
  if (Either.isLeft(noServer)) {
    expect(noServer.left.message).toBe("no Jira server for this workspace — set Server in Settings");
  }

  // A server but no account.
  const noEmail = await runEither(jiraFetch("/x", { site: { server: SITE.server } }));
  if (Either.isLeft(noEmail)) {
    expect(noEmail.left.message).toBe(
      "no Jira account email for this workspace — set Account email in Settings",
    );
  } else {
    throw new Error("expected the account email to be required");
  }

  // A token, absolutely not: the failure is decided before the request.
  setEnv("JIRA_API_TOKEN", undefined);
  const noToken = await runEither(
    jiraFetch("/x", { site: { server: SITE.server, email: SITE.email } }),
  );
  if (Either.isLeft(noToken)) {
    expect(noToken.left.message).toBe(
      "no Jira token for this workspace — set API token in Settings, or export JIRA_API_TOKEN",
    );
  } else {
    throw new Error("expected the token to be required");
  }
  expect(fetchCalls.length).toBe(0);
});

test("jiraFetch takes the token from the site's own environment variable", async () => {
  setEnv("JIRA_API_TOKEN", undefined);
  setEnv("OTHER_JIRA_TOKEN", "other-secret");
  stubFetch(() => json({ ok: true }));

  await runEffect(jiraFetch("/x", { site: { ...SITE, tokenEnv: "OTHER_JIRA_TOKEN" } }));
  expect(authHeader(fetchCalls[0]!)).toBe(`Basic ${btoa("someone@example.com:other-secret")}`);

  // The variable's name is the one the failure names, so a second site says its own.
  const either = await runEither(jiraFetch("/x", { site: { ...SITE, tokenEnv: "OTHER_JIRA_TOKEN" } }));
  expect(Either.isLeft(either)).toBe(false);

  setEnv("OTHER_JIRA_TOKEN", undefined);
  const missing = await runEither(
    jiraFetch("/x", { site: { server: SITE.server, email: SITE.email, tokenEnv: "OTHER_JIRA_TOKEN" } }),
  );
  if (Either.isLeft(missing)) {
    expect(missing.left.message).toBe(
      "no Jira token for this workspace — set API token in Settings, or export OTHER_JIRA_TOKEN",
    );
  } else {
    throw new Error("expected the site's own variable to be required");
  }
});

test("a stored token is used, and beats the environment's", async () => {
  setEnv("JIRA_API_TOKEN", "env-secret");
  stubFetch(() => json({ ok: true }));

  await runEffect(jiraFetch("/x", { site: { ...SITE, token: "stored-secret" } }));
  expect(authHeader(fetchCalls[0]!)).toBe(`Basic ${btoa("someone@example.com:stored-secret")}`);

  // With nothing stored, the variable is the credential, which is the fallback it is.
  await runEffect(jiraFetch("/x", { site: SITE }));
  expect(authHeader(fetchCalls[1]!)).toBe(`Basic ${btoa("someone@example.com:env-secret")}`);

  // An empty string is not a stored token: empty means unset everywhere else, and here too.
  await runEffect(jiraFetch("/x", { site: { ...SITE, token: "  " } }));
  expect(authHeader(fetchCalls[2]!)).toBe(`Basic ${btoa("someone@example.com:env-secret")}`);
});

test("a bare host is asked as https, and an address that is not one is a sentence", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  stubFetch(() => json({ ok: true }));

  await runEffect(jiraFetch("/x", { site: { server: "example.atlassian.net/", email: SITE.email } }));
  expect(fetchCalls[0]!.url.origin).toBe("https://example.atlassian.net");
  // A path pasted along with the address is no part of where the API lives.
  await runEffect(
    jiraFetch("/x", { site: { server: "https://example.atlassian.net/jira/software", email: SITE.email } }),
  );
  expect(fetchCalls[1]!.url.pathname).toBe("/x");

  for (const server of ["not a host", "ftp://x.example", "https://"]) {
    const either = await runEither(jiraFetch("/x", { site: { server, email: SITE.email } }));
    if (Either.isLeft(either)) {
      expect(either.left.message).toBe(`"${server}" is not a server address — set Server in Settings`);
    } else {
      throw new Error(`expected "${server}" to be refused`);
    }
  }
  // Refused before the request, not by it.
  expect(fetchCalls.length).toBe(2);
});

// --- Site and global settings resolution ------------------------------------------------------

test("siteOfWorkspace overrides the default site field by field", () => {
  runtimeConfig().extensionSettings = {
    jira: { server: "https://default.example", email: "default@example.com", project: "DEF", board: "1" },
  };

  // Nothing of its own: everything comes from the default.
  expect(siteOfWorkspace(runtimeConfig(), {})).toEqual({
    server: "https://default.example",
    email: "default@example.com",
    project: "DEF",
    board: "1",
    tokenEnv: undefined,
    token: undefined,
  });

  // Its own bag wins where it speaks, and inherits where it is silent.
  expect(
    siteOfWorkspace(runtimeConfig(), { extensionSettings: { jira: { project: "PROJ", token: "own-token" } } }),
  ).toEqual({
    server: "https://default.example",
    email: "default@example.com",
    project: "PROJ",
    board: "1",
    tokenEnv: undefined,
    token: "own-token",
  });

  // A workspace written before the bag answers from its `jira` object, the bag's fields first.
  const legacy = {
    extensionSettings: { jira: { project: "BAG" } },
    jira: { project: "LEGACY", board: "7", tokenEnv: "LEGACY_TOKEN", configFile: "/old.yml" },
  };
  expect(siteOfWorkspace(runtimeConfig(), legacy)).toEqual({
    server: "https://default.example",
    email: "default@example.com",
    project: "BAG",
    board: "7",
    tokenEnv: "LEGACY_TOKEN",
    token: undefined,
  });

  // `false` and a non-object are no site of their own, not a site with everything absent.
  expect(siteOfWorkspace(runtimeConfig(), { jira: false }).project).toBe("DEF");
});

test("a workspace that names its own token variable does not inherit the default's token", () => {
  runtimeConfig().extensionSettings = {
    jira: { server: SITE.server, email: SITE.email, token: "default-token", tokenEnv: "DEFAULT_TOKEN" },
  };

  // Silent about the credential: the default site's token is the one that applies.
  expect(siteOfWorkspace(runtimeConfig(), {}).token).toBe("default-token");

  // It says where its credential comes from, so the default's stored token is not also its own —
  // otherwise one client's token would be sent to another with no way to say otherwise.
  expect(siteOfWorkspace(runtimeConfig(), { extensionSettings: { jira: { tokenEnv: "CLIENT_TOKEN" } } })).toEqual({
    server: SITE.server,
    email: SITE.email,
    project: undefined,
    board: undefined,
    tokenEnv: "CLIENT_TOKEN",
    token: undefined,
  });
});

test("siteOf and siteFor resolve a change's and an id's Jira", () => {
  runtimeConfig().workspaces = [
    { id: "client", name: "Client", extensionSettings: { jira: { project: "CLI" } } },
    { id: "other", name: "Other" },
  ];
  expect(siteOf(runtimeConfig(), { workspace: "client" }).project).toBe("CLI");
  expect(siteFor(runtimeConfig(), "client").project).toBe("CLI");
  expect(siteFor(runtimeConfig(), "other")).toEqual({
    server: undefined,
    email: undefined,
    project: undefined,
    board: undefined,
    tokenEnv: undefined,
    token: undefined,
  });
  // An unknown id falls back to the first workspace, where a change without one lives.
  expect(siteFor(runtimeConfig(), "nope").project).toBe("CLI");
});

test("globalOf lets the settings bag win and treats an empty or non-string value as unset", () => {
  const flat = {
    jiraAssignee: "flat@example.com",
    jiraStartTransition: "Start",
    jiraDoneTransition: "Done",
  };
  expect(globalOf(flat)).toEqual({
    assignee: "flat@example.com",
    startTransition: "Start",
    doneTransition: "Done",
  });

  // An empty string and a non-string bag value both mean "not set" and fall back to the field.
  const bagged = {
    ...flat,
    extensionSettings: {
      jira: { assignee: "bag@example.com", startTransition: "  ", doneTransition: ["Done", "Closed"] },
    },
  };
  expect(globalOf(bagged)).toEqual({
    assignee: "bag@example.com",
    startTransition: "Start",
    doneTransition: "Done",
  });

  // A value with text is used as written: the trim is only the emptiness test.
  const spaced = { ...flat, extensionSettings: { jira: { assignee: "  bag  " } } };
  expect(globalOf(spaced).assignee).toBe("  bag  ");

  // The environment variable still beats the legacy flat field, exactly as the resolved chain
  // did before the field left the core.
  setEnv("CORVI_JIRA_ASSIGNEE", "env@example.com");
  expect(globalOf(flat).assignee).toBe("env@example.com");
});

test("issueFrom tolerates absent fields and trims the summary", () => {
  expect(issueFrom({ key: "K" })).toEqual({
    key: "K",
    summary: "",
    assignee: "",
    status: "",
    type: "",
    sprint: "",
  });
  expect(
    issueFrom({ key: "K", fields: { summary: "  hi  ", status: {}, assignee: {}, issuetype: {} } }),
  ).toEqual({ key: "K", summary: "hi", assignee: "", status: "", type: "", sprint: "" });
});

// --- Sprints and the board --------------------------------------------------------------------

test("listSprints names the board's sprints and honours the state override", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  setEnv("CORVI_JIRA_SPRINT_STATES", "active");
  stubFetch((url) =>
    url.pathname === "/rest/agile/1.0/board/169/sprint"
      ? json({ values: [{ id: 1, name: "Sprint 1", state: "active" }] })
      : text("unexpected", 500),
  );

  const sprints = await runEffect(listSprints(SITE));
  // Jira answers with a numeric id; ours is a string key.
  expect(sprints).toEqual([{ id: "1", name: "Sprint 1", state: "active" }]);
  expect(fetchCalls[0]!.url.searchParams.get("state")).toBe("active");
});

test("listSprints says what is missing rather than which id it could not find", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  stubFetch(() => text("never", 500));

  // A workspace with no server at all is told that, not that its board is missing.
  const noServer = await runEither(listSprints({}));
  if (Either.isLeft(noServer)) {
    expect(noServer.left.message).toBe("no Jira server for this workspace — set Server in Settings");
  } else {
    throw new Error("expected an unconfigured site to fail");
  }

  // A server, but nothing to find a board from.
  const noBoard = await runEither(listSprints({ server: SITE.server, email: SITE.email }));
  if (Either.isLeft(noBoard)) {
    expect(noBoard.left.message).toBe(
      "no Jira board for this workspace — set Project or Board in Settings",
    );
  } else {
    throw new Error("expected a missing board to fail");
  }
  expect(fetchCalls.length).toBe(0);
});

test("the board is found from the project when Board is not set", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  stubFetch((url) =>
    url.pathname === "/rest/agile/1.0/board"
      ? json({ values: [{ id: 169, name: "PROJ board" }] })
      : url.pathname === "/rest/agile/1.0/board/169/sprint"
        ? json({ values: [] })
        : text("unexpected", 500),
  );

  expect(await runEffect(listSprints({ server: SITE.server, email: SITE.email, project: "PROJ" }))).toEqual([]);
  expect(fetchCalls[0]!.url.pathname).toBe("/rest/agile/1.0/board");
  expect(fetchCalls[0]!.url.searchParams.get("projectKeyOrId")).toBe("PROJ");
  expect(fetchCalls[1]!.url.pathname).toBe("/rest/agile/1.0/board/169/sprint");
});

test("a project with several boards is asked about rather than guessed, and none is said plainly", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  const site = { server: SITE.server, email: SITE.email, project: "PROJ" };

  stubFetch(() => json({ values: [{ id: 1, name: "Alpha" }, { id: 2, name: "Beta" }] }));
  const several = await runEither(listSprints(site));
  if (Either.isLeft(several)) {
    expect(several.left.message).toBe(
      "project PROJ has 2 boards: Alpha (1), Beta (2) — set Board in Settings",
    );
  } else {
    throw new Error("expected an ambiguous project to be refused");
  }
  // Nothing was guessed at: the sprints of no board were asked for.
  expect(fetchCalls.some((c) => c.url.pathname.endsWith("/sprint"))).toBe(false);

  stubFetch(() => json({ values: [] }));
  const none = await runEither(listSprints(site));
  if (Either.isLeft(none)) {
    expect(none.left.message).toBe("no board in project PROJ — set Board in Settings");
  } else {
    throw new Error("expected a project with no board to be refused");
  }
});

test("boardIssues groups sprints and the backlog, filtered to workable types", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  runtimeConfig().workspaces = [jiraWorkspace("board-ws")];
  stubFetch((url) => {
    if (url.pathname === "/rest/agile/1.0/board/169/sprint") {
      return json({
        values: [
          { id: 1, name: "Sprint 1", state: "active" },
          { id: 2, name: "Sprint 2", state: "future" },
        ],
      });
    }
    if (url.pathname === "/rest/agile/1.0/board/169/sprint/1/issue") {
      return json({
        issues: [
          {
            key: "PROJ-1",
            fields: {
              summary: "One",
              status: { name: "In Progress" },
              assignee: { displayName: "Ada" },
              issuetype: { name: "Story" },
            },
          },
        ],
      });
    }
    if (url.pathname === "/rest/agile/1.0/board/169/sprint/2/issue") {
      return json({ issues: [{ key: "PROJ-2", fields: { summary: "Two", assignee: null, issuetype: { name: "Bug" } } }] });
    }
    if (url.pathname === "/rest/api/3/search/jql") {
      // The backlog is paged: the first page names a token, the second does not.
      return url.searchParams.get("nextPageToken") === "n2"
        ? json({ issues: [{ key: "PROJ-4", fields: { summary: "Four", issuetype: { name: "Story" } } }] })
        : json({
            issues: [{ key: "PROJ-3", fields: { summary: "Three", issuetype: { name: "Epic" } } }],
            nextPageToken: "n2",
          });
    }
    return text(`unexpected ${url.pathname}`, 500);
  });

  const board = await runEffect(boardIssues("board-ws", true));

  expect(board.baseUrl).toBe("https://example.atlassian.net");
  expect(board.error).toBeUndefined();
  // The Epic is a container, not a unit of work, so it is filtered out.
  expect(board.issues.map((i) => i.key).sort()).toEqual(["PROJ-1", "PROJ-2", "PROJ-4"]);
  expect(board.sprints).toEqual(["Sprint 1", "Sprint 2"]);
  const byKey = new Map(board.issues.map((i) => [i.key, i]));
  // The sprint is which query found the issue, which is why it is asserted here.
  expect(byKey.get("PROJ-1")?.sprint).toBe("Sprint 1");
  expect(byKey.get("PROJ-2")?.assignee).toBe("");
  expect(byKey.get("PROJ-4")?.sprint).toBe("");
  expect(fetchCalls.filter((c) => c.url.pathname === "/rest/api/3/search/jql").length).toBe(2);
  // The backlog is scoped to the project: an unscoped query would read the whole site.
  const backlog = fetchCalls.find((c) => c.url.pathname === "/rest/api/3/search/jql")!;
  expect(backlog.url.searchParams.get("jql")).toBe(
    "project = PROJ AND sprint is EMPTY AND statusCategory != Done ORDER BY rank",
  );
});

test("boardIssues answers an error string and still names the base URL when Jira fails", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  runtimeConfig().workspaces = [jiraWorkspace("board-error-ws")];
  stubFetch(() => text("upstream exploded\nmore", 500, "Server Error"));

  const board = await runEffect(boardIssues("board-error-ws", true));

  // A broken Jira still leaves the page able to say where it is and why it is empty.
  expect(board.baseUrl).toBe("https://example.atlassian.net");
  expect(board.issues).toEqual([]);
  expect(board.sprints).toEqual([]);
  expect(board.error).toBe("jira 500: upstream exploded");
});

test("boardIssues serves a recently read board from its cache without asking again", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  runtimeConfig().workspaces = [jiraWorkspace("board-cache-ws")];
  stubFetch((url) => {
    if (url.pathname === "/rest/agile/1.0/board/169/sprint") return json({ values: [] });
    if (url.pathname === "/rest/api/3/search/jql") return json({ issues: [] });
    return text("unexpected", 500);
  });

  await runEffect(boardIssues("board-cache-ws"));
  const afterFirst = fetchCalls.length;
  expect(afterFirst).toBeGreaterThan(0);
  await runEffect(boardIssues("board-cache-ws"));
  expect(fetchCalls.length).toBe(afterFirst);
});

test("boardIssues with force forgets the cached board and asks again", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  runtimeConfig().workspaces = [jiraWorkspace("board-force-ws")];
  stubFetch((url) => {
    if (url.pathname === "/rest/agile/1.0/board/169/sprint") return json({ values: [] });
    if (url.pathname === "/rest/api/3/search/jql") return json({ issues: [] });
    return text("unexpected", 500);
  });

  await runEffect(boardIssues("board-force-ws"));
  const afterFirst = fetchCalls.length;
  await runEffect(boardIssues("board-force-ws", true));

  // The refresh drops the cached board first, so the same queries run again rather than the
  // cache answering the demand for fresh data.
  expect(fetchCalls.length).toBeGreaterThan(afterFirst);
});

test("two workspaces on one site do not share a board", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  runtimeConfig().workspaces = [
    jiraWorkspace("alpha-ws", { board: "1" }),
    jiraWorkspace("beta-ws", { board: "2" }),
  ];
  stubFetch((url) =>
    url.pathname.endsWith("/sprint") ? json({ values: [] }) : json({ issues: [] }),
  );

  await runEffect(boardIssues("alpha-ws"));
  await runEffect(boardIssues("beta-ws"));

  // The board belongs to the site: a cache key that ignored it would answer the second workspace
  // with the first one's issues.
  expect(fetchCalls.map((c) => c.url.pathname)).toEqual([
    "/rest/agile/1.0/board/1/sprint",
    "/rest/api/3/search/jql",
    "/rest/agile/1.0/board/2/sprint",
    "/rest/api/3/search/jql",
  ]);
});

test("a whole board view looks the board up once", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  runtimeConfig().workspaces = [jiraWorkspace("lookup-ws", { board: "" })];
  stubFetch((url) => {
    if (url.pathname === "/rest/agile/1.0/board") return json({ values: [{ id: 7, name: "PROJ" }] });
    if (url.pathname === "/rest/agile/1.0/board/7/sprint") {
      return json({
        values: [
          { id: 1, name: "S1", state: "active" },
          { id: 2, name: "S2", state: "active" },
          { id: 3, name: "S3", state: "active" },
        ],
      });
    }
    if (url.pathname.startsWith("/rest/agile/1.0/board/7/sprint/")) return json({ issues: [] });
    if (url.pathname === "/rest/api/3/search/jql") return json({ issues: [] });
    return text("unexpected", 500);
  });

  const board = await runEffect(boardIssues("lookup-ws", true));

  expect(board.error).toBeUndefined();
  // One lookup for the list and every sprint in it, not one per sprint.
  expect(fetchCalls.filter((c) => c.url.pathname === "/rest/agile/1.0/board").length).toBe(1);
});

// --- createIssue ------------------------------------------------------------------------------

test("createIssue creates the issue, assigns it and returns what the wizard selects", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  runtimeConfig().workspaces = [jiraWorkspace("create-ws")];
  legacyConfig().jiraAssignee = "";
  stubFetch((url, init) => {
    const method = init?.method ?? "GET";
    if (url.pathname === "/rest/api/3/myself") return json({ accountId: "acc-me" });
    if (url.pathname === "/rest/api/3/issue" && method === "POST") return json({ key: "PROJ-9" });
    if (url.pathname === "/rest/api/3/issue/PROJ-9/assignee" && method === "PUT") return noContent();
    return text(`unexpected ${method} ${url.pathname}`, 500);
  });

  const issue = await runEffect(
    createIssue({
      summary: "  Fix it  ",
      description: "line one\n\nline two",
      workspace: "create-ws",
    }),
  );

  expect(issue).toEqual({
    key: "PROJ-9",
    summary: "Fix it",
    assignee: "",
    status: "",
    type: "Story",
    sprint: "",
  });

  const post = fetchCalls.find((c) => c.url.pathname === "/rest/api/3/issue")!;
  expect(JSON.parse(post.init?.body as string)).toEqual({
    fields: {
      project: { key: "PROJ" },
      issuetype: { name: "Story" },
      summary: "Fix it",
      // Jira v3 takes a document; one paragraph per line, an empty line an empty paragraph.
      description: {
        type: "doc",
        version: 1,
        content: [
          { type: "paragraph", content: [{ type: "text", text: "line one" }] },
          { type: "paragraph", content: [] },
          { type: "paragraph", content: [{ type: "text", text: "line two" }] },
        ],
      },
    },
  });
  const assign = fetchCalls.find((c) => c.url.pathname.endsWith("/assignee"))!;
  expect(assign.init?.method).toBe("PUT");
  expect(JSON.parse(assign.init?.body as string)).toEqual({ accountId: "acc-me" });
});

test("createIssue skips assignment when asked and omits an empty description", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  runtimeConfig().workspaces = [jiraWorkspace("create-ws")];
  legacyConfig().jiraAssignee = "unused@example.com";
  stubFetch((url, init) =>
    url.pathname === "/rest/api/3/issue" && init?.method === "POST"
      ? json({ key: "PROJ-10" })
      : text("unexpected", 500),
  );

  const issue = await runEffect(
    createIssue({ summary: "Only the issue", description: "   ", type: "Bug", assignToMe: false, workspace: "create-ws" }),
  );

  expect(issue.type).toBe("Bug");
  // One request and no more: no account lookup, no assignee call.
  expect(fetchCalls.length).toBe(1);
  const fields = (JSON.parse(fetchCalls[0]!.init?.body as string) as { fields: Record<string, unknown> }).fields;
  expect(fields["description"]).toBeUndefined();
  expect(fields["issuetype"]).toEqual({ name: "Bug" });
});

test("createIssue assigns a configured account id without looking anything up", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  runtimeConfig().workspaces = [jiraWorkspace("create-ws")];
  legacyConfig().jiraAssignee = "5b10ac8d82e05b22cc7d4ef5";
  stubFetch((url, init) => {
    if (url.pathname === "/rest/api/3/issue" && init?.method === "POST") return json({ key: "PROJ-11" });
    if (url.pathname.endsWith("/assignee")) return noContent();
    return text("unexpected", 500);
  });

  await runEffect(createIssue({ summary: "Assign raw", workspace: "create-ws" }));

  // An id never contains "@" or a space, so it is already an account id.
  expect(fetchCalls.some((c) => c.url.pathname === "/rest/api/3/myself")).toBe(false);
  expect(fetchCalls.some((c) => c.url.pathname === "/rest/api/3/user/search")).toBe(false);
  const assign = fetchCalls.find((c) => c.url.pathname.endsWith("/assignee"))!;
  expect(JSON.parse(assign.init?.body as string)).toEqual({ accountId: "5b10ac8d82e05b22cc7d4ef5" });
});

test("createIssue looks up a configured name and assigns the account it finds", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  runtimeConfig().workspaces = [jiraWorkspace("create-ws")];
  legacyConfig().jiraAssignee = "ada@example.com";
  stubFetch((url, init) => {
    if (url.pathname === "/rest/api/3/issue" && init?.method === "POST") return json({ key: "PROJ-12" });
    if (url.pathname === "/rest/api/3/user/search") return json([{ accountId: "acc-search", displayName: "Ada" }]);
    if (url.pathname.endsWith("/assignee")) return noContent();
    return text("unexpected", 500);
  });

  await runEffect(createIssue({ summary: "Assign email", workspace: "create-ws" }));

  const search = fetchCalls.find((c) => c.url.pathname === "/rest/api/3/user/search")!;
  expect(search.url.searchParams.get("query")).toBe("ada@example.com");
  const assign = fetchCalls.find((c) => c.url.pathname.endsWith("/assignee"))!;
  expect(JSON.parse(assign.init?.body as string)).toEqual({ accountId: "acc-search" });
});

test("createIssue requires a summary, then a site, then a project", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  stubFetch(() => text("never", 500));

  const noSummary = await runEither(createIssue({ summary: "   " }));
  if (Either.isLeft(noSummary)) expect(noSummary.left.message).toBe("summary required");
  else throw new Error("expected a missing summary to fail");
  expect(fetchCalls.length).toBe(0);

  // Nothing configured: the answer is the site, not the project it cannot reach.
  runtimeConfig().workspaces = [bareWorkspace("bare-ws")];
  const noSite = await runEither(createIssue({ summary: "No site", workspace: "bare-ws" }));
  if (Either.isLeft(noSite)) {
    expect(noSite.left.message).toBe("no Jira server for this workspace — set Server in Settings");
  } else {
    throw new Error("expected an unconfigured site to fail");
  }
  expect(fetchCalls.length).toBe(0);

  // A site, but no project to create an issue in.
  runtimeConfig().workspaces = [jiraWorkspace("bare-ws", { project: "" })];
  const noProject = await runEither(createIssue({ summary: "No project", workspace: "bare-ws" }));
  if (Either.isLeft(noProject)) {
    expect(noProject.left.message).toBe("no Jira project for this workspace — set Project in Settings");
  } else {
    throw new Error("expected a missing project to fail");
  }
  expect(fetchCalls.length).toBe(0);
});

// --- moveIssue --------------------------------------------------------------------------------

test("moveIssue finds the transition by name or destination and posts it", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  let transitions: { id: string; name: string; to?: { name?: string } }[] = [];
  stubFetch((url, init) => {
    if (url.pathname === "/rest/api/3/issue/PROJ-1/transitions" && (init?.method ?? "GET") === "GET") {
      return json({ transitions });
    }
    if (init?.method === "POST") return noContent();
    return text("unexpected", 500);
  });

  transitions = [{ id: "11", name: "Done", to: { name: "Done" } }];
  await runEffect(moveIssue("PROJ-1", "done", SITE));

  // Some transitions have a workflow name that differs from where they land; both are matched,
  // case-insensitively.
  transitions = [{ id: "31", name: "Start work", to: { name: "In Progress" } }];
  await runEffect(moveIssue("PROJ-1", "IN PROGRESS", SITE));

  const posts = fetchCalls.filter((c) => c.init?.method === "POST");
  expect(posts.length).toBe(2);
  expect(JSON.parse(posts[0]!.init?.body as string)).toEqual({ transition: { id: "11" } });
  expect(JSON.parse(posts[1]!.init?.body as string)).toEqual({ transition: { id: "31" } });
});

test("moveIssue lists the available transitions when the name is not one of them", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  stubFetch(() => json({ transitions: [{ id: "1", name: "To Do" }, { id: "2", name: "In Progress" }] }));

  const either = await runEither(moveIssue("PROJ-1", "Done", SITE));
  if (Either.isLeft(either)) {
    expect(either.left.message).toBe(
      'PROJ-1: cannot move to "Done" from here — available: To Do, In Progress',
    );
  } else {
    throw new Error("expected the move to fail");
  }
  expect(fetchCalls.some((c) => c.init?.method === "POST")).toBe(false);

  stubFetch(() => json({}));
  const none = await runEither(moveIssue("PROJ-1", "Done", SITE));
  if (Either.isLeft(none)) {
    expect(none.left.message).toBe('PROJ-1: cannot move to "Done" from here — available: none');
  } else {
    throw new Error("expected the move to fail");
  }
});

test("moving an issue forgets the cached reads, so the new status shows up", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  stubFetch((url, init) => {
    if (url.pathname === "/rest/api/3/search/jql") {
      return json({
        issues: [
          {
            key: "PROJ-1",
            fields: { summary: "One", status: { name: "In Progress" }, issuetype: { name: "Story" } },
          },
        ],
      });
    }
    if (url.pathname === "/rest/api/3/issue/PROJ-1/transitions") {
      return (init?.method ?? "GET") === "POST"
        ? noContent()
        : json({ transitions: [{ id: "31", name: "Done" }] });
    }
    return text("unexpected", 500);
  });

  await runEffect(issuesByKeys(["PROJ-1"], SITE));
  const afterFirst = fetchCalls.length;
  await runEffect(issuesByKeys(["PROJ-1"], SITE));
  // The second read is served from the cache.
  expect(fetchCalls.length).toBe(afterFirst);

  await runEffect(moveIssue("PROJ-1", "Done", SITE));

  await runEffect(issuesByKeys(["PROJ-1"], SITE));
  // The move forgets the cached reads: the status we would otherwise keep showing is the one we
  // just changed.
  expect(fetchCalls.length).toBeGreaterThan(afterFirst);
});

// --- Reading issues ---------------------------------------------------------------------------

test("issuesByKeys asks once for a page of keys and maps them", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  stubFetch((url) =>
    url.pathname === "/rest/api/3/search/jql"
      ? json({
          issues: [
            {
              key: "PROJ-1",
              fields: {
                summary: "One",
                status: { name: "Done" },
                assignee: { displayName: "Ada" },
                issuetype: { name: "Story" },
              },
            },
            { key: "PROJ-2", fields: { summary: "Two" } },
          ],
        })
      : text("unexpected", 500),
  );

  const map = await runEffect(issuesByKeys(["PROJ-1", "PROJ-2"], SITE));

  expect([...map.keys()]).toEqual(["PROJ-1", "PROJ-2"]);
  expect(map.get("PROJ-1")).toEqual({
    key: "PROJ-1",
    summary: "One",
    assignee: "Ada",
    status: "Done",
    type: "Story",
    sprint: "",
  });
  expect(fetchCalls[0]!.url.searchParams.get("jql")).toBe("key in (PROJ-1,PROJ-2)");
});

test("issuesByKeys answers an empty map for no keys and for a failing query", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  stubFetch(() => text("never", 500));

  expect(await runEffect(issuesByKeys([], SITE))).toEqual(new Map());
  expect(fetchCalls.length).toBe(0);

  // A query that fails is no titles, not a failed page.
  const failed = await runEffect(issuesByKeys(["PROJ-1"], SITE));
  expect(failed.size).toBe(0);
});

test("issueByKey reads one issue and answers undefined when it cannot", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  stubFetch((url) =>
    url.pathname === "/rest/api/3/issue/PROJ-5"
      ? json({ key: "PROJ-5", fields: { summary: "Five", status: { name: "Done" } } })
      : text("not found", 404),
  );
  expect(await runEffect(issueByKey("PROJ-5", SITE))).toEqual({
    key: "PROJ-5",
    summary: "Five",
    assignee: "",
    status: "Done",
    type: "",
    sprint: "",
  });

  expect(await runEffect(issueByKey("PROJ-404", SITE))).toBeUndefined();
});

// --- accountId --------------------------------------------------------------------------------

test("accountId asks for the token's own account when nothing is configured", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  stubFetch((url) => (url.pathname === "/rest/api/3/myself" ? json({ accountId: "acc-me" }) : text("unexpected", 500)));
  expect(await runEffect(accountId("   ", SITE))).toBe("acc-me");

  // A token with no readable account id is no account to assign to.
  stubFetch((url) => (url.pathname === "/rest/api/3/myself" ? json({}) : text("unexpected", 500)));
  expect(await runEffect(accountId("", SITE))).toBeUndefined();
});

test("accountId passes an id through and searches for a name or email", async () => {
  setEnv("JIRA_API_TOKEN", "secret");

  stubFetch(() => text("never", 500));
  expect(await runEffect(accountId("5b10ac8d82e05b22cc7d4ef5", SITE))).toBe(
    "5b10ac8d82e05b22cc7d4ef5",
  );
  expect(fetchCalls.length).toBe(0);

  stubFetch((url) => (url.pathname === "/rest/api/3/user/search" ? json([{ accountId: "acc-search" }]) : text("unexpected", 500)));
  expect(await runEffect(accountId("Ada Lovelace", SITE))).toBe("acc-search");
  expect(fetchCalls[0]!.url.searchParams.get("query")).toBe("Ada Lovelace");

  // No match at all is no account, not the first arbitrary one.
  stubFetch((url) => (url.pathname === "/rest/api/3/user/search" ? json([]) : text("unexpected", 500)));
  expect(await runEffect(accountId("nobody@example.com", SITE))).toBeUndefined();
});

// --- The wizard's routes ----------------------------------------------------------------------

const getIssues = jiraExtension.routes!.find((route) => route.method === "GET")!;
const postIssues = jiraExtension.routes!.find((route) => route.method === "POST")!;

test("an unconfigured Jira leaves the wizard's table empty, and still usable", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  runtimeConfig().workspaces = [bareWorkspace("bare-ws")];
  stubFetch(() => text("never", 500));

  const response = await runEffect(
    getIssues.handler(new Request("http://x/issues?workspace=bare-ws")),
  );

  // A page, not a failure: the step renders this beside an empty table and lets you type an id.
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    issues: [],
    sprints: [],
    error: "no Jira server for this workspace — set Server in Settings",
  });
  expect(fetchCalls.length).toBe(0);
});

test("the wizard's create route refuses an empty summary and reports an unconfigured site", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  runtimeConfig().workspaces = [bareWorkspace("bare-ws")];
  stubFetch(() => json({ key: "PROJ-1" }));

  const empty = await runEffect(
    postIssues.handler(
      new Request("http://x/issues", { method: "POST", body: JSON.stringify({ workspace: "bare-ws" }) }),
    ),
  );
  expect(empty.status).toBe(400);
  expect(await empty.json()).toEqual({ error: "summary required" });
  expect(fetchCalls.length).toBe(0);

  // A good summary against a workspace with no site fails the request, and says why.
  const either = await runEither(
    postIssues.handler(
      new Request("http://x/issues", {
        method: "POST",
        body: JSON.stringify({ summary: "An issue", workspace: "bare-ws" }),
      }),
    ),
  );
  if (Either.isLeft(either)) {
    expect(either.left._tag).toBe("BadRequestError");
    expect(either.left.message).toBe("no Jira server for this workspace — set Server in Settings");
  } else {
    throw new Error("expected the unconfigured site to fail the request");
  }
  expect(fetchCalls.length).toBe(0);
});

// --- shared vocabulary ------------------------------------------------------------------------

test("ticketOf reads this extension's bag first and an early record's field second", () => {
  const withLegacy = (value: string): Change =>
    ({ ...change(), jira: value }) as unknown as Change;

  expect(ticketOf({ ...withLegacy("OLD-1"), extensions: { jira: { key: "PROJ-1" } } })).toBe("PROJ-1");
  // An empty bag entry does not shadow the field an early change record carries.
  expect(ticketOf({ ...withLegacy("OLD-1"), extensions: { jira: {} } })).toBe("OLD-1");
  expect(ticketOf(withLegacy("OLD-1"))).toBe("OLD-1");
  expect(ticketOf(change())).toBeUndefined();
});
