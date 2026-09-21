import { Context, Effect, Option, Schema } from "effect";
import type { Change, CompletionStep } from "../../domain/change.ts";
import type { Widget, WidgetItem, WidgetState } from "../../domain/widget.ts";
import { Cache, Shell, Workspace } from "../../integrations/api/capabilities.ts";
import type { Capabilities } from "../../integrations/api/capabilities.ts";
import type { IncludedIntegration } from "../../integrations/types.ts";
import type { DescriptionSection, TitleSource } from "../../integrations/overview.ts";
import { BadRequestError, type CliError } from "../../capabilities/effect/errors.ts";
import { cliJson } from "../../capabilities/effect/support.ts";
import { refLabel, refOf, KEY, type GitHubIssue, type IssueRef } from "./shared.ts";

/**
 * Task boards for repositories that live on GitHub: issues picked in the wizard, followed on
 * the dashboard, closed when the change completes. Everything runs through `gh`, which holds
 * the credentials — Corvi stores no secrets of its own.
 *
 * Everything this extension asks of the machine goes through the `Shell` capability (so a
 * second client's `gh` is already the right one) and the `Cache` capability (so a dashboard of
 * changes costs a handful of CLI calls). An issue is named by its repository (the source path,
 * recorded when the step picked it) and its number, so the question "which repository is this
 * issue in" is answered from the change record rather than guessed, and a repository without a
 * GitHub remote is told apart from one whose issue lookup failed.
 */

const IssueSchema = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: Schema.String,
  url: Schema.optional(Schema.String),
  assignees: Schema.optional(
    Schema.mutable(Schema.Array(Schema.Struct({ login: Schema.optional(Schema.String) }))),
  ),
  labels: Schema.optional(
    Schema.mutable(Schema.Array(Schema.Struct({ name: Schema.optional(Schema.String) }))),
  ),
});

const flatten = (json: Schema.Schema.Type<typeof IssueSchema>): GitHubIssue => ({
  number: json.number,
  title: json.title,
  state: json.state,
  url: json.url,
  assignees: (json.assignees ?? []).map((a) => a.login ?? "").filter(Boolean),
  labels: (json.labels ?? []).map((l) => l.name ?? "").filter(Boolean),
});

const ISSUE_TTL = 60_000;

/** Owner and name from a git remote URL: the https, ssh and git shapes GitHub answers to, with
 * or without the `.git` suffix. Pure, so the shapes stay testable without a repository. */
// Pure and synchronous: nothing for an Effect to wrap.
export function repoFromRemote(url: string): { owner: string; name: string } | undefined {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)$/.exec(url.trim().replace(/\.git$/, ""));
  return m ? { owner: m[1]!, name: m[2]! } : undefined;
}

/**
 * The GitHub repository a source path pushes to, or undefined when it does not: this
 * extension's honest answer to a repository that is not on GitHub.
 *
 * Asked through the origin URL rather than `gh repo view`, so a repository you have never
 * authenticated against still resolves its name — and a repository with no remote at all
 * fails the same way.
 */
export const nameWithOwner = (
  repo: string,
): Effect.Effect<string | undefined, CliError, Workspace | Shell | Cache> =>
  Effect.gen(function* () {
    const shell = yield* Shell;
    const cache = yield* Cache;
    return yield* cache.swr(
      `gh:issues:nwo:${repo}`,
      300_000,
      Effect.map(
        shell.run(["git", "remote", "get-url", "origin"], { cwd: repo }),
        (r) => {
          if (r.code !== 0) return undefined;
          const found = repoFromRemote(r.stdout);
          return found ? `${found.owner}/${found.name}` : undefined;
        },
      ),
    );
  });

/** The open issues of one repository, newest first; a repository that is not on GitHub has
 * none, and says so by having no repository name. */
export const listIssues = (
  repo: string,
): Effect.Effect<
  { repository?: string; issues: GitHubIssue[] },
  CliError,
  Workspace | Shell | Cache
> =>
  Effect.gen(function* () {
    const shell = yield* Shell;
    const cache = yield* Cache;
    const repository = yield* nameWithOwner(repo);
    if (!repository) return { issues: [] };
    const issues = yield* cache.swr(
      `gh:issues:list:${repository}`,
      ISSUE_TTL,
      Effect.flatMap(
        shell.run(
          [
            "gh", "issue", "list", "-R", repository, "--state", "open", "--limit", "100",
            "--json", "number,title,state,url,assignees,labels",
          ],
          { cwd: repo },
        ),
        (r) =>
          r.code !== 0
            ? Effect.succeed([])
            : cliJson(Schema.Array(IssueSchema), [] as Schema.Schema.Type<typeof IssueSchema>[])(r.stdout),
      ),
    );
    return { repository, issues: issues.map(flatten) };
  });

