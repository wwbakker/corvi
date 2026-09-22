import { Effect } from "effect";
import type { ChangeWireDto as Change } from "@corvi/contracts/api";
import { env } from "@corvi/configuration/node";
import type { ResolvedDto } from "@corvi/contracts/config";
import { bagString } from "@corvi/configuration/settings";
import { jiraFetch, siteBaseUrl, siteCheck } from "./jiraHttp.ts";
import { accountId } from "./account.ts";
import { legacyGlobalOf, legacySiteOfWorkspace, legacyTicketOf } from "./legacy.ts";
import type { LegacyFlatSettings } from "./legacy.ts";
import { workspaceById, workspaceOf } from "@corvi/configuration/workspaces";
import { Cache, Settings, invalidate, swr } from "@corvi/contracts/capabilities";
import { BadRequestError } from "@corvi/contracts/errors";
import { messageOf } from "@corvi/shell/cli";
import type { Board, Issue, Sprint, TicketRef } from "@corvi/contracts/integrations/jira";

export type { Issue, Sprint } from "@corvi/contracts/integrations/jira";

/**
 * The change's ticket key, from wherever this extension put it.
 *
 * The wizard's step writes the `extensions` bag; an early change record may carry the legacy
 * `jira` field instead, so both are read, the bag first. This is the one function that knows
 * about either, and the legacy read goes through `legacy.ts`, the one place that names it.
 */
// Pure and synchronous: nothing for an Effect to wrap.
export const ticketOf = (change: Change): string | undefined =>
  (change.extensions?.["jira"] as TicketRef | undefined)?.key ?? legacyTicketOf(change);

/**
 * Which Jira: whose site, whose account, which project, which board.
 *
 * A workspace that sets nothing uses the application-wide default — `extensionSettings.jira` at the
 * root, which is also where this extension's server-wide settings live — and overrides it field
 * by field, so a second client states the fields that differ rather than all of them. The token
 * may be stored here or read from an environment variable the site names.
 *
 * This type holds a secret, so it stays server-side: it is not in the shared wire vocabulary, whose whole purpose
 * is to be importable by the browser half, and no route hands the page one.
 */
export type Site = {
  /** e.g. https://example.atlassian.net */
  server?: string;
  /** The Atlassian account email, which is the username half of basic auth. */
  email?: string;
  project?: string;
  board?: string;
  /** Which environment variable holds this site's token, when one is not stored. */
  tokenEnv?: string;
  /** The token itself, when it was typed on the settings page rather than exported. */
  token?: string;
};

/**
 * This workspace's Jira, from the settings this extension itself declares: the fields under
 * `workspace.extensionSettings.jira`, which the settings page renders from `workspaceSettings`,
 * and — for a workspace written before the bag — the legacy `workspace.jira` object, read through
 * `legacy.ts`. Either of those answers before the config root's bag, so a workspace overrides the
 * default site field by field.
 *
 * The two token fields resolve as one decision rather than as two independent ones: a workspace
 * that names its own `tokenEnv` has said where its credential comes from, so it does not also
 * inherit the default site's stored token — which is what would send one client's token to
 * another, with no way for the workspace to say otherwise.
 */
export function siteOfWorkspace(settings: ResolvedDto, workspace: {
  extensionSettings?: Record<string, Record<string, string>>;
  /** The legacy per-workspace site object, preserved on a workspace written before the bag. */
  jira?: unknown;
}): Site {
  const own = workspace.extensionSettings?.jira;
  const legacy = legacySiteOfWorkspace(workspace);
  const global = settings.extensionSettings?.jira;
  const namesOwnVariable = own?.tokenEnv !== undefined || legacy.tokenEnv !== undefined;
  // A token is never legacy: an early workspace's object could name a variable or a site, and the
  // token was the environment's either way.
  const stored = bagString(own, "token");
  // The server and the account have no legacy per-workspace form to answer from: they used to
  // come out of the config file a legacy workspace named, and that file is not read any more.
  return {
    server: bagString(own, "server") ?? bagString(global, "server"),
    email: bagString(own, "email") ?? bagString(global, "email"),
    project: bagString(own, "project") ?? legacy.project ?? bagString(global, "project"),
    board: bagString(own, "board") ?? legacy.board ?? bagString(global, "board"),
    tokenEnv: bagString(own, "tokenEnv") ?? legacy.tokenEnv ?? bagString(global, "tokenEnv"),
    token: stored ?? (namesOwnVariable ? undefined : bagString(global, "token")),
  };
}

