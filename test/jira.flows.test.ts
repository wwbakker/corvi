import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Either } from "effect";
import { clearCache } from "../src/core/platform/capabilities/cache.ts";
import { config, type Config, type Workspace } from "../src/workspace/server/index.ts";
import type { Change } from "../src/core/domain/change.ts";
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
} from "../src/extensions/jira/jira.ts";
import { jiraBaseUrl, jiraFetch, jiraSetup, parseJiraConfig } from "../src/extensions/jira/jiraHttp.ts";
import { accountId } from "../src/extensions/jira/account.ts";
import { runEffect } from "./helpers.ts";

/**
 * The Jira extension's server half, driven through a stubbed `fetch`. Every test configures the
 * site through a real jira-cli config file on disk — the seam `jiraFetch` actually reads — and
 * stubs only the HTTP boundary, so URL building, auth, error mapping and the request bodies are
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

const runEither = <A, E>(effect: Effect.Effect<A, E, never>): Promise<Either.Either<A, E>> =>
  Effect.runPromise(Effect.either(effect));

// --- Config fixtures --------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "iwe-jira-flows-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The four values jira-cli's own config holds, with the trailing slash every path is joined
 * onto. */
const JIRA_YAML = [
  "server: https://example.atlassian.net/",
  "login: someone@example.com",
  "board:",
  "    id: 169",
  "project:",
  "    key: PROJ",
].join("\n");

const writeConfig = (name: string, body: string = JIRA_YAML): string => {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
};

const validConfig = writeConfig("valid.yml");
const missingConfig = join(dir, "does-not-exist.yml");

const jiraWorkspace = (id: string, settings: Record<string, string>): Workspace => ({
  id,
  name: id,
  extensionSettings: { jira: settings },
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
  "JIRA_CONFIG_FILE",
  "OTHER_JIRA_TOKEN",
  "IWE_JIRA_SPRINT_STATES",
  "IWE_JIRA_ISSUE_TYPES",
  "IWE_JIRA_ISSUE_TYPE",
  "IWE_JIRA_ASSIGNEE",
] as const;

const originalEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
const setEnv = (key: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

// The config object is shared by reference across the server; the tests mutate and restore it.
// The legacy flat jira fields are no longer typed on the resolved config, but the loader carries
// them through, so the fallback these tests exercise reads them through one cast.
const legacyConfig = config as Config & { jiraAssignee?: string };
const originalWorkspaces = config.workspaces;
const originalAssignee = legacyConfig.jiraAssignee;
const originalExtensionSettings = config.extensionSettings;

beforeEach(() => clearCache());

afterEach(() => {
  config.workspaces = originalWorkspaces;
  legacyConfig.jiraAssignee = originalAssignee;
  config.extensionSettings = originalExtensionSettings;
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
      configFile: validConfig,
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
      configFile: validConfig,
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
  expect(await runEffect(jiraFetch("/rest/api/3/issue/PROJ-1", { configFile: validConfig }))).toBeUndefined();
});

test("jiraFetch maps Jira's errorMessages and errors onto one line", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  stubFetch(() =>
    json({ errorMessages: ["Issue does not exist"], errors: { summary: "is required" } }, 400),
  );

  const either = await runEither(jiraFetch("/rest/api/3/issue/PROJ-1", { configFile: validConfig }));
  expect(Either.isLeft(either)).toBe(true);
  if (Either.isLeft(either)) {
    expect(either.left.message).toBe("jira 400: Issue does not exist; is required");
  }
});

test("jiraFetch falls back to the first line, then the status text, for an unexplained error", async () => {
  setEnv("JIRA_API_TOKEN", "secret");

  stubFetch(() => text("server exploded\nmore noise", 502, "Bad Gateway"));
  const firstLine = await runEither(jiraFetch("/x", { configFile: validConfig }));
  if (Either.isLeft(firstLine)) expect(firstLine.left.message).toBe("jira 502: server exploded");

  // An empty body has no first line, so the status text is the only thing left to say.
  stubFetch(() => text("", 500, "Internal Server Error"));
  const empty = await runEither(jiraFetch("/x", { configFile: validConfig }));
  if (Either.isLeft(empty)) expect(empty.left.message).toBe("jira 500: Internal Server Error");
});

test("jiraFetch reports a failed request and a failed body read as BadRequestError", async () => {
  setEnv("JIRA_API_TOKEN", "secret");

  stubFetch(() => {
    throw new Error("connection refused");
  });
  const network = await runEither(jiraFetch("/x", { configFile: validConfig }));
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
  const body = await runEither(jiraFetch("/x", { configFile: validConfig }));
  if (Either.isLeft(body)) expect(body.left.message).toBe("jira response failed: body gone");
});

test("jiraFetch reads a non-JSON success body as a BadRequestError", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  stubFetch(() => text("not json", 200));
  const either = await runEither(jiraFetch("/x", { configFile: validConfig }));
  expect(Either.isLeft(either)).toBe(true);
  if (Either.isLeft(either)) expect(either.left.message.length).toBeGreaterThan(0);
});

