import { Effect, Either } from "effect";
import type { WidgetState } from "../../types.ts";
import { swrEffect, invalidate } from "../../cache.ts";
import { config, type Config } from "../../config.ts";
import { jiraFetchEffect, jiraSetupEffect, jiraBaseUrlEffect } from "./jiraHttp.ts";
import { accountIdEffect } from "./account.ts";
import { workspaceById, workspaceOf } from "../../workspaces.ts";
import { BadRequestError } from "../../effect/errors.ts";
import { messageOf } from "../../effect/support.ts";
import type { Issue, Sprint } from "./shared.ts";

export type { Issue, Sprint } from "./shared.ts";
export { ticketOf } from "./shared.ts";


/**
 * Which Jira: whose config file, which project, which board.
 *
 * A workspace that says nothing uses jira-cli's own config, which is what every call did before
 * workspaces existed. A second client names its own file, so two sites can be open at once.
 */
export type Site = {
  configFile?: string;
  project?: string;
  board?: string;
  /** Which environment variable holds this site's API token. */
  tokenEnv?: string;
};

/**
 * This workspace's Jira site, from the settings this extension itself declares: the fields under
 * `workspace.extensionSettings.jira` — which the settings page renders from `workspaceSettings`
 * and which `migrateWorkspaceSettings` fills from the legacy `jira` object. Every field
 * optional; absent means jira-cli's own config, which is what every call did before
 * workspaces existed. A second client names its own file, so two sites can be open at once.
 */
export function siteOfWorkspace(workspace: {
  extensionSettings?: Record<string, Record<string, string>>;
}): Site {
  const own = workspace.extensionSettings?.jira;
  return {
    configFile: own?.configFile,
    project: own?.project,
    board: own?.board,
    tokenEnv: own?.tokenEnv,
  };
}

// Pure and synchronous: nothing for an Effect to wrap.
export const siteOf = (change: { workspace?: string }): Site => siteOfWorkspace(workspaceOf(change as never));
// Pure and synchronous: nothing for an Effect to wrap.
export const siteFor = (workspaceId?: string): Site => siteOfWorkspace(workspaceById(workspaceId));

/**
 * The server-wide settings this extension declares, read back with the legacy config fields as
 * the fallback chain's tail: `config.extensionSettings.jira.<key>` — what the settings page
 * writes under `globalSettings` — wins, and when the bag is empty the legacy field answers,
 * which carries the default and the environment resolution (IWE_JIRA_ASSIGNEE and friends beat
 * the file, exactly as they always have). A bag value that is not a string, or an empty one,
 * is not set: empty means unset.
 */
// Pure and synchronous: nothing for an Effect to wrap.
export function globalOf(settings: Config): {
  assignee: string;
  startTransition: string;
  doneTransition: string;
} {
  const bag = settings.extensionSettings?.jira;
  const own = (key: string): string | undefined => {
    const value = bag?.[key];
    return typeof value === "string" && value.trim() ? value : undefined;
  };
  return {
    assignee: own("assignee") ?? settings.jiraAssignee,
    startTransition: own("startTransition") ?? settings.jiraStartTransition,
    doneTransition: own("doneTransition") ?? settings.jiraDoneTransition,
  };
}

/** Namespaces the cache: two sites answering "PROJ-1" differently is exactly the bug this
 * prevents. */
const siteKey = (site: Site): string => site.configFile ?? site.project ?? "default";

/** Which sprints the board view covers. Closed sprints are finished work, so they are excluded
 * by default. Override with IWE_JIRA_SPRINT_STATES (e.g. "active,future,closed"). */
const sprintStates = (): string => process.env.IWE_JIRA_SPRINT_STATES ?? "active,future";

/** Issue types offered for a change. Epics and subtasks are containers, not units of work.
 * Override with IWE_JIRA_ISSUE_TYPES. */
const issueTypes = (): string[] =>
  (process.env.IWE_JIRA_ISSUE_TYPES ?? "Story,Bug")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

/** Issue type used when creating an issue from the wizard. Override with IWE_JIRA_ISSUE_TYPE. */
const issueType = (): string => process.env.IWE_JIRA_ISSUE_TYPE ?? "Story";

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

/** Issues of a JQL query. Paged with `nextPageToken`, which is what the enhanced search uses
 * now that `startAt` is gone; a board is small, so the page size is the limit that matters. */
