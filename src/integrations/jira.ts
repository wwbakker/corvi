import type { Change, Integration, Widget, WidgetItem, WidgetState } from "../types.ts";
import { sh, shOrThrow } from "../sh.ts";
import { config } from "../config.ts";

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

const KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

/** Minimal RFC4180 reader: jira-cli quotes fields containing commas and doubles inner quotes.
 * We read CSV rather than plain mode because plain mode pads columns with the delimiter,
 * which makes column positions unrecoverable. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") (row.push(field), (field = ""));
    else if (c === "\n") (row.push(field), rows.push(row), (row = []), (field = ""));
    else if (c !== "\r") field += c;
  }
  if (field || row.length) (row.push(field), rows.push(row));
  return rows;
}

/** CSV rows of TYPE,KEY,SUMMARY,ASSIGNEE,STATUS into issues, dropping the header, any prose
 * jira-cli printed (auth banners, "no result found") and issue types we do not work on. */
export function parseIssues(stdout: string, sprint = "", filterTypes = true): Issue[] {
  const types = issueTypes();
  return parseCsv(stdout)
    .filter((cols) => cols.length >= 5 && KEY.test(cols[1] ?? ""))
    .map(([type, key, summary, assignee, status]) => ({
      type: type!.trim(),
      key: key!.trim(),
      summary: summary!.trim(),
      assignee: assignee!.trim(),
      status: status!.trim(),
      sprint,
    }))
    .filter((i) => !filterTypes || types.includes(i.type.toLowerCase()));
}

const issueColumns = ["--csv", "--columns", "TYPE,KEY,SUMMARY,ASSIGNEE,STATUS"];

export async function listSprints(): Promise<Sprint[]> {
  const r = await sh([
    "jira",
    "sprint",
    "list",
    "--table",
    "--plain",
    "--no-headers",
    "--columns",
    "ID,NAME,STATE",
    "--state",
    sprintStates(),
  ]);
  return parseSprints(r.stdout);
}

/** `sprint list --table` ignores --csv and pads columns with tabs, so the empty padding fields
 * are dropped: id, name and state are all non-empty. */
export function parseSprints(stdout: string): Sprint[] {
  return stdout
    .split("\n")
    .map((line) => line.split("\t").map((c) => c.trim()).filter(Boolean))
    .filter((cols) => cols.length >= 3 && /^\d+$/.test(cols[0] ?? ""))
    .map(([id, name, state]) => ({ id: id!, name: name!, state: state! }));
}

async function issuesInSprint(sprint: Sprint): Promise<Issue[]> {
  const r = await sh(["jira", "sprint", "list", sprint.id, ...issueColumns]);
  return parseIssues(r.stdout, sprint.name);
}

async function backlogIssues(): Promise<Issue[]> {
  // jira-cli has no SPRINT column, so "no sprint" is a separate query rather than a filter.
  const r = await sh([
    "jira",
    "issue",
    "list",
    "-q",
    "sprint is EMPTY AND statusCategory != Done",
    ...issueColumns,
  ]);
  return parseIssues(r.stdout);
}

/** Everything on the board worth picking: open sprints plus the un-sprinted backlog.
 * Cached briefly; the wizard re-reads this on every visit and a board is not that volatile. */
let cache: { at: number; issues: Issue[] } | null = null;

export async function boardIssues(
  force = false,
): Promise<{ issues: Issue[]; sprints: string[]; baseUrl?: string; error?: string }> {
  const baseUrl = await jiraBaseUrl();
  if (!force && cache && Date.now() - cache.at < 60_000) {
    return { issues: cache.issues, sprints: sprintNames(cache.issues), baseUrl };
  }
  const sprints = await listSprints();
  const groups = await Promise.all([...sprints.map(issuesInSprint), backlogIssues()]);
  const issues = groups.flat();
  if (issues.length === 0) {
    // Nothing parsed at all: far more likely a broken CLI than an empty board.
    const probe = await sh(["jira", "issue", "list", ...issueColumns]);
    return {
      issues,
      sprints: [],
      baseUrl,
      error: probe.code === 0 ? undefined : (probe.stderr || probe.stdout).split("\n")[0],
    };
  }
  cache = { at: Date.now(), issues };
  return { issues, sprints: sprintNames(issues), baseUrl };
}

