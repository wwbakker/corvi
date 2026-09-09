import { Effect } from "effect";
import { Schema } from "effect";
import type { Change, CompletionStep, Integration, Widget, WidgetItem, WidgetState } from "../../types.ts";
import { shEffect, type Result } from "../../sh.ts";
import { swrEffect, invalidate } from "../../cache.ts";
import { refLabel, refOf, KEY, type GitHubIssue, type IssueRef } from "./shared.ts";
import type { ChangeContext, IweExtensionApi } from "../api.ts";

/**
 * Task boards for repositories that live on GitHub: issues picked in the wizard, followed on
 * the dashboard, closed when the change completes. Everything runs through `gh`, which holds
 * the credentials — IWE stores no secrets of its own.
 *
 * An issue is named by its repository (the source path, recorded when the step picked it) and
 * its number, so the question "which repository is this issue in" is answered from the change
 * record rather than guessed, and a repository without a GitHub remote is told apart from one
 * whose issue lookup failed.
 */

/** The Result-branching contract of the old sh(), kept: non-zero exits are data — a gh that
 * found nothing, a repository gh cannot see — rather than failed requests. A timed-out CLI, the
 * one failure shEffect can raise, reads the same way. */
const shSoft = (cmd: string[], cwd?: string): Effect.Effect<Result> =>
  Effect.catchAll(shEffect(cmd, cwd), (e) =>
    Effect.succeed({ code: e.exitCode, stdout: "", stderr: e.stderr }));

/** Owner and name from a git remote URL: the https, ssh and git shapes GitHub answers to, with
 * or without the `.git` suffix. Pure, so the shapes stay testable without a repository. */
// Pure and synchronous: nothing for an Effect to wrap.
export function repoFromRemote(url: string): { owner: string; name: string } | undefined {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)$/.exec(url.trim().replace(/\.git$/, ""));
  return m ? { owner: m[1]!, name: m[2]! } : undefined;
}

/** `--json` output through a Schema, with the usual tolerance: a gh that printed nothing, or
 * something this query did not expect, reads as the fallback (docs/effect-conventions.md). */
const ghJson = <A, I, B extends A>(schema: Schema.Schema<A, I>, fallback: B) =>
  (stdout: string): Effect.Effect<B> =>
    stdout.trim()
      ? Effect.orElseSucceed(
          Schema.decodeUnknown(Schema.parseJson(schema))(stdout) as Effect.Effect<B>,
          () => fallback,
        )
      : Effect.succeed(fallback);

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

/**
 * The GitHub repository a source path pushes to, or undefined when it does not: this
 * extension's honest answer to a repository that is not on GitHub.
 *
 * Asked through the origin URL rather than `gh repo view`, so a repository you have never
 * authenticated against still resolves its name — and a repository with no remote at all fails
 * the same way.
 */
export const nameWithOwnerEffect = (repo: string): Effect.Effect<string | undefined> =>
  Effect.map(
    swrEffect(`gh:issues:nwo:${repo}`, 300_000, shSoft(["git", "remote", "get-url", "origin"], repo)),
    (r) => {
      if (r.code !== 0) return undefined;
      const found = repoFromRemote(r.stdout.trim());
      return found ? `${found.owner}/${found.name}` : undefined;
    },
  );

/** The open issues of one repository, newest first. */
export const listIssuesEffect = (repo: string): Effect.Effect<{ repository?: string; issues: GitHubIssue[] }> =>
  Effect.gen(function* () {
    const repository = yield* nameWithOwnerEffect(repo);
    if (!repository) return { issues: [] };
    const issues = yield* swrEffect(
      `gh:issues:list:${repository}`,
      ISSUE_TTL,
      Effect.flatMap(
        shSoft(
          ["gh", "issue", "list", "-R", repository, "--state", "open", "--limit", "100",
            "--json", "number,title,state,url,assignees,labels"],
          repo,
        ),
        (r) =>
          r.code !== 0
            ? Effect.succeed([])
            : ghJson(Schema.Array(IssueSchema), [] as Schema.Schema.Type<typeof IssueSchema>[])(r.stdout),
      ),
    );
    return { repository, issues: issues.map(flatten) };
  });

/** One issue, whatever its state: the card, the title and the description ask here. */
export const viewIssueEffect = (repository: string, number: number): Effect.Effect<GitHubIssue | undefined> =>
  Effect.map(
    swrEffect(
      `gh:issues:issue:${repository}#${number}`,
      ISSUE_TTL,
      Effect.flatMap(
        shSoft(
          ["gh", "issue", "view", String(number), "-R", repository,
            "--json", "number,title,state,url,assignees,labels"],
          process.cwd(),
        ),
        (r) =>
          r.code !== 0
            ? Effect.succeed(null)
            : ghJson(Schema.NullOr(IssueSchema), null)(r.stdout),
      ),
    ),
    (found) => (found ? flatten(found) : undefined),
  );

