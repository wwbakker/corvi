import { Effect, Either } from "effect";
import type { Change, CompletionStep, Widget, WidgetItem, WidgetState } from "../../types.ts";
import { swrEffect } from "../../cache.ts";
import { jiraFetchEffect, jiraBaseUrlEffect } from "./jiraHttp.ts";
import {
  boardIssuesEffect,
  siteOfWorkspace,
  createIssueEffect,
  issueByKeyEffect,
  issuesByKeysEffect,
  issueFrom,
  moveIssueEffect,
  type IssueJson,
  type Site,
} from "./jira.ts";
import { accountIdEffect } from "./account.ts";
import { ticketOf } from "./shared.ts";
import { Settings, Workspace, type Extension } from "../api.ts";

/**
 * The jira extension: the pilot migration out of the core, now as a self-describing value.
 *
 * Everything it does is contributed, nothing assumed: a dashboard card, the wizard's issue
 * step (declared here, rendered by its client component), provisioning a new change's ticket,
 * a title source, a pull-request description section, the completion step that closes the
 * ticket, and the two routes its step fetches from. The change's ticket key is read through
 * `ticketOf` — the `extensions` bag where its step now writes, or `change.jira` where it used
 * to, which is what every change recorded before extensions existed still carries.
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

/** The widget, in Effect: a failure is a red card rather than a failed request. */
const statusEffect = (change: Change, site: Site, key: string): Effect.Effect<Widget> =>
  Effect.gen(function* () {
    const found = yield* Effect.either(
      swrEffect(
        `jira:${site.configFile ?? site.project ?? "default"}:issue:${key}`,
        ISSUE_TTL,
        Effect.map(
          jiraFetchEffect<IssueJson>(`/rest/api/3/issue/${key}`, {
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
    const base = yield* jiraBaseUrlEffect(site.configFile);
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
          return yield* statusEffect(change, siteOfWorkspace(yield* Workspace), key);
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
          const site = siteOfWorkspace(workspace);
          const account = yield* accountIdEffect(settings.jiraAssignee, site);
          if (account) {
            yield* jiraFetchEffect(`/rest/api/3/issue/${key}/assignee`, {
              configFile: site.configFile,
              tokenEnv: site.tokenEnv,
              method: "PUT",
              body: { accountId: account },
            });
          }
          const current = (yield* issueByKeyEffect(key, site))?.status;
          if (current?.toLowerCase() !== settings.jiraStartTransition.toLowerCase()) {
            yield* moveIssueEffect(key, settings.jiraStartTransition, site);
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
          const issues = yield* issuesByKeysEffect(keys, site);
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
          const issue = yield* issueByKeyEffect(key, siteOfWorkspace(yield* Workspace));
          return issue?.summary ? `${key} - ${issue.summary}` : key;
        }),
    },
  ],

  // Completing a change closes the ticket, after the merges and before the worktrees go.
  completionSteps: [
    {
      plan: (change, world): CompletionStep | undefined => {
        const key = ticketOf(change);
        return key
          ? { id: "jira", label: `move ${key} to ${world.config.jiraDoneTransition}`, state: "waiting" }
          : undefined;
      },
      run: (change) =>
        Effect.gen(function* () {
          const key = ticketOf(change);
          if (!key) return;
          const site = siteOfWorkspace(yield* Workspace);
          yield* moveIssueEffect(key, (yield* Settings).jiraDoneTransition, site);
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
          boardIssuesEffect(
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
          const issue = yield* createIssueEffect({
            summary: body.summary,
            description: body.description,
            workspace: body.workspace,
          });
          return Response.json(issue, { status: 201 });
        }),
    },
  ],
} satisfies Extension;