/** One issue, whatever its state: the card, the title and the description ask here. */
export const viewIssue = (
  repository: string,
  number: number,
): Effect.Effect<GitHubIssue | undefined, CliError, Workspace | Shell | Cache> =>
  Effect.gen(function* () {
    const shell = yield* Shell;
    const cache = yield* Cache;
    const found = yield* cache.swr(
      `gh:issues:issue:${repository}#${number}`,
      ISSUE_TTL,
      Effect.flatMap(
        shell.run(
          [
            "gh", "issue", "view", String(number), "-R", repository,
            "--json", "number,title,state,url,assignees,labels",
          ],
          { cwd: process.cwd() },
        ),
        (r) =>
          r.code !== 0
            ? Effect.succeed(null)
            : cliJson(Schema.NullOr(IssueSchema), null)(r.stdout),
      ),
    );
    return found ? flatten(found) : undefined;
  });

/** Creates an issue and returns it, so the wizard can select what it just made. */
export const createIssue = (
  repo: string,
  title: string,
  body: string | undefined,
): Effect.Effect<
  { repository: string; issue: GitHubIssue },
  BadRequestError | CliError,
  Workspace | Shell | Cache
> =>
  Effect.gen(function* () {
    const shell = yield* Shell;
    const cache = yield* Cache;
    const repository = yield* nameWithOwner(repo);
    if (!repository) {
      return yield* new BadRequestError({ message: `${repo} has no GitHub remote` });
    }
    const args = ["gh", "issue", "create", "-R", repository, "-t", title];
    if (body?.trim()) args.push("-b", body);
    const created = yield* Effect.flatMap(shell.run(args, { cwd: repo }), (r) =>
      r.code !== 0
        ? Effect.fail(new BadRequestError({ message: r.stderr || "gh issue create failed" }))
        : Effect.succeed(r.stdout.trim()));
    // The URL is the last thing gh prints: …/issues/<number>.
    const number = Number(/\/issues\/(\d+)\s*$/.exec(created)?.[1]);
    if (!number) {
      return yield* new BadRequestError({ message: `could not read the new issue's number: ${created}` });
    }
    yield* cache.invalidate(`gh:issues:list:${repository}`);
    const issue =
      (yield* viewIssue(repository, number)) ?? {
        number,
        title,
        state: "open",
        assignees: [],
        labels: [],
      };
    return { repository, issue };
  });

/** Close the issue with a word about where the work landed. */
const closeIssue = (
  shell: Context.Tag.Service<typeof Shell>,
  repository: string,
  number: number,
  comment: string,
): Effect.Effect<void, BadRequestError | CliError, Workspace> =>
  Effect.flatMap(
    shell.run(
      ["gh", "issue", "close", String(number), "-R", repository, "-c", comment],
      { cwd: process.cwd() },
    ),
    (r) =>
      r.code !== 0
        ? Effect.fail(new BadRequestError({ message: r.stderr || "gh issue close failed" }))
        : Effect.void,
  );

const stateOf = (issue: GitHubIssue): WidgetState =>
  issue.state.toLowerCase() === "closed" ? "ok" : "pending";

/** The card: one row, the issue and where it stands. No issue linked reads as none, not as an
 * error — a change may be made without one, and the extension is not the boss of that. */
const statusFor = (
  change: Change,
  ref: IssueRef,
): Effect.Effect<Widget, unknown, Workspace | Shell | Cache> =>
  Effect.gen(function* () {
    const repository = yield* nameWithOwner(ref.repo);
    const found = repository ? yield* viewIssue(repository, ref.number) : undefined;
    if (!repository || !found) {
      return {
        integration: KEY,
        title: "GitHub issues",
        state: "error",
        summary: repository ? `issue not found: #${ref.number}` : "not a GitHub repository",
        items: [],
      };
    }
    const item: WidgetItem = {
      label: `${refLabel(repository, ref)} ${found.title}`,
      detail: [found.state, ...found.assignees, ...found.labels].filter(Boolean).join(" · "),
      url: found.url,
      state: stateOf(found),
    };
    return {
      integration: KEY,
      title: "GitHub issues",
      state: item.state ?? "none",
      summary: found.state,
      items: [item],
    };
  });