/** Creates an issue and returns it, so the wizard can select what it just made. */
export const createIssueEffect = (
  repo: string,
  title: string,
  body?: string,
): Effect.Effect<{ repository: string; issue: GitHubIssue }, Error> =>
  Effect.gen(function* () {
    const repository = yield* nameWithOwnerEffect(repo);
    if (!repository) {
      return yield* Effect.fail(new Error(`${repo} has no GitHub remote`));
    }
    const args = ["gh", "issue", "create", "-R", repository, "-t", title];
    if (body?.trim()) args.push("-b", body);
    const created = yield* Effect.flatMap(shSoft(args, repo), (r) =>
      r.code !== 0
        ? Effect.fail(new Error(r.stderr || "gh issue create failed"))
        : Effect.succeed(r.stdout.trim()));
    // The URL is the last thing gh prints: …/issues/<number>.
    const number = Number(/\/issues\/(\d+)\s*$/.exec(created)?.[1]);
    if (!number) {
      return yield* Effect.fail(new Error(`could not read the new issue's number: ${created}`));
    }
    invalidate(`gh:issues:list:${repository}`);
    const issue =
      (yield* viewIssueEffect(repository, number)) ?? {
        number,
        title,
        state: "open",
        assignees: [],
        labels: [],
      };
    return { repository, issue };
  });

/** Close the issue with a word about where the work landed. */
const closeIssueEffect = (repository: string, number: number, comment: string): Effect.Effect<void, Error> =>
  Effect.asVoid(
    Effect.flatMap(shSoft(["gh", "issue", "close", String(number), "-R", repository, "-c", comment], process.cwd()), (r) =>
      r.code !== 0 ? Effect.fail(new Error(r.stderr || "gh issue close failed")) : Effect.succeed(r.stdout),
    ),
  );

const stateOf = (issue: GitHubIssue): WidgetState => (issue.state.toLowerCase() === "closed" ? "ok" : "pending");

/** The card: one row, the issue and where it stands. No issue linked reads as none, not as an
 * error — a change may be made without one, and the extension is not the boss of that. */
const statusFor = (change: Change, ref: IssueRef): Effect.Effect<Widget> =>
  Effect.gen(function* () {
    const repository = yield* nameWithOwnerEffect(ref.repo);
    const found = repository ? yield* viewIssueEffect(repository, ref.number) : undefined;
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

const card: Integration = {
  name: KEY,
  title: "GitHub issues",

  async status(change: Change): Promise<Widget> {
    const ref = refOf(change);
    if (!ref) {
      return {
        integration: KEY,
        title: "GitHub issues",
        state: "none",
        summary: "no issue linked",
        items: [],
      };
    }
    return Effect.runPromise(statusFor(change, ref));
  },
};

export default function (api: IweExtensionApi) {
  api.registerCard(card);

  // Runs after the repositories are picked: GitHub issues belong to repositories, so this step
  // has nothing to look at until then.
  api.registerWizardStep({ id: KEY, title: "GitHub issue", phase: "repos" });

  // The overview names a change after its issue's title.
  api.registerTitleSource({
    applies: (change) => Boolean(refOf(change)),
    lookup: async (changes, ctx: ChangeContext) => {
      const titles = new Map<string, string>();
      for (const change of changes) {
        const ref = refOf(change);
        if (!ref) continue;
        try {
          // A gh that cannot answer leaves the stored title standing.
          const repository = await Effect.runPromise(nameWithOwnerEffect(ref.repo));
          const issue = repository
            ? await Effect.runPromise(viewIssueEffect(repository, ref.number))
            : undefined;
          if (issue?.title) titles.set(change.id, issue.title);
        } catch {
          // The next source, or the stored title, is the answer then.
        }
      }
      return titles;
    },
  });

  // The pull-request description opens with the issue and what it is.
  api.registerDescriptionSection({
    heading: async (change) => {
      const ref = refOf(change);
      if (!ref) return undefined;
      try {
        const repository = await Effect.runPromise(nameWithOwnerEffect(ref.repo));
        if (!repository) return undefined;
        const issue = await Effect.runPromise(viewIssueEffect(repository, ref.number));
        return `${refLabel(repository, ref)}${issue?.title ? ` - ${issue.title}` : ""}`;
      } catch {
        return undefined;
      }
    },
  });

  // Completing a change closes the issue, after the merges and before the worktrees go.
  api.registerCompletionStep({
    plan: (change): CompletionStep | undefined => {
      const ref = refOf(change);
      return ref ? { id: KEY, label: `close ${ref.repo.split("/").pop()}#${ref.number}`, state: "waiting" } : undefined;
    },
    run: async (change) => {
      const ref = refOf(change);
      if (!ref) return;
      const repository = await Effect.runPromise(nameWithOwnerEffect(ref.repo));
      if (!repository) return `not a GitHub repository: ${ref.repo}`;
      await Effect.runPromise(closeIssueEffect(repository, ref.number, `Completed in change ${change.id}`));
      invalidate(`gh:issues:issue:${repository}#${ref.number}`);
      return `closed ${refLabel(repository, ref)}`;
    },
  });

  // The two routes the wizard's step fetches: a repository's open issues, and creating one.
  api.route("GET", "/issues", async (req) => {
    const repo = new URL(req.url).searchParams.get("repo") ?? "";
    const result = await Effect.runPromise(listIssuesEffect(repo));
    return Response.json(result);
  });
  api.route("POST", "/issues", async (req) => {
    const body = (await req.json().catch(() => ({}))) as {
      repo?: string;
      title?: string;
      description?: string;
    };
    if (!body.repo || !body.title?.trim()) {
      return Response.json({ error: "repository and title required" }, { status: 400 });
    }
    try {
      const created = await Effect.runPromise(
        createIssueEffect(body.repo, body.title.trim(), body.description),
      );
      return Response.json(created, { status: 201 });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
  });
}
