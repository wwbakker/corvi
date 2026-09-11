import { Effect, Either } from "effect";
import type { Change, CompletionStep } from "../../core/domain/change.ts";
import type { Widget, WidgetItem, WidgetState } from "../../core/domain/widget.ts";
import { swr } from "../../core/platform/capabilities/cache.ts";
import { jiraFetch, jiraBaseUrl } from "./jiraHttp.ts";
import {
  boardIssues,
  siteOfWorkspace,
  createIssue,
  globalOf,
  issueByKey,
  issuesByKeys,
  issueFrom,
  moveIssue,
  ticketOf,
  type IssueJson,
  type Site,
} from "./jira.ts";
import { accountId } from "./account.ts";
import { JIRA_ENV } from "./legacy.ts";
import { Settings, Workspace, type Extension } from "../../core/host/api.ts";

/**
 * The jira extension: a self-describing value.
 *
 * Everything it does is contributed, nothing assumed: a dashboard card, the wizard's issue
 * step (declared here, rendered by its client component), provisioning a new change's ticket,
 * a title source, a pull-request description section, the completion step that closes the
 * ticket, and the two routes its step fetches from. The change's ticket key is read through
 * `ticketOf` — the `extensions` bag its step writes, or the legacy `jira` field an early
 * change record still carries, read in `legacy.ts`.
 *
 * Its effects require nothing beyond the capabilities: `Workspace` for whose Jira a change's
 * ticket belongs to, `Settings` for the assignee and the transitions.
 */

/** Jira is the slowest of the sources and the least volatile. */
const ISSUE_TTL = 60_000;

const stateOf = (status: string): WidgetState => {
  const s = status.toLowerCase();
  if (s.includes("done") || s.includes("closed") || s.includes("resolved")) return "ok";
  if (s.includes("progress") || s.includes("review")) return "pending";
  return "none";
};

/** The widget: a failure is a red card rather than a failed request. */
const status = (change: Change, site: Site, key: string): Effect.Effect<Widget> =>
  Effect.gen(function* () {
    const found = yield* Effect.either(
      swr(
        `jira:${site.configFile ?? site.project ?? "default"}:issue:${key}`,
        ISSUE_TTL,
        Effect.map(
          jiraFetch<IssueJson>(`/rest/api/3/issue/${key}`, {
            configFile: site.configFile,
            tokenEnv: site.tokenEnv,
            query: { fields: "summary,status,assignee,issuetype" },
          }),
          issueFrom,
        ),
      ),
    );
    if (Either.isLeft(found)) {
      const e = found.left;
      return {
        integration: "jira",
        title: "Jira",
        state: "error",
        summary: e instanceof Error ? e.message : `issue not found: ${key}`,
        items: [],
      };
    }
    const issue = found.right;
    const base = yield* jiraBaseUrl(site.configFile);
    const item: WidgetItem = {
      label: `${issue.key} ${issue.summary}`,
      detail: [issue.status, issue.assignee].filter(Boolean).join(" · "),
      url: base ? `${base}/browse/${issue.key}` : undefined,
      state: stateOf(issue.status),
    };
    return {
      integration: "jira",
      title: "Jira",
      state: item.state ?? "none",
      summary: issue.status,
      items: [item],
    };
  });