const searchEffect = (jql: string, site: Site, limit = 100): Effect.Effect<Issue[], BadRequestError> =>
  Effect.gen(function* () {
    const issues: Issue[] = [];
    let token: string | undefined;
    do {
      const page = yield* jiraFetchEffect<SearchJson>("/rest/api/3/search/jql", {
        configFile: site.configFile,
        tokenEnv: site.tokenEnv,
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

const boardEffect = (site: Site): Effect.Effect<string, BadRequestError> =>
  Effect.gen(function* () {
    const id = site.board ?? (yield* jiraSetupEffect(site.configFile)).board;
    if (!id) {
      return yield* Effect.fail(
        new BadRequestError({ message: "no board configured in jira-cli's config — run `jira init`" }),
      );
    }
    return id;
  });

export const listSprintsEffect = (site: Site = {}): Effect.Effect<Sprint[], BadRequestError> =>
  Effect.gen(function* () {
    const json = yield* jiraFetchEffect<{ values?: { id: number; name: string; state: string }[] }>(
      `/rest/agile/1.0/board/${yield* boardEffect(site)}/sprint`,
      { configFile: site.configFile, tokenEnv: site.tokenEnv, query: { state: sprintStates() } },
    );
    return (json.values ?? []).map((s) => ({ id: String(s.id), name: s.name, state: s.state }));
  });


/** The issues of one sprint, named after it: the board view groups by sprint, and the sprint an
 * issue is in is the query that found it. */
const issuesInSprintEffect = (sprint: Sprint, site: Site): Effect.Effect<Issue[], BadRequestError> =>
  Effect.gen(function* () {
    const json = yield* jiraFetchEffect<{ issues?: IssueJson[] }>(
      `/rest/agile/1.0/board/${yield* boardEffect(site)}/sprint/${sprint.id}/issue`,
      { configFile: site.configFile, tokenEnv: site.tokenEnv, query: { fields: FIELDS, maxResults: "100" } },
    );
    return (json.issues ?? []).map((i) => issueFrom(i, sprint.name));
  });

/** Work that is not in a sprint yet, and not finished. */
const backlogIssuesEffect = (site: Site): Effect.Effect<Issue[], BadRequestError> =>
  Effect.gen(function* () {
    const project = site.project ?? (yield* jiraSetupEffect(site.configFile)).project;
    const scope = project ? `project = ${project} AND ` : "";
    return yield* searchEffect(`${scope}sprint is EMPTY AND statusCategory != Done ORDER BY rank`, site);
  });

/** Only what a change can be made from: epics and subtasks are containers, not units of work. */
const workable = (issues: Issue[]): Issue[] => {
  const types = issueTypes();
  return issues.filter((i) => types.includes(i.type.toLowerCase()));
};

/** Everything on the board worth picking: open sprints plus the un-sprinted backlog.
 * Cached briefly; the wizard re-reads this on every visit and a board is not that volatile. */
const boards = new Map<string, { at: number; issues: Issue[] }>();

export const boardIssuesEffect = (
  workspaceId?: string,
  force = false,
): Effect.Effect<{ issues: Issue[]; sprints: string[]; baseUrl?: string; error?: string }> =>
  Effect.gen(function* () {
    const site = siteFor(workspaceId);
    const key = siteKey(site);
    const baseUrl = yield* jiraBaseUrlEffect(site.configFile);
    const cache = boards.get(key);
    if (!force && cache && Date.now() - cache.at < 60_000) {
      return { issues: cache.issues, sprints: sprintNames(cache.issues), baseUrl };
    }
    // An error string rather than a failure: a broken or unconfigured Jira must still leave you
    // able to type a change id by hand.
    return yield* Effect.catchAll(
      Effect.gen(function* () {
        const sprints = yield* listSprintsEffect(site);
        const groups = yield* Effect.all(
          [...sprints.map((sprint) => issuesInSprintEffect(sprint, site)), backlogIssuesEffect(site)],
          // The old Promise.all was unbounded, so this stays unbounded.
          { concurrency: "unbounded" },
        );
        const issues = workable(groups.flat());
        boards.set(key, { at: Date.now(), issues });
        return { issues, sprints: sprintNames(issues), baseUrl };
      }),
      (e) => Effect.succeed({ issues: [], sprints: [], baseUrl, error: messageOf(e) }),
    );
  });


const sprintNames = (issues: Issue[]): string[] => [
  ...new Set(issues.map((i) => i.sprint).filter(Boolean)),
];

/** Plain text as Jira Cloud wants it: v3 takes a document, not a string. One paragraph per line
 * is the whole of what a description typed into a form needs. */
const document = (text: string) => ({
  type: "doc",
  version: 1,
  content: text.split("\n").map((line) => ({
    type: "paragraph",
    content: line ? [{ type: "text", text: line }] : [],
  })),
});

/** Creates an issue and returns it, so the wizard can select what it just made. */
export const createIssueEffect = (input: {
  summary: string;
  description?: string;
  type?: string;
  assignToMe?: boolean;
  /** Which context it belongs to, and therefore which Jira it is created in. */
  workspace?: string;
}): Effect.Effect<Issue, BadRequestError> =>
  Effect.gen(function* () {
    const summary = input.summary.trim();
    if (!summary) {
      return yield* Effect.fail(new BadRequestError({ message: "summary required" }));
    }
    const site = siteFor(input.workspace);
    const project = site.project ?? (yield* jiraSetupEffect(site.configFile)).project;
    if (!project) {
      return yield* Effect.fail(
        new BadRequestError({ message: "no project configured in jira-cli's config — run `jira init`" }),
      );
    }
    const type = input.type ?? issueType();

    const created = yield* jiraFetchEffect<{ key: string }>("/rest/api/3/issue", {
      configFile: site.configFile,
      tokenEnv: site.tokenEnv,
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
      const account = yield* accountIdEffect(globalOf(config).assignee, site);
      if (account) {
        yield* jiraFetchEffect(`/rest/api/3/issue/${created.key}/assignee`, {
          configFile: site.configFile,
          tokenEnv: site.tokenEnv,
          method: "PUT",
          body: { accountId: account },
        });
      }
    }

    boards.delete(siteKey(site)); // the new issue must show up in the table straight away
    return { key: created.key, summary, assignee: "", status: "", type, sprint: "" };
  });


/**
 * Move an issue to another status.
 *
 * Jira transitions by id, not by name, and which ones exist depends on where the issue is now.
 * Asking first is what makes a wrong name a sentence you can act on — "Done is not one of: To
 * Do, In Progress" — rather than a flat refusal, which is how a half-finished change once ended
 * up with its ticket still open.
 */
export const moveIssueEffect = (
  key: string,
  status: string,
  site: Site = {},
): Effect.Effect<void, BadRequestError> =>
  Effect.gen(function* () {
    const { transitions = [] } = yield* jiraFetchEffect<{
      transitions?: { id: string; name: string; to?: { name?: string } }[];
    }>(`/rest/api/3/issue/${key}/transitions`, { configFile: site.configFile });

    const wanted = status.trim().toLowerCase();
    const found = transitions.find(
      (t) => t.name.toLowerCase() === wanted || t.to?.name?.toLowerCase() === wanted,
    );
    if (!found) {
      const names = transitions.map((t) => t.name).join(", ") || "none";
      return yield* Effect.fail(
        new BadRequestError({
          message: `${key}: cannot move to "${status}" from here — available: ${names}`,
        }),
      );
    }

    yield* jiraFetchEffect(`/rest/api/3/issue/${key}/transitions`, {
      configFile: site.configFile,
      tokenEnv: site.tokenEnv,
      method: "POST",
      body: { transition: { id: found.id } },
    });
    boards.delete(siteKey(site));
    invalidate("jira:"); // the status we would otherwise keep showing is the one we just changed
  });

/**
 * Several issues in one query, for the overview: one call for a whole page of changes rather
 * than one per row. An unknown key is simply absent from the result.
 */
export const issuesByKeysEffect = (
  keys: string[],
  site: Site = {},
): Effect.Effect<Map<string, Issue>> =>
  Effect.gen(function* () {
    if (keys.length === 0) return new Map();
    // A ticket's summary and status change a few times a day at most, and the same keys are asked
    // for by the overview on every visit. Keyed by site as well: two of them answer "PROJ-1"
    // differently, and both are right.
    return yield* swrEffect(
      `jira:${siteKey(site)}:keys:${[...keys].sort().join(",")}`,
      ISSUE_TTL,
      Effect.catchAll(
        searchEffect(`key in (${keys.join(",")})`, site, keys.length),
        () => Effect.succeed([] as Issue[]),
      ).pipe(
        Effect.map((issues) => new Map(issues.map((i) => [i.key, i]))),
      ),
    );
  });


/** One issue by key, whatever its type: used for the widget, the status check and descriptions. */
export const issueByKeyEffect = (key: string, site: Site = {}): Effect.Effect<Issue | undefined> =>
  Effect.catchAll(
    Effect.map(
      jiraFetchEffect<IssueJson>(`/rest/api/3/issue/${key}`, {
        configFile: site.configFile,
        tokenEnv: site.tokenEnv,
        query: { fields: FIELDS },
      }),
      issueFrom,
    ),
    () => Effect.succeed(undefined),
  );