test("jiraFetch fails with the config file named when the site is not configured", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  stubFetch(() => json({ ok: true }));

  const either = await runEither(jiraFetch("/x", { configFile: missingConfig }));
  expect(Either.isLeft(either)).toBe(true);
  if (Either.isLeft(either)) {
    expect(either.left.message).toBe(`no Jira site configured in ${missingConfig} — run \`jira init\``);
  }
  // Nothing was asked of Jira: the failure is decided before the request.
  expect(fetchCalls.length).toBe(0);
});

test("jiraFetch fails naming the token variable when its token is not set", async () => {
  setEnv("JIRA_API_TOKEN", undefined);
  stubFetch(() => json({ ok: true }));

  const either = await runEither(jiraFetch("/x", { configFile: validConfig }));
  if (Either.isLeft(either)) {
    expect(either.left.message).toBe("JIRA_API_TOKEN is not set in the environment");
  } else {
    throw new Error("expected the request to fail");
  }
  expect(fetchCalls.length).toBe(0);
});

test("jiraFetch takes the token from the site's own environment variable", async () => {
  setEnv("JIRA_API_TOKEN", undefined);
  setEnv("OTHER_JIRA_TOKEN", "other-secret");
  stubFetch(() => json({ ok: true }));

  await runEffect(jiraFetch("/x", { configFile: validConfig, tokenEnv: "OTHER_JIRA_TOKEN" }));
  const headers = fetchCalls[0]!.init?.headers as Record<string, string>;
  expect(headers["authorization"]).toBe(`Basic ${btoa("someone@example.com:other-secret")}`);
});

test("jiraFetch resolves the config file from JIRA_CONFIG_FILE when none is named", async () => {
  setEnv("JIRA_API_TOKEN", undefined);
  setEnv("JIRA_CONFIG_FILE", missingConfig);
  stubFetch(() => json({ ok: true }));

  const either = await runEither(jiraFetch("/x"));
  if (Either.isLeft(either)) {
    expect(either.left.message).toBe(`no Jira site configured in ${missingConfig} — run \`jira init\``);
  } else {
    throw new Error("expected the request to fail");
  }
  expect(fetchCalls.length).toBe(0);
});

// --- jiraSetup and parseJiraConfig ------------------------------------------------------------

test("jiraSetup reads the four values jira-cli's config holds, and an unreadable file is empty", async () => {
  const path = writeConfig("setup.yml");
  expect(await runEffect(jiraSetup(path))).toEqual({
    server: "https://example.atlassian.net",
    login: "someone@example.com",
    board: "169",
    project: "PROJ",
  });
  expect(await runEffect(jiraBaseUrl(path))).toBe("https://example.atlassian.net");

  expect(await runEffect(jiraSetup(missingConfig))).toEqual({});
  expect(await runEffect(jiraBaseUrl(missingConfig))).toBeUndefined();
});

test("jiraSetup reads a config file once: a later write to the same path is not seen", async () => {
  const path = writeConfig("memo.yml");
  const first = await runEffect(jiraSetup(path));
  writeFileSync(path, "server: https://other.example\nlogin: other@example.com\n");
  const second = await runEffect(jiraSetup(path));
  expect(second).toEqual(first);
  expect(second.server).toBe("https://example.atlassian.net");
});