export default {
  name: "jira",
  title: "Jira",

  // The per-workspace settings this extension owns, rendered by the settings page for every
  // workspace that has Jira enabled and stored under `extensionSettings.jira` — where
  // siteOfWorkspace reads them back. Every field optional; absent means jira-cli's own config.
  workspaceSettings: [
    { key: "project", label: "Project", placeholder: "from the Jira config file" },
    { key: "board", label: "Board", placeholder: "from the Jira config file" },
    {
      key: "configFile",
      label: "Jira config file",
      hint: "A second client is a second site and a second account: jira init into another file.",
      placeholder: "~/.config/.jira/.config.yml",
    },
    { key: "tokenEnv", label: "Token variable", placeholder: "JIRA_API_TOKEN" },
  ],

  // The server-wide settings this extension declares, shown on the settings page for every
  // workspace and stored under `extensionSettings.jira` — where globalOf reads them back, with
  // the core's legacy flat `jira*` fields (through legacy.ts) as the fallback. An environment
  // variable keeps beating the page: the field shows locked when IWE_JIRA_* is set.
  globalSettings: [
    { key: "assignee", label: "Assign new issues to", placeholder: "whoever the token belongs to", env: JIRA_ENV.assignee },
    { key: "startTransition", label: "Transition on starting a change", placeholder: "In Progress", env: JIRA_ENV.startTransition },
    { key: "doneTransition", label: "Transition on completing one", placeholder: "Done", env: JIRA_ENV.doneTransition },
  ],

  cards: [
    {
      title: "Jira",
      status: (change) =>
        Effect.gen(function* () {
          const key = ticketOf(change);
          if (!key) {
            return {
              integration: "jira",
              title: "Jira",
              state: "none" as const,
              summary: "no issue linked",
              items: [],
            };
          }
          // The widget is a display, so it may be a minute old; the completion step is not.
          return yield* status(change, siteOfWorkspace(yield* Workspace), key);
        }),
    },
  ],

  // The wizard's issue step: content in client.tsx, this declaration is what the page is
  // told exists. Its id is the payload key the step writes the picked issue under.
  wizardSteps: [{ id: "jira", title: "Jira", phase: "issue" }],

  events: {
    // A new change means the ticket is being worked on: assign it and move it to the start
    // status. One hook, reported to the wizard under this extension's name.
    "change:created": [
      (change) =>
        Effect.gen(function* () {
          const key = ticketOf(change);
          if (!key) return;
          const workspace = yield* Workspace;
          const settings = yield* Settings;
          const global = globalOf(settings);
          const site = siteOfWorkspace(workspace);
          const account = yield* accountId(global.assignee, site);
          if (account) {
            yield* jiraFetch(`/rest/api/3/issue/${key}/assignee`, {
              configFile: site.configFile,
              tokenEnv: site.tokenEnv,
              method: "PUT",
              body: { accountId: account },
            });
          }
          const current = (yield* issueByKey(key, site))?.status;
          if (current?.toLowerCase() !== global.startTransition.toLowerCase()) {
            yield* moveIssue(key, global.startTransition, site);
          }
        }),
    ],
  },

  // The overview names a change after its ticket's summary.
  titleSources: [
    {
      applies: (change) => Boolean(ticketOf(change)),
      lookup: (changes) =>
        Effect.gen(function* () {
          const site = siteOfWorkspace(yield* Workspace);
          const keys = [
            ...new Set(changes.map((c) => ticketOf(c)).filter((k): k is string => Boolean(k))),
          ];
          const issues = yield* issuesByKeys(keys, site);
          const titles = new Map<string, string>();
          for (const change of changes) {
            const key = ticketOf(change);
            const summary = key && issues.get(key)?.summary;
            if (summary) titles.set(change.id, summary);
          }
          return titles;
        }),
    },
  ],

  // The pull-request description opens with the ticket and what it is.
  descriptionSections: [
    {
      heading: (change) =>
        Effect.gen(function* () {
          const key = ticketOf(change);
          if (!key) return undefined;
          const issue = yield* issueByKey(key, siteOfWorkspace(yield* Workspace));
          return issue?.summary ? `${key} - ${issue.summary}` : key;
        }),
    },
  ],

  // Cancelling leaves the ticket where it is — moving a ticket other people are watching is
  // a decision about theirs — and says so, so you can go and deal with it.
  looseEnds: [
    {
      looseEnds: (change) => {
        const key = ticketOf(change);
        return Effect.succeed(key ? [`${key} is still open in Jira`] : []);
      },
    },
  ],

  // Completing a change closes the ticket, after the merges and before the worktrees go.
  completionSteps: [
    {
      plan: (change, world): CompletionStep | undefined => {
        const key = ticketOf(change);
        return key
          ? { id: "jira", label: `move ${key} to ${globalOf(world.config).doneTransition}`, state: "waiting" }
          : undefined;
      },
      run: (change) =>
        Effect.gen(function* () {
          const key = ticketOf(change);
          if (!key) return;
          const site = siteOfWorkspace(yield* Workspace);
          const { doneTransition } = globalOf(yield* Settings);
          yield* moveIssue(key, doneTransition, site);
        }),
    },
  ],

  // The two routes the wizard's step fetches: the board, and creating an issue into it. An
  // error string rather than a failed request, so a broken or unconfigured Jira still leaves
  // you able to type a change id by hand.
  routes: [
    {
      method: "GET",
      path: "/issues",
      handler: (req) => {
        const url = new URL(req.url);
        return Effect.map(
          boardIssues(
            url.searchParams.get("workspace") ?? undefined,
            url.searchParams.has("refresh"),
          ),
          (board) => Response.json(board),
        );
      },
    },
    {
      method: "POST",
      path: "/issues",
      handler: (req) =>
        Effect.gen(function* () {
          const body = yield* Effect.orElseSucceed(
            Effect.tryPromise({
              try: () =>
                req.json() as Promise<{ summary?: string; description?: string; workspace?: string }>,
              catch: () => undefined,
            }),
            () => ({}) as { summary?: string; description?: string; workspace?: string },
          );
          if (!body.summary?.trim()) {
            return Response.json({ error: "summary required" }, { status: 400 });
          }
          const issue = yield* createIssue({
            summary: body.summary,
            description: body.description,
            workspace: body.workspace,
          });
          return Response.json(issue, { status: 201 });
        }),
    },
  ],
} satisfies Extension;