// Pure and synchronous: nothing for an Effect to wrap.
export const siteOf = (settings: ResolvedDto, change: { workspace?: string }): Site =>
  siteOfWorkspace(settings, workspaceOf(settings.workspaces, change));
// Pure and synchronous: nothing for an Effect to wrap.
export const siteFor = (settings: ResolvedDto, workspaceId?: string): Site =>
  siteOfWorkspace(settings, workspaceById(settings.workspaces, workspaceId));

/** What `globalOf` reads from a config: this integration's own server-wide bag and the flat
 * fields older files still carry (`LegacyFlatSettings`). The resolved settings the `Settings`
 * capability holds and the app's `Config` both satisfy it, so a caller passes whichever it
 * holds, and a reader that states only these fields is a reader that typechecks as itself. */
export type GlobalSettings = {
  extensionSettings?: ResolvedDto["extensionSettings"];
} & LegacyFlatSettings;

/**
 * The server-wide settings this integration declares (`globalSettings`), read back from the
 * resolved settings' `extensionSettings.jira` bag — what the settings page writes — with the
 * core's legacy flat `jira*` fields as the fallback. The fallback carries the default and the
 * environment resolution (CORVI_JIRA_ASSIGNEE and friends beat the file); `legacy.ts` is where
 * that fallback lives. A bag value that is not a string, or an empty one, is not set: empty
 * means unset.
 */
// Pure and synchronous: nothing for an Effect to wrap.
export function globalOf(settings: GlobalSettings): {
  assignee: string;
  startTransition: string;
  doneTransition: string;
} {
  const bag = settings.extensionSettings?.jira;
  const own = (key: string): string | undefined => bagString(bag, key);
  const legacy = legacyGlobalOf(settings);
  return {
    assignee: own("assignee") ?? legacy.assignee,
    startTransition: own("startTransition") ?? legacy.startTransition,
    doneTransition: own("doneTransition") ?? legacy.doneTransition,
  };
}

/** Namespaces the cache: two sites answering "PROJ-1" differently is exactly the bug this
 * prevents, and a board belongs to one of them. The email is part of it because two accounts on
 * one site can see different issues. Exported, because both halves key their caches from it and
 * two spellings of one namespace is how they drift apart. */
export const siteKey = (site: Site): string =>
  [site.server, site.email, site.project, site.board, site.tokenEnv].filter(Boolean).join("|") ||
  "default";

/** Which sprints the board view covers. Closed sprints are finished work, so they are excluded
 * by default. Override with CORVI_JIRA_SPRINT_STATES (e.g. "active,future,closed"). */
const sprintStates = (): string => process.env[env("JIRA_SPRINT_STATES")] ?? "active,future";

/** Issue types offered for a change. Epics and subtasks are containers, not units of work.
 * Override with CORVI_JIRA_ISSUE_TYPES. */
const issueTypes = (): string[] =>
  (process.env[env("JIRA_ISSUE_TYPES")] ?? "Story,Bug")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

/** Issue type used when creating an issue from the wizard. Override with CORVI_JIRA_ISSUE_TYPE. */
const issueType = (): string => process.env[env("JIRA_ISSUE_TYPE")] ?? "Story";

/** Jira is the slowest of the sources and the least volatile. */
const ISSUE_TTL = 60_000;

/** The fields we ask for, and no more: an issue with every field is a hundred kilobytes of
 * custom fields nobody here reads. */
const FIELDS = "summary,status,assignee,issuetype";

/** What Jira answers with, of the fields we asked for. */
export type IssueJson = {
  key: string;
  fields?: {
    summary?: string;
    status?: { name?: string };
    assignee?: { displayName?: string } | null;
    issuetype?: { name?: string };
  };
};