test("parseJiraConfig reads quoted values and only the keys at their known depth", () => {
  const yaml = [
    "auth_type: basic",
    "board:",
    '    id: "169"',
    "    name: PROJ board",
    "project:",
    '    key: "PROJ"',
    "server: https://x.example/",
    "login: a@b.c",
  ].join("\n");
  expect(parseJiraConfig(yaml)).toEqual({
    server: "https://x.example",
    login: "a@b.c",
    board: "169",
    project: "PROJ",
  });

  // An indented `server:` is not a top-level one, and `id` is only read under `board`.
  const nestedOnly = ["  server: https://nested.example", "board:", "    id: 1"].join("\n");
  expect(parseJiraConfig(nestedOnly)).toEqual({
    server: undefined,
    login: undefined,
    board: "1",
    project: undefined,
  });
  // No parent key at all leaves the nested values unset.
  expect(parseJiraConfig("login: a@b.c")).toEqual({
    server: undefined,
    login: "a@b.c",
    board: undefined,
    project: undefined,
  });
});

// --- Site and global settings resolution ------------------------------------------------------

test("siteOfWorkspace carries only what the workspace declared, bag first", () => {
  expect(
    siteOfWorkspace({
      extensionSettings: { jira: { configFile: "/s.yml", project: "P", board: "9", tokenEnv: "T" } },
    }),
  ).toEqual({ configFile: "/s.yml", project: "P", board: "9", tokenEnv: "T" });
  expect(siteOfWorkspace({})).toEqual({
    configFile: undefined,
    project: undefined,
    board: undefined,
    tokenEnv: undefined,
  });

  // A workspace written before the bag carries a legacy `jira` object; the bag's own fields win,
  // and the rest still answer from the legacy site.
  const legacy = {
    extensionSettings: { jira: { project: "BAG" } },
    jira: { project: "LEGACY", board: "7", configFile: "/old.yml" },
  };
  expect(siteOfWorkspace(legacy)).toEqual({
    configFile: "/old.yml",
    project: "BAG",
    board: "7",
    tokenEnv: undefined,
  });
  // `false` and a non-object are no site, not a site with everything absent.
  expect(siteOfWorkspace({ jira: false })).toEqual({
    configFile: undefined,
    project: undefined,
    board: undefined,
    tokenEnv: undefined,
  });
});

test("siteOf and siteFor resolve a change's and an id's Jira", () => {
  config.workspaces = [
    { id: "client", name: "Client", extensionSettings: { jira: { project: "CLI" } } },
    { id: "other", name: "Other" },
  ];
  expect(siteOf({ workspace: "client" })).toEqual({
    configFile: undefined,
    project: "CLI",
    board: undefined,
    tokenEnv: undefined,
  });
  expect(siteFor("client").project).toBe("CLI");
  expect(siteFor("other")).toEqual({
    configFile: undefined,
    project: undefined,
    board: undefined,
    tokenEnv: undefined,
  });
  // An unknown id falls back to the first workspace, where a change without one lives.
  expect(siteFor("nope").project).toBe("CLI");
});

test("globalOf lets the settings bag win and treats an empty or non-string value as unset", () => {
  const flat = {
    jiraAssignee: "flat@example.com",
    jiraStartTransition: "Start",
    jiraDoneTransition: "Done",
  } as unknown as Config;
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
  } as unknown as Config;
  expect(globalOf(bagged)).toEqual({
    assignee: "bag@example.com",
    startTransition: "Start",
    doneTransition: "Done",
  });

  // A value with text is used as written: the trim is only the emptiness test.
  const spaced = { ...flat, extensionSettings: { jira: { assignee: "  bag  " } } } as unknown as Config;
  expect(globalOf(spaced).assignee).toBe("  bag  ");

  // The environment variable still beats the legacy flat field, exactly as the resolved chain
  // did before the field left the core.
  setEnv("IWE_JIRA_ASSIGNEE", "env@example.com");
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
  setEnv("IWE_JIRA_SPRINT_STATES", "active");
  stubFetch((url) =>
    url.pathname === "/rest/agile/1.0/board/169/sprint"
      ? json({ values: [{ id: 1, name: "Sprint 1", state: "active" }] })
      : text("unexpected", 500),
  );

  const sprints = await runEffect(listSprints({ configFile: validConfig, board: "169" }));
  // Jira answers with a numeric id; ours is a string key.
  expect(sprints).toEqual([{ id: "1", name: "Sprint 1", state: "active" }]);
  expect(fetchCalls[0]!.url.searchParams.get("state")).toBe("active");
});

