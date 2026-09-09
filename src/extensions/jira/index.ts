import { Effect, Either } from "effect";
import type { Change, CompletionStep, Integration, Widget, WidgetItem, WidgetState } from "../../types.ts";
import { config } from "../../config.ts";
import { jiraOf, workspaceOf } from "../../workspaces.ts";
import { swrEffect } from "../../cache.ts";
import { jiraFetchEffect, jiraBaseUrlEffect } from "./jiraHttp.ts";
import {
  boardIssuesEffect,
  createIssueEffect,
  issueByKeyEffect,
  issuesByKeysEffect,
  issueFrom,
  moveIssueEffect,
  siteOf,
  type IssueJson,
  type Site,
} from "./jira.ts";
import { accountIdEffect } from "./account.ts";
import { ticketOf } from "./shared.ts";
import type { IweExtensionApi } from "../api.ts";

/**
 * The jira extension: the pilot migration out of the core.
 *
 * Everything it does is contributed, nothing assumed: a dashboard card, the wizard's issue step
 * (declared here, rendered by its client component), provisioning a new change's ticket, a
 * title source, a pull-request description section, the completion step that closes the ticket,
 * and the two routes its step fetches from. The change's ticket key is read through
 * `ticketOf` — the `extensions` bag where its step now writes, or `change.jira` where it used
 * to, which is what every change recorded before extensions existed still carries.
 */

/** Jira is the slowest of the sources and the least volatile. */
const ISSUE_TTL = 60_000;

const stateOf = (status: string): WidgetState => {
  const s = status.toLowerCase();
  if (s.includes("done") || s.includes("closed") || s.includes("resolved")) return "ok";
  if (s.includes("progress") || s.includes("review")) return "pending";
  return "none";
};

/** The widget, in Effect: a failure is a red card rather than a thrown request. */
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

/** The card. No transition buttons: In Progress is set on creation, and Done belongs to
 * completing the whole change (merge the PR, close the ticket). */
const card: Integration = {
  name: "jira",
  title: "Jira",

  async status(change: Change): Promise<Widget> {
    const key = ticketOf(change);
    if (!key) {
      return {
        integration: "jira",
        title: "Jira",
        state: "none",
        summary: "no issue linked",
        items: [],
      };
    }
    // The widget is a display, so it may be a minute old; the completion step is not.
    return await Effect.runPromise(statusEffect(change, siteOf(change), key));
  },
};

export default function (api: IweExtensionApi) {
  api.registerCard(card);

  // The wizard's issue step: content in client.tsx, this is the declaration the page is told
  // about. Its id is the payload key the step writes the picked issue under.
  api.registerWizardStep({ id: "jira", title: "Jira", phase: "issue" });

  // A new change means the ticket is being worked on: assign it and move it to the start
  // status. One hook, reported to the wizard under this extension's name.
  api.on("change:created", async (change) => {
    const key = ticketOf(change);
    if (!key) return;
    const site = jiraOf(workspaceOf(change));
    const account = await Effect.runPromise(accountIdEffect(config.jiraAssignee, site));
    if (account) {
      await Effect.runPromise(
        jiraFetchEffect(`/rest/api/3/issue/${key}/assignee`, {
          configFile: site.configFile,
          tokenEnv: site.tokenEnv,
          method: "PUT",
          body: { accountId: account },
        }),
      );
    }
    const current = (await Effect.runPromise(issueByKeyEffect(key, site)))?.status;
    if (current?.toLowerCase() !== config.jiraStartTransition.toLowerCase()) {
      await Effect.runPromise(moveIssueEffect(key, config.jiraStartTransition, site));
    }
  });

  // The overview names a change after its ticket's summary.
  api.registerTitleSource({
    applies: (change) => Boolean(ticketOf(change)),
    lookup: async (changes, ctx) => {
      const site = jiraOf(ctx.workspace);
      const keys = [...new Set(changes.map((c) => ticketOf(c)).filter((k): k is string => Boolean(k)))];
      const issues = await Effect.runPromise(issuesByKeysEffect(keys, site));
      const titles = new Map<string, string>();
      for (const change of changes) {
        const key = ticketOf(change);
        const summary = key && issues.get(key)?.summary;
        if (summary) titles.set(change.id, summary);
      }
      return titles;
    },
  });

  // The pull-request description opens with the ticket and what it is.
  api.registerDescriptionSection({
    heading: async (change) => {
      const key = ticketOf(change);
      if (!key) return undefined;
      const issue = await Effect.runPromise(issueByKeyEffect(key, siteOf(change)));
      return issue?.summary ? `${key} - ${issue.summary}` : key;
    },
  });

  // Completing a change closes the ticket, after the merges and before the worktrees go.
  api.registerCompletionStep({
    plan: (change): CompletionStep | undefined => {
      const key = ticketOf(change);
      return key
        ? { id: "jira", label: `move ${key} to ${config.jiraDoneTransition}`, state: "waiting" }
        : undefined;
    },
    run: async (change) => {
      const key = ticketOf(change);
      if (!key) return;
      await Effect.runPromise(moveIssueEffect(key, config.jiraDoneTransition, siteOf(change)));
    },
  });

  // The two routes the wizard's step fetches: the board, and creating an issue into it. An
  // error string rather than a failed request, so a broken or unconfigured Jira still leaves
  // you able to type a change id by hand.
  api.route("GET", "/issues", async (req) => {
    const url = new URL(req.url);
    const workspace = url.searchParams.get("workspace") ?? undefined;
    const board = await Effect.runPromise(boardIssuesEffect(workspace, url.searchParams.has("refresh")));
    return Response.json(board);
  });
  api.route("POST", "/issues", async (req) => {
    const body = (await req.json().catch(() => ({}))) as {
      summary?: string;
      description?: string;
      workspace?: string;
    };
    const issue = await Effect.runPromise(
      createIssueEffect({
        summary: body.summary ?? "",
        description: body.description,
        workspace: body.workspace,
      }),
    );
    return Response.json(issue, { status: 201 });
  });
}