type SearchJson = { issues?: IssueJson[]; nextPageToken?: string };

/** Jira's shape, flattened to ours. The sprint is not a field of the issue in any useful sense —
 * it is which query found it — so it is passed in. */
// Pure and synchronous: nothing for an Effect to wrap.
export function issueFrom(json: IssueJson, sprint = ""): Issue {
  const fields = json.fields ?? {};
  return {
    key: json.key,
    summary: (fields.summary ?? "").trim(),
    assignee: fields.assignee?.displayName ?? "",
    status: fields.status?.name ?? "",
    type: fields.issuetype?.name ?? "",
    sprint,
  };
}

/** Issues of a JQL query. Paged with `nextPageToken`; a board is small, so the page size is the
 * limit that matters. */
const search = (jql: string, site: Site, limit = 100): Effect.Effect<Issue[], BadRequestError> =>
  Effect.gen(function* () {
    const issues: Issue[] = [];
    let token: string | undefined;
    do {
      const page = yield* jiraFetch<SearchJson>("/rest/api/3/search/jql", {
        site,
        query: {
          jql,
          fields: FIELDS,
          maxResults: String(Math.min(limit - issues.length, 100)),
          nextPageToken: token,
        },
      });
      issues.push(...(page.issues ?? []).map((i) => issueFrom(i)));
      token = page.nextPageToken;
    } while (token && issues.length < limit);
    return issues;
  });

/**
 * The board's id: the configured one, or the project's when it has exactly one.
 *
 * A board id is the least knowable thing in the set, and a project key is what people have in
 * hand, so a project with one board never asks for the id. A project with several names them all
 * and asks, which is also what leaves the choice to the person who knows it.
 *
 * Cached, because the board view asks once per sprint: an uncached lookup would be one extra
 * request per sprint on every visit. The failure is a `BadRequestError`, which `swr` carries
 * through, so "has 3 boards" reaches the page rather than going quiet.
 */
const boardId = (site: Site): Effect.Effect<string, BadRequestError, Cache> =>
  Effect.gen(function* () {
    // The site before the board: "set Project or Board" is not the answer for a workspace that has
    // no server at all, and this runs before any request would have said so.
    const check = siteCheck(site);
    if ("problem" in check) {
      return yield* new BadRequestError({ message: check.problem });
    }
    if (site.board) return site.board;
    const project = site.project;
    if (!project) {
      return yield* new BadRequestError({
        message: "no Jira board for this workspace — set Project or Board in Settings",
      });
    }
    return yield* swr(
      `jira:${siteKey(site)}:board-id`,
      ISSUE_TTL,
      Effect.gen(function* () {
        const json = yield* jiraFetch<{ values?: { id: number; name: string }[] }>(
          "/rest/agile/1.0/board",
          { site, query: { projectKeyOrId: project } },
        );
        const boards = json.values ?? [];
        const [first, second] = boards;
        // Exactly one is the only case that needs no one's opinion; the first of several is not
        // a choice this can make.
        if (first && !second) return String(first.id);
        if (!first) {
          return yield* new BadRequestError({
            message: `no board in project ${project} — set Board in Settings`,
          });
        }
        const named = boards.map((board) => `${board.name} (${board.id})`).join(", ");
        return yield* new BadRequestError({
          message: `project ${project} has ${boards.length} boards: ${named} — set Board in Settings`,
        });
      }),
    );
  });

export const listSprints = (site: Site = {}): Effect.Effect<Sprint[], BadRequestError, Cache> =>
  Effect.gen(function* () {
    const json = yield* jiraFetch<{ values?: { id: number; name: string; state: string }[] }>(
      `/rest/agile/1.0/board/${yield* boardId(site)}/sprint`,
      { site, query: { state: sprintStates() } },
    );
    return (json.values ?? []).map((s) => ({ id: String(s.id), name: s.name, state: s.state }));
  });


/** The issues of one sprint, named after it: the board view groups by sprint, and the sprint an
 * issue is in is the query that found it. */