test("listSprints reads the board from jira-cli's config and fails when there is none", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  stubFetch((url) => (url.pathname.endsWith("/sprint") ? json({ values: [] }) : text("unexpected", 500)));

  expect(await runEffect(listSprints({ configFile: validConfig }))).toEqual([]);
  expect(fetchCalls[0]!.url.pathname).toBe("/rest/agile/1.0/board/169/sprint");

  stubFetch(() => text("never", 500));
  const either = await runEither(listSprints({ configFile: missingConfig }));
  if (Either.isLeft(either)) {
    expect(either.left.message).toBe("no board configured in jira-cli's config — run `jira init`");
  } else {
    throw new Error("expected the sprint list to fail");
  }
  expect(fetchCalls.length).toBe(0);
});

test("boardIssues groups sprints and the backlog, filtered to workable types", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  const cfg = writeConfig("board-issues.yml");
  config.workspaces = [jiraWorkspace("board-ws", { configFile: cfg, board: "169", project: "PROJ" })];
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
});

test("boardIssues answers an error string and still names the base URL when Jira fails", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  const cfg = writeConfig("board-error.yml");
  config.workspaces = [jiraWorkspace("board-error-ws", { configFile: cfg, board: "169", project: "PROJ" })];
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
  const cfg = writeConfig("board-cache.yml");
  config.workspaces = [jiraWorkspace("board-cache-ws", { configFile: cfg, board: "169", project: "PROJ" })];
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

// --- createIssue ------------------------------------------------------------------------------

test("createIssue creates the issue, assigns it and returns what the wizard selects", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  config.workspaces = [jiraWorkspace("create-ws", { configFile: validConfig, project: "PROJ" })];
  legacyConfig.jiraAssignee = "";
  config.extensionSettings = undefined;
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
  config.workspaces = [jiraWorkspace("create-ws", { configFile: validConfig, project: "PROJ" })];
  legacyConfig.jiraAssignee = "unused@example.com";
  config.extensionSettings = undefined;
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
  config.workspaces = [jiraWorkspace("create-ws", { configFile: validConfig, project: "PROJ" })];
  legacyConfig.jiraAssignee = "5b10ac8d82e05b22cc7d4ef5";
  config.extensionSettings = undefined;
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
  config.workspaces = [jiraWorkspace("create-ws", { configFile: validConfig, project: "PROJ" })];
  legacyConfig.jiraAssignee = "ada@example.com";
  config.extensionSettings = undefined;
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

test("createIssue requires a summary and a project", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  stubFetch(() => text("never", 500));

  const noSummary = await runEither(createIssue({ summary: "   " }));
  if (Either.isLeft(noSummary)) expect(noSummary.left.message).toBe("summary required");
  else throw new Error("expected a missing summary to fail");
  expect(fetchCalls.length).toBe(0);

  config.workspaces = [jiraWorkspace("bare-ws", { configFile: missingConfig })];
  const noProject = await runEither(createIssue({ summary: "No project", workspace: "bare-ws" }));
  if (Either.isLeft(noProject)) {
    expect(noProject.left.message).toBe("no project configured in jira-cli's config — run `jira init`");
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
  await runEffect(moveIssue("PROJ-1", "done", { configFile: validConfig }));

  // Some transitions have a workflow name that differs from where they land; both are matched,
  // case-insensitively.
  transitions = [{ id: "31", name: "Start work", to: { name: "In Progress" } }];
  await runEffect(moveIssue("PROJ-1", "IN PROGRESS", { configFile: validConfig }));

  const posts = fetchCalls.filter((c) => c.init?.method === "POST");
  expect(posts.length).toBe(2);
  expect(JSON.parse(posts[0]!.init?.body as string)).toEqual({ transition: { id: "11" } });
  expect(JSON.parse(posts[1]!.init?.body as string)).toEqual({ transition: { id: "31" } });
});

test("moveIssue lists the available transitions when the name is not one of them", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  stubFetch(() => json({ transitions: [{ id: "1", name: "To Do" }, { id: "2", name: "In Progress" }] }));

  const either = await runEither(moveIssue("PROJ-1", "Done", { configFile: validConfig }));
  if (Either.isLeft(either)) {
    expect(either.left.message).toBe(
      'PROJ-1: cannot move to "Done" from here — available: To Do, In Progress',
    );
  } else {
    throw new Error("expected the move to fail");
  }
  expect(fetchCalls.some((c) => c.init?.method === "POST")).toBe(false);

  stubFetch(() => json({}));
  const none = await runEither(moveIssue("PROJ-1", "Done", { configFile: validConfig }));
  if (Either.isLeft(none)) {
    expect(none.left.message).toBe('PROJ-1: cannot move to "Done" from here — available: none');
  } else {
    throw new Error("expected the move to fail");
  }
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

  const map = await runEffect(issuesByKeys(["PROJ-1", "PROJ-2"], { configFile: validConfig }));

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

  expect(await runEffect(issuesByKeys([], { configFile: validConfig }))).toEqual(new Map());
  expect(fetchCalls.length).toBe(0);

  // A query that fails is no titles, not a failed page.
  const failed = await runEffect(issuesByKeys(["PROJ-1"], { configFile: validConfig }));
  expect(failed.size).toBe(0);
});

test("issueByKey reads one issue and answers undefined when it cannot", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  stubFetch((url) =>
    url.pathname === "/rest/api/3/issue/PROJ-5"
      ? json({ key: "PROJ-5", fields: { summary: "Five", status: { name: "Done" } } })
      : text("not found", 404),
  );
  expect(await runEffect(issueByKey("PROJ-5", { configFile: validConfig }))).toEqual({
    key: "PROJ-5",
    summary: "Five",
    assignee: "",
    status: "Done",
    type: "",
    sprint: "",
  });

  expect(await runEffect(issueByKey("PROJ-404", { configFile: validConfig }))).toBeUndefined();
});

