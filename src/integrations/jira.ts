import type { Change, Integration, Widget, WidgetItem, WidgetState } from "../types.ts";
import { swr, invalidate } from "../cache.ts";
import { config } from "../config.ts";
import { jiraFetch, jiraSetup, jiraBaseUrl } from "./jiraHttp.ts";
import { jiraOf, workspaceById, workspaceOf } from "../workspaces.ts";

export { jiraBaseUrl };

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

export const siteOf = (change: { workspace?: string }): Site => jiraOf(workspaceOf(change as never));
export const siteFor = (workspaceId?: string): Site => jiraOf(workspaceById(workspaceId));

/** Namespaces the cache: two sites answering "PROJ-1" differently is exactly the bug this
 * prevents. */
const siteKey = (site: Site): string => site.configFile ?? site.project ?? "default";

export type Issue = {
  key: string;
  summary: string;
  assignee: string;
  status: string;
  type: string;
  /** Sprint name, or "" for issues in no sprint (backlog). */
  sprint: string;
};

export type Sprint = { id: string; name: string; state: string };

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
type IssueJson = {
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
async function search(jql: string, site: Site, limit = 100): Promise<Issue[]> {
  const issues: Issue[] = [];
  let token: string | undefined;
  do {
    const page = await jiraFetch<SearchJson>("/rest/api/3/search/jql", {
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
}

const board = async (site: Site): Promise<string> => {
  const id = site.board ?? (await jiraSetup(site.configFile)).board;
  if (!id) throw new Error("no board configured in jira-cli's config — run `jira init`");
  return id;
};

export async function listSprints(site: Site = {}): Promise<Sprint[]> {
  const json = await jiraFetch<{ values?: { id: number; name: string; state: string }[] }>(
    `/rest/agile/1.0/board/${await board(site)}/sprint`,
    { configFile: site.configFile,
    tokenEnv: site.tokenEnv, query: { state: sprintStates() } },
  );
  return (json.values ?? []).map((s) => ({ id: String(s.id), name: s.name, state: s.state }));
}

/** The issues of one sprint, named after it: the board view groups by sprint, and the sprint an
 * issue is in is the query that found it. */
async function issuesInSprint(sprint: Sprint, site: Site): Promise<Issue[]> {
  const json = await jiraFetch<{ issues?: IssueJson[] }>(
    `/rest/agile/1.0/board/${await board(site)}/sprint/${sprint.id}/issue`,
    { configFile: site.configFile,
    tokenEnv: site.tokenEnv, query: { fields: FIELDS, maxResults: "100" } },
  );
  return (json.issues ?? []).map((i) => issueFrom(i, sprint.name));
}

/** Work that is not in a sprint yet, and not finished. */
async function backlogIssues(site: Site): Promise<Issue[]> {
  const project = site.project ?? (await jiraSetup(site.configFile)).project;
  const scope = project ? `project = ${project} AND ` : "";
  return search(`${scope}sprint is EMPTY AND statusCategory != Done ORDER BY rank`, site);
}

/** Only what a change can be made from: epics and subtasks are containers, not units of work. */
const workable = (issues: Issue[]): Issue[] => {
  const types = issueTypes();
  return issues.filter((i) => types.includes(i.type.toLowerCase()));
};

/** Everything on the board worth picking: open sprints plus the un-sprinted backlog.
 * Cached briefly; the wizard re-reads this on every visit and a board is not that volatile. */
const boards = new Map<string, { at: number; issues: Issue[] }>();

export async function boardIssues(
  workspaceId?: string,
  force = false,
): Promise<{ issues: Issue[]; sprints: string[]; baseUrl?: string; error?: string }> {
  const site = siteFor(workspaceId);
  const key = siteKey(site);
  const baseUrl = await jiraBaseUrl(site.configFile);
  const cache = boards.get(key);
  if (!force && cache && Date.now() - cache.at < 60_000) {
    return { issues: cache.issues, sprints: sprintNames(cache.issues), baseUrl };
  }
  try {
    const sprints = await listSprints(site);
    const groups = await Promise.all([
      ...sprints.map((sprint) => issuesInSprint(sprint, site)),
      backlogIssues(site),
    ]);
    const issues = workable(groups.flat());
    boards.set(key, { at: Date.now(), issues });
    return { issues, sprints: sprintNames(issues), baseUrl };
  } catch (e) {
    // An error string rather than a failure: a broken or unconfigured Jira must still leave you
    // able to type a change id by hand.
    return { issues: [], sprints: [], baseUrl, error: e instanceof Error ? e.message : String(e) };
  }
}

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
export async function createIssue(input: {
  summary: string;
  description?: string;
  type?: string;
  assignToMe?: boolean;
  /** Which context it belongs to, and therefore which Jira it is created in. */
  workspace?: string;
}): Promise<Issue> {
  const summary = input.summary.trim();
  if (!summary) throw new Error("summary required");
  const site = siteFor(input.workspace);
  const project = site.project ?? (await jiraSetup(site.configFile)).project;
  if (!project) throw new Error("no project configured in jira-cli's config — run `jira init`");
  const type = input.type ?? issueType();

  const created = await jiraFetch<{ key: string }>("/rest/api/3/issue", {
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
    const account = await accountId(config.jiraAssignee, site);
    if (account) {
      await jiraFetch(`/rest/api/3/issue/${created.key}/assignee`, {
        configFile: site.configFile,
    tokenEnv: site.tokenEnv,
        method: "PUT",
        body: { accountId: account },
      });
    }
  }

  boards.delete(siteKey(site)); // the new issue must show up in the table straight away
  return { key: created.key, summary, assignee: "", status: "", type, sprint: "" };
}

/**
 * Move an issue to another status.
 *
 * Jira transitions by id, not by name, and which ones exist depends on where the issue is now.
 * Asking first is what makes a wrong name a sentence you can act on — "Done is not one of: To
 * Do, In Progress" — rather than a flat refusal, which is how a half-finished change once ended
 * up with its ticket still open.
 */
export async function moveIssue(key: string, status: string, site: Site = {}): Promise<void> {
  const { transitions = [] } = await jiraFetch<{
    transitions?: { id: string; name: string; to?: { name?: string } }[];
  }>(`/rest/api/3/issue/${key}/transitions`, { configFile: site.configFile });

  const wanted = status.trim().toLowerCase();
  const found = transitions.find(
    (t) => t.name.toLowerCase() === wanted || t.to?.name?.toLowerCase() === wanted,
  );
  if (!found) {
    const names = transitions.map((t) => t.name).join(", ") || "none";
    throw new Error(`${key}: cannot move to "${status}" from here — available: ${names}`);
  }

  await jiraFetch(`/rest/api/3/issue/${key}/transitions`, {
    configFile: site.configFile,
    tokenEnv: site.tokenEnv,
    method: "POST",
    body: { transition: { id: found.id } },
  });
  boards.delete(siteKey(site));
  invalidate("jira:"); // the status we would otherwise keep showing is the one we just changed
}

/** The account to assign to: whatever is configured, or the one the token belongs to. A name is
 * not enough — Jira wants an account id — so a configured assignee is looked up. */
async function accountId(configured: string, site: Site): Promise<string | undefined> {
  if (!configured.trim()) {
    return (
      await jiraFetch<{ accountId?: string }>("/rest/api/3/myself", {
        configFile: site.configFile,
    tokenEnv: site.tokenEnv,
      })
    ).accountId;
  }
  // Already an account id: Atlassian's are opaque strings, and a name never looks like one.
  if (!configured.includes("@") && !configured.includes(" ")) return configured;
  const found = await jiraFetch<{ accountId?: string; displayName?: string }[]>(
    "/rest/api/3/user/search",
    { configFile: site.configFile,
    tokenEnv: site.tokenEnv, query: { query: configured } },
  );
  return found[0]?.accountId;
}

/**
 * Several issues in one query, for the overview: one call for a whole page of changes rather
 * than one per row. An unknown key is simply absent from the result.
 */
export async function issuesByKeys(keys: string[], site: Site = {}): Promise<Map<string, Issue>> {
  if (keys.length === 0) return new Map();
  // A ticket's summary and status change a few times a day at most, and the same keys are asked
  // for by the overview on every visit. Keyed by site as well: two of them answer "PROJ-1"
  // differently, and both are right.
  return swr(`jira:${siteKey(site)}:keys:${[...keys].sort().join(",")}`, ISSUE_TTL, async () => {
    const issues = await search(`key in (${keys.join(",")})`, site, keys.length).catch(() => []);
    return new Map(issues.map((i) => [i.key, i]));
  });
}

/** One issue by key, whatever its type: used for the widget, the status check and descriptions. */
export async function issueByKey(key: string, site: Site = {}): Promise<Issue | undefined> {
  const json = await jiraFetch<IssueJson>(`/rest/api/3/issue/${key}`, {
    configFile: site.configFile,
    tokenEnv: site.tokenEnv,
    query: { fields: FIELDS },
  }).catch(() => undefined);
  return json && issueFrom(json);
}

const stateOf = (status: string): WidgetState => {
  const s = status.toLowerCase();
  if (s.includes("done") || s.includes("closed") || s.includes("resolved")) return "ok";
  if (s.includes("progress") || s.includes("review")) return "pending";
  return "none";
};

export const jira: Integration = {
  name: "jira",
  title: "Jira",

  async status(change: Change): Promise<Widget> {
    if (!change.jira) {
      return {
        integration: "jira",
        title: jira.title,
        state: "none",
        summary: "no issue linked",
        items: [],
      };
    }
    // The widget is a display, so it may be a minute old; the transition check below is not.
    // A failure here is a red card rather than a thrown request: the rest of the page is fine.
    const site = siteOf(change);
    let issue: Issue;
    try {
      issue = await swr(`jira:${siteKey(site)}:issue:${change.jira}`, ISSUE_TTL, async () =>
        issueFrom(
          await jiraFetch<IssueJson>(`/rest/api/3/issue/${change.jira}`, {
            configFile: site.configFile,
    tokenEnv: site.tokenEnv,
            query: { fields: FIELDS },
          }),
        ),
      );
    } catch (e) {
      return {
        integration: "jira",
        title: jira.title,
        state: "error",
        summary: e instanceof Error ? e.message : `issue not found: ${change.jira}`,
        items: [],
      };
    }
    const base = await jiraBaseUrl(site.configFile);
    const item: WidgetItem = {
      label: `${issue.key} ${issue.summary}`,
      detail: [issue.status, issue.assignee].filter(Boolean).join(" · "),
      url: base ? `${base}/browse/${issue.key}` : undefined,
      state: stateOf(issue.status),
    };
    return {
      integration: "jira",
      title: jira.title,
      state: item.state ?? "none",
      summary: issue.status,
      items: [item],
    };
  },

  /** A new change means the ticket is being worked on: assign it and move it to the start status. */
  async provision(change: Change): Promise<void> {
    if (!change.jira) return;
    const site = siteOf(change);
    const account = await accountId(config.jiraAssignee, site);
    if (account) {
      await jiraFetch(`/rest/api/3/issue/${change.jira}/assignee`, {
        configFile: site.configFile,
    tokenEnv: site.tokenEnv,
        method: "PUT",
        body: { accountId: account },
      });
    }
    const current = (await issueByKey(change.jira, site))?.status;
    if (current?.toLowerCase() !== config.jiraStartTransition.toLowerCase()) {
      await moveIssue(change.jira, config.jiraStartTransition, site);
    }
  },

  /** No transition buttons: In Progress is set on creation, and Done belongs to completing the
   * whole change (merge the PR, close the ticket). Kept callable for that upcoming step. */
  async run(change: Change, action: string, arg?: string): Promise<void> {
    if (action !== "move") throw new Error(`unknown jira action: ${action}`);
    if (!change.jira) throw new Error("change has no jira issue");
    if (!arg) throw new Error("target status required");
    await moveIssue(change.jira, arg, siteOf(change));
  },
};