const issuesInSprint = (sprint: Sprint, site: Site): Effect.Effect<Issue[], BadRequestError, Cache> =>
  Effect.gen(function* () {
    const json = yield* jiraFetch<{ issues?: IssueJson[] }>(
      `/rest/agile/1.0/board/${yield* boardId(site)}/sprint/${sprint.id}/issue`,
      { site, query: { fields: FIELDS, maxResults: "100" } },
    );
    return (json.issues ?? []).map((i) => issueFrom(i, sprint.name));
  });

/** Work that is not in a sprint yet, and not finished. The project is required rather than
 * optional: without it this query would read the whole site's backlog, which is not what a
 * workspace's picker is for. */
const backlogIssues = (site: Site): Effect.Effect<Issue[], BadRequestError> =>
  Effect.gen(function* () {
    const project = site.project;
    if (!project) {
      return yield* new BadRequestError({
        message: "no Jira project for this workspace — set Project in Settings",
      });
    }
    return yield* search(
      `project = ${project} AND sprint is EMPTY AND statusCategory != Done ORDER BY rank`,
      site,
    );
  });

/** Only what a change can be made from: epics and subtasks are containers, not units of work. */
const workable = (issues: Issue[]): Issue[] => {
  const types = issueTypes();
  return issues.filter((i) => types.includes(i.type.toLowerCase()));
};

/** Everything on the board worth picking: open sprints plus the un-sprinted backlog. An error
 * string rather than a failure, because a broken or unconfigured Jira must still leave you able
 * to type a change id by hand. */
const readBoard = (site: Site): Effect.Effect<Board, never, Cache> =>
  Effect.map(
    Effect.catchAll(
      Effect.gen(function* () {
        const sprints = yield* listSprints(site);
        const groups = yield* Effect.all(
          [...sprints.map((sprint) => issuesInSprint(sprint, site)), backlogIssues(site)],
          // Unbounded on purpose: every sprint and the backlog are independent queries.
          { concurrency: "unbounded" },
        );
        const issues = workable(groups.flat());
        const board: Board = { issues, sprints: sprintNames(issues) };
        return board;
      }),
      (e): Effect.Effect<Board, never, Cache> => Effect.succeed({ issues: [], sprints: [], error: messageOf(e) }),
    ),
    (board): Board => ({ ...board, baseUrl: siteBaseUrl(site) }),
  );

/** What creating an issue has to forget, so the issue it just made shows up in the table. */
const boardViewKey = (site: Site): string => `jira:${siteKey(site)}:board-view`;

/** The board view, cached briefly through the same cache as everything else — it is the one the
 * wizard re-reads on every visit, and one cache means `invalidate` and the tests' `clearCache`
 * reach it. `force` is the refresh button: it waits for the current answer rather than racing a
 * background one. */
export const boardIssues = (
  workspaceId?: string,
  force = false,
): Effect.Effect<Board, never, Settings | Cache> =>
  Effect.gen(function* () {
    const settings = yield* Settings;
    const site = siteFor(settings, workspaceId);
    const key = boardViewKey(site);
    if (force) yield* invalidate(key);
    return yield* swr(key, ISSUE_TTL, readBoard(site));
  });


const sprintNames = (issues: Issue[]): string[] => [
  ...new Set(issues.map((i) => i.sprint).filter(Boolean)),
];

/** Plain text as Jira Cloud wants it: v3 takes a document, not a string. One paragraph per line
 * is the whole of what a description typed into a form needs. */
const document = (
  text: string,
): {
  type: string;
  version: number;
  content: { type: string; content: { type: string; text: string }[] }[];
} => ({
  type: "doc",
  version: 1,
  content: text.split("\n").map((line) => ({
    type: "paragraph",
    content: line ? [{ type: "text", text: line }] : [],
  })),
});