// --- accountId --------------------------------------------------------------------------------

test("accountId asks for the token's own account when nothing is configured", async () => {
  setEnv("JIRA_API_TOKEN", "secret");
  stubFetch((url) => (url.pathname === "/rest/api/3/myself" ? json({ accountId: "acc-me" }) : text("unexpected", 500)));
  expect(await runEffect(accountId("   ", { configFile: validConfig }))).toBe("acc-me");

  // A token with no readable account id is no account to assign to.
  stubFetch((url) => (url.pathname === "/rest/api/3/myself" ? json({}) : text("unexpected", 500)));
  expect(await runEffect(accountId("", { configFile: validConfig }))).toBeUndefined();
});

test("accountId passes an id through and searches for a name or email", async () => {
  setEnv("JIRA_API_TOKEN", "secret");

  stubFetch(() => text("never", 500));
  expect(await runEffect(accountId("5b10ac8d82e05b22cc7d4ef5", { configFile: validConfig }))).toBe(
    "5b10ac8d82e05b22cc7d4ef5",
  );
  expect(fetchCalls.length).toBe(0);

  stubFetch((url) => (url.pathname === "/rest/api/3/user/search" ? json([{ accountId: "acc-search" }]) : text("unexpected", 500)));
  expect(await runEffect(accountId("Ada Lovelace", { configFile: validConfig }))).toBe("acc-search");
  expect(fetchCalls[0]!.url.searchParams.get("query")).toBe("Ada Lovelace");

  // No match at all is no account, not the first arbitrary one.
  stubFetch((url) => (url.pathname === "/rest/api/3/user/search" ? json([]) : text("unexpected", 500)));
  expect(await runEffect(accountId("nobody@example.com", { configFile: validConfig }))).toBeUndefined();
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