/** Closing the issue is a completion step; the plan is pure, the run calls `gh`. */
export const planIssueClose = (change: Change): CompletionStep | undefined => {
  const ref = refOf(change);
  return ref
    ? { id: KEY, label: `close ${ref.repo.split("/").pop()}#${ref.number}`, state: "waiting" }
    : undefined;
};

export const closeIssueOnComplete = (
  change: Change,
): Effect.Effect<string | undefined, BadRequestError | CliError, Capabilities> =>
  Effect.gen(function* () {
    const shell = yield* Shell;
    const cache = yield* Cache;
    const ref = refOf(change);
    if (!ref) return;
    const repository = yield* nameWithOwner(ref.repo);
    if (!repository) return `not a GitHub repository: ${ref.repo}`;
    yield* closeIssue(shell, repository, ref.number, `Completed in change ${change.id}`);
    yield* cache.invalidate(`gh:issues:issue:${repository}#${ref.number}`);
    return `closed ${refLabel(repository, ref)}`;
  });

/** The overview names a change after its issue's title. */
export const githubIssuesTitleSource: TitleSource = {
  applies: (change) => Boolean(refOf(change)),
  lookup: (changes) =>
    Effect.gen(function* () {
      const titles = new Map<string, string>();
      for (const change of changes) {
        const ref = refOf(change);
        if (!ref) continue;
        // A gh that cannot answer leaves the stored title standing: the failure is caught by
        // the consumer, which drops this source's answer as a whole — so per-issue trouble is
        // tolerated here, and only a source-wide failure is a failed lookup.
        const found = yield* Effect.option(nameWithOwner(ref.repo));
        const repository = Option.getOrUndefined(found);
        const issue = repository
          ? Option.getOrUndefined(yield* Effect.option(viewIssue(repository, ref.number)))
          : undefined;
        if (issue?.title) titles.set(change.id, issue.title);
      }
      return titles;
    }),
};

/** The pull-request description opens with the issue and what it is. */
export const githubIssuesDescriptionSection: DescriptionSection = {
  heading: (change) =>
    Effect.gen(function* () {
      const ref = refOf(change);
      if (!ref) return undefined;
      const found = yield* Effect.option(nameWithOwner(ref.repo));
      const repository = Option.getOrUndefined(found);
      if (!repository) return undefined;
      const issue = Option.getOrUndefined(
        yield* Effect.option(viewIssue(repository, ref.number)),
      );
      return `${refLabel(repository, ref)}${issue?.title ? ` - ${issue.title}` : ""}`;
    }),
};

export default {
  name: KEY,
  title: "GitHub issues",

  cards: [
    {
      title: "GitHub issues",
      status: (change) => {
        const ref = refOf(change);
        if (!ref) {
          return Effect.succeed({
            integration: KEY,
            title: "GitHub issues",
            state: "none" as const,
            summary: "no issue linked",
            items: [],
          });
        }
        return statusFor(change, ref);
      },
    },
  ],

  // Runs after the repositories are picked: GitHub issues belong to repositories, so this
  // step has nothing to look at until then.
  wizardSteps: [{ id: KEY, title: "GitHub issue", phase: "repos" }],

  // Completing a change closes the issue, after the merges and before the worktrees go.
  // The two routes the wizard's step fetches: a repository's open issues, and creating one.
  // Their failures are taxonomy errors, so the host maps them to status codes itself.
  routes: [
    {
      method: "GET",
      path: "/issues",
      handler: (req) => {
        const repo = new URL(req.url).searchParams.get("repo") ?? "";
        return Effect.map(listIssues(repo), (listing) => Response.json(listing));
      },
    },
    {
      method: "POST",
      path: "/issues",
      handler: (req) =>
        Effect.gen(function* () {
          const body = yield* Effect.orElseSucceed(
            Effect.tryPromise({
              try: () => req.json() as Promise<{ repo?: string; title?: string; description?: string }>,
              catch: () => undefined,
            }),
            () => ({}) as { repo?: string; title?: string; description?: string },
          );
          if (!body.repo || !body.title?.trim()) {
            return yield* new BadRequestError({ message: "repository and title required" });
          }
          const created = yield* createIssue(body.repo, body.title.trim(), body.description);
          return Response.json(created, { status: 201 });
        }),
    },
  ],
} satisfies IncludedIntegration;
