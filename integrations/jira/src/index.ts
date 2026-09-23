import { Effect, Either } from "effect";
import type { ChangeWireDto as Change, CompletionStepDto as CompletionStep } from "@corvi/contracts/api";
import type { WidgetDto as Widget, WidgetItemDto as WidgetItem, WidgetStateDto as WidgetState } from "@corvi/contracts/api";
import { jiraFetch, siteBaseUrl } from "./jiraHttp.ts";
import { BadRequestError, NotFoundError } from "@corvi/contracts/errors";
import {
  boardIssues,
  siteOfWorkspace,
  siteKey,
  createIssue,
  globalOf,
  issueByKey,
  issuesByKeys,
  issueFrom,
  moveIssue,
  ticketOf,
  type GlobalSettings,
  type IssueJson,
  type Site,
} from "./jira.ts";
import type { ResolvedDto } from "@corvi/contracts/config";
import { accountId } from "./account.ts";
import { JIRA_ENV } from "./legacy.ts";
import { Cache, Settings, Workspace, swr } from "@corvi/contracts/capabilities";
import { Bus, Changes, ExtensionStore } from "@corvi/contracts/capabilities";
import type { Capabilities } from "@corvi/contracts/capabilities";
import type { IncludedIntegration } from "@corvi/contracts/integration";
import type { DescriptionSection, TitleSource } from "@corvi/contracts/integration";

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
 *
 * Which Jira that is, is the settings this extension declares, at two levels: the config root's
 * bag is the default site, and a workspace's own bag overrides it field by field. That is the
 * whole of the extension's configuration — there is no other tool's file to read — and the token
 * is either one typed into this page or an environment variable the site names.
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
const status = (change: Change, site: Site, key: string): Effect.Effect<Widget, never, Cache> =>
  Effect.gen(function* () {
    const found = yield* Effect.either(
      swr(
        `jira:${siteKey(site)}:issue:${key}`,
        ISSUE_TTL,
        Effect.map(
          jiraFetch<IssueJson>(`/rest/api/3/issue/${key}`, {
            site,
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
    const base = siteBaseUrl(site);
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

/** The site, as the settings page renders it: the fields the page edits, worded once — the same
 * declaration renders at both scopes, the global level and every workspace's overrides. The
 * token is the one secret — the server masks it in what it sends and keeps what it holds when
 * the mask comes back (apps/server/src/settings/server/secrets.ts). */
const siteFields = {
  server: {
    key: "server",
    label: "Server",
    placeholder: "https://example.atlassian.net",
    hint: "Which Jira: the site's own address.",
  },
  email: {
    key: "email",
    label: "Account email",
    placeholder: "you@example.com",
    hint: "The Atlassian account the token belongs to — the username half of basic auth.",
  },
  project: {
    key: "project",
    label: "Project",
    placeholder: "PROJ",
    hint: "The project key. Issues are created in it, and its board is found from it.",
  },
  board: {
    key: "board",
    label: "Board",
    placeholder: "169",
    hint: "The board the issue table comes from, by id — only needed when the project has more than one, and the error then names them.",
  },
  token: {
    key: "token",
    label: "API token",
    placeholder: "ATATT…",
    secret: true,
    hint: "Stored in this config file and used instead of the environment's token. Leave the mask to keep it, clear the field to fall back to the variable below.",
  },
  tokenEnv: {
    key: "tokenEnv",
    label: "Token variable",
    placeholder: "JIRA_API_TOKEN",
    hint: "Which environment variable holds this site's token, when none is stored here. Naming one here is how a second client keeps its own token.",
  },
} as const;

/** Starting the work: assign the ticket and move it to the start status. Exported so the start
 * workflow's adapter can call it without the hook registry. */
export const moveIssueOnStart = (change: Change): Effect.Effect<void, BadRequestError, Capabilities> =>
  Effect.gen(function* () {
    const key = ticketOf(change);
    if (!key) return;
    const workspace = yield* Workspace;
    const settings = yield* Settings;
    const global = globalOf(settings, workspace);
    const site = siteOfWorkspace(settings, workspace);
    const account = yield* accountId(global.assignee, site);
    if (account) {
      yield* jiraFetch(`/rest/api/3/issue/${key}/assignee`, {
        site,
        method: "PUT",
        body: { accountId: account },
      });
    }
    const current = (yield* issueByKey(key, site))?.status;
    if (current?.toLowerCase() !== global.startTransition.toLowerCase()) {
      yield* moveIssue(key, global.startTransition, site);
    }
  });

/** Completing closes the ticket: the plan is pure given the config, the run moves it. The
 * transition resolves for the change's own workspace, so the label names what will happen. */
export const planIssueCompletion = (
  change: Change,
  appConfig: GlobalSettings & { workspaces?: ResolvedDto["workspaces"] },
): CompletionStep | undefined => {
  const key = ticketOf(change);
  const workspaces = appConfig.workspaces ?? [];
  const workspace = workspaces.find((one) => one.id === change.workspace) ?? workspaces[0];
  return key
    ? {
        id: "jira",
        label: `move ${key} to ${globalOf(appConfig, workspace).doneTransition}`,
        state: "waiting",
      }
    : undefined;
};

export const moveIssueOnComplete = (change: Change): Effect.Effect<void, BadRequestError, Capabilities> =>
  Effect.gen(function* () {
    const key = ticketOf(change);
    if (!key) return;
    const workspace = yield* Workspace;
    const site = siteOfWorkspace(yield* Settings, workspace);
    const { doneTransition } = globalOf(yield* Settings, workspace);
    yield* moveIssue(key, doneTransition, site);
  });

/** Cancelling leaves the ticket where it is; one line when there is a key. */
export const jiraLooseEnds = (change: Change): readonly string[] => {
  const key = ticketOf(change);
  return key ? [`${key} is still open in Jira`] : [];
};

/** The overview names a change after its ticket's summary. */
export const jiraTitleSource: TitleSource = {
  applies: (change) => Boolean(ticketOf(change)),
  lookup: (changes) =>
    Effect.gen(function* () {
      const site = siteOfWorkspace(yield* Settings, yield* Workspace);
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
};

/** The pull-request description opens with the ticket and what it is. */
export const jiraDescriptionSection: DescriptionSection = {
  heading: (change) =>
    Effect.gen(function* () {
      const key = ticketOf(change);
      if (!key) return undefined;
      const issue = yield* issueByKey(key, siteOfWorkspace(yield* Settings, yield* Workspace));
      return issue?.summary ? `${key} - ${issue.summary}` : key;
    }),
};

export default {
  name: "jira",
  title: "Jira",

  // The default site and the settings that are not about one Jira: every declared setting,
  // at both scopes — a workspace overrides any of them, key by key, and an empty field
  // inherits.
  settings: [
    siteFields.server,
    siteFields.email,
    { ...siteFields.project, placeholder: "PROJ" },
    { ...siteFields.board, placeholder: "found from the project" },
    siteFields.token,
    siteFields.tokenEnv,
    { key: "assignee", label: "Assign new issues to", placeholder: "whoever the token belongs to", env: JIRA_ENV.assignee },
    { key: "startTransition", label: "Transition on starting a change", placeholder: "In Progress", env: JIRA_ENV.startTransition },
    { key: "doneTransition", label: "Transition on completing one", placeholder: "Done", env: JIRA_ENV.doneTransition },
  ],

  cards: [
    {
      title: "Jira",
      // The link can be repointed at another issue: the editor is its client half's `edit`.
      editable: true,
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
          return yield* status(change, siteOfWorkspace(yield* Settings, yield* Workspace), key);
        }),
    },
  ],

  // The wizard's issue step: content in client.tsx, this declaration is what the page is
  // told exists. Its id is the payload key the step writes the picked issue under.
  wizardSteps: [{ id: "jira", title: "Jira", phase: "issue" }],

  // The routes the wizard's step fetches: the board, and creating an issue into it. An
  // error string rather than a failed request, so a broken or unconfigured Jira still leaves
  // you able to type a change id by hand. The third route is the card's editor: the link a
  // change carries, repointed.
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
    {
      // The link, repointed: this extension's bag entry is replaced in one write. What the
      // change's completion later does — the transition, the loose ends — follows this key.
      // A finished change is a record: its completion has already moved its ticket.
      method: "PUT",
      path: "/changes/:id/link",
      handler: (req, params) =>
        Effect.gen(function* () {
          const id = params["id"] ?? "";
          const changes = yield* Changes;
          const change = yield* changes.read(id);
          if (!change) {
            return yield* new NotFoundError({ message: `no such change: ${id}` });
          }
          if (change.completedAt) {
            return yield* new BadRequestError({
              message: "this change is finished: its links are read-only",
            });
          }
          const body = yield* Effect.orElseSucceed(
            Effect.tryPromise({
              try: () => req.json() as Promise<{ key?: string }>,
              catch: () => undefined,
            }),
            () => ({}) as { key?: string },
          );
          const key = body.key?.trim();
          if (!key) {
            return yield* new BadRequestError({ message: "key required" });
          }
          // The bag entry shadows the legacy `jira` field for good (see `ticketOf`). Clearing
          // the link — deliberately not this route — must remove both, or the old key answers.
          const store = yield* ExtensionStore;
          const updated = yield* store.update(change, { key });
          yield* (yield* Bus).announce("changes");
          return Response.json(updated);
        }),
    },
  ],
} satisfies IncludedIntegration;