const sprintNames = (issues: Issue[]): string[] => [
  ...new Set(issues.map((i) => i.sprint).filter(Boolean)),
];

/** Creates an issue and returns it, so the wizard can select what it just made. */
export async function createIssue(input: {
  summary: string;
  description?: string;
  type?: string;
  assignToMe?: boolean;
}): Promise<Issue> {
  const summary = input.summary.trim();
  if (!summary) throw new Error("summary required");
  const args = ["jira", "issue", "create", "--no-input", "-t", input.type ?? issueType(), "-s", summary];
  if (input.description?.trim()) args.push("-b", input.description.trim());
  if (input.assignToMe !== false) {
    // No shell here, so `$(jira me)` would not expand: resolve the account first.
    const account = config.jiraAssignee || (await me());
    if (account) args.push("-a", account);
  }
  const out = await shOrThrow(args);
  const key = KEY.exec(out.split(/\s+/).find((w) => KEY.test(w)) ?? "")?.[0];
  if (!key) throw new Error(`could not read issue key from: ${out}`);
  cache = null; // the new issue must show up in the table straight away
  return { key, summary, assignee: "", status: "", type: input.type ?? issueType(), sprint: "" };
}

/** Move an issue to another status; used by provisioning and by completing a change. */
export async function moveIssue(key: string, status: string): Promise<void> {
  await shOrThrow(["jira", "issue", "move", key, status]);
  cache = null;
}

/** The logged-in Jira account, used when no assignee is configured. */
async function me(): Promise<string> {
  const r = await sh(["jira", "me"]);
  return r.code === 0 ? (r.stdout.split("\n")[0]?.trim() ?? "") : "";
}

/** One issue by key, whatever its type: used for the widget, the status check and descriptions. */
export async function issueByKey(key: string): Promise<Issue | undefined> {
  const r = await sh(["jira", "issue", "list", "-q", `key = ${key}`, ...issueColumns]);
  return parseIssues(r.stdout, "", false)[0];
}

async function currentStatus(key: string): Promise<string | undefined> {
  return (await issueByKey(key))?.status;
}

/** Base URL of the Jira instance, taken from jira-cli's own config so we configure nothing twice. */
export async function jiraBaseUrl(): Promise<string | undefined> {
  const path = process.env.JIRA_CONFIG_FILE ?? `${process.env.HOME}/.config/.jira/.config.yml`;
  const text = await Bun.file(path)
    .text()
    .catch(() => "");
  return /^server:\s*(\S+)/m.exec(text)?.[1]?.replace(/\/$/, "");
}

async function browseUrl(key: string): Promise<string | undefined> {
  const base = await jiraBaseUrl();
  return base ? `${base}/browse/${key}` : undefined;
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
    const r = await sh(["jira", "issue", "list", "-q", `key = ${change.jira}`, ...issueColumns]);
    const issue = parseIssues(r.stdout, "", false)[0];
    if (!issue) {
      return {
        integration: "jira",
        title: jira.title,
        state: "error",
        summary: (r.stderr || r.stdout).split("\n")[0] ?? `issue not found: ${change.jira}`,
        items: [],
      };
    }
    const item: WidgetItem = {
      label: `${issue.key} ${issue.summary}`,
      detail: [issue.status, issue.assignee].filter(Boolean).join(" · "),
      url: await browseUrl(issue.key),
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
    const assignee = config.jiraAssignee || (await me());
    if (assignee) await shOrThrow(["jira", "issue", "assign", change.jira, assignee]);
    const current = await currentStatus(change.jira);
    if (current?.toLowerCase() !== config.jiraStartTransition.toLowerCase()) {
      await moveIssue(change.jira, config.jiraStartTransition);
    }
  },

  /** No transition buttons: In Progress is set on creation, and Done belongs to completing the
   * whole change (merge the PR, close the ticket). Kept callable for that upcoming step. */
  async run(change: Change, action: string, arg?: string): Promise<void> {
    if (action !== "move") throw new Error(`unknown jira action: ${action}`);
    if (!change.jira) throw new Error("change has no jira issue");
    if (!arg) throw new Error("target status required");
    await moveIssue(change.jira, arg);
  },
};