/** Creates an issue and returns it, so the wizard can select what it just made. */
export const createIssue = (input: {
  summary: string;
  description?: string;
  type?: string;
  assignToMe?: boolean;
  /** Which context it belongs to, and therefore which Jira it is created in. */
  workspace?: string;
}): Effect.Effect<Issue, BadRequestError, Settings | Cache> =>
  Effect.gen(function* () {
    const summary = input.summary.trim();
    if (!summary) {
      return yield* new BadRequestError({ message: "summary required" });
    }
    const site = siteFor(yield* Settings, input.workspace);
    // The site first: a workspace with nothing configured must be told that, not that its project
    // is missing — the project is only unreachable because the site is.
    const check = siteCheck(site);
    if ("problem" in check) {
      return yield* new BadRequestError({ message: check.problem });
    }
    const project = site.project;
    if (!project) {
      return yield* new BadRequestError({
        message: "no Jira project for this workspace — set Project in Settings",
      });
    }
    const type = input.type ?? issueType();

    const created = yield* jiraFetch<{ key: string }>("/rest/api/3/issue", {
      site,
      method: "POST",
      body: {
        fields: {
          project: { key: project },
          issuetype: { name: type },
          summary,
          ...(input.description?.trim() ? { description: document(input.description.trim()) } : {}),
        },
      },
    });

    if (input.assignToMe !== false) {
      // Assigning is a field like any other, but its value is an account id, not a name.
      const account = yield* accountId(globalOf(yield* Settings).assignee, site);
      if (account) {
        yield* jiraFetch(`/rest/api/3/issue/${created.key}/assignee`, {
          site,
          method: "PUT",
          body: { accountId: account },
        });
      }
    }

    yield* invalidate(boardViewKey(site)); // the new issue must show up in the table straight away
    return { key: created.key, summary, assignee: "", status: "", type, sprint: "" };
  });


/**
 * Move an issue to another status.
 *
 * Jira transitions by id, not by name, and which ones exist depends on where the issue is now.
 * Asking first is what makes a wrong name a sentence you can act on — "Done is not one of: To
 * Do, In Progress" — rather than a flat refusal.
 */
export const moveIssue = (
  key: string,
  status: string,
  site: Site = {},
): Effect.Effect<void, BadRequestError, Cache> =>
  Effect.gen(function* () {
    const { transitions = [] } = yield* jiraFetch<{
      transitions?: { id: string; name: string; to?: { name?: string } }[];
    }>(`/rest/api/3/issue/${key}/transitions`, { site });

    const wanted = status.trim().toLowerCase();
    const found = transitions.find(
      (t) => t.name.toLowerCase() === wanted || t.to?.name?.toLowerCase() === wanted,
    );
    if (!found) {
      const names = transitions.map((t) => t.name).join(", ") || "none";
      return yield* new BadRequestError({
        message: `${key}: cannot move to "${status}" from here — available: ${names}`,
      });
    }

    yield* jiraFetch(`/rest/api/3/issue/${key}/transitions`, {
      site,
      method: "POST",
      body: { transition: { id: found.id } },
    });
    yield* invalidate("jira:"); // the status we would otherwise keep showing is the one we just changed
  });

/**
 * Several issues in one query, for the overview: one call for a whole page of changes rather
 * than one per row. An unknown key is simply absent from the result.
 */
export const issuesByKeys = (
  keys: string[],
  site: Site = {},
): Effect.Effect<Map<string, Issue>, never, Cache> =>
  Effect.gen(function* () {
    if (keys.length === 0) return new Map();
    // A ticket's summary and status change a few times a day at most, and the same keys are asked
    // for by the overview on every visit. Keyed by site as well: two of them answer "PROJ-1"
    // differently, and both are right.
    return yield* swr(
      `jira:${siteKey(site)}:keys:${[...keys].sort().join(",")}`,
      ISSUE_TTL,
      Effect.catchAll(
        search(`key in (${keys.join(",")})`, site, keys.length),
        () => Effect.succeed([] as Issue[]),
      ).pipe(
        Effect.map((issues) => new Map(issues.map((i) => [i.key, i]))),
      ),
    );
  });


/** One issue by key, whatever its type: used for the widget, the status check and descriptions. */
export const issueByKey = (key: string, site: Site = {}): Effect.Effect<Issue | undefined> =>
  Effect.orElseSucceed(
    Effect.map(
      jiraFetch<IssueJson>(`/rest/api/3/issue/${key}`, { site, query: { fields: FIELDS } }),
      issueFrom,
    ),
    () => undefined,
  );
