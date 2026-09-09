import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { BadRequestError } from "../../effect/errors.ts";

/**
 * Talking to Jira Cloud directly, over its own REST API.
 *
 * Nothing new is configured: `jira-cli`'s config file already holds the site, the account and
 * the board, and the token is already in `JIRA_API_TOKEN` because jira-cli wants it there. The
 * CLI is gone, its per-call process with it, but the setup it asked you for is still what this
 * reads — installing IWE on a new machine is still `jira init` and an exported token.
 */
export type JiraSetup = {
  /** e.g. https://example.atlassian.net */
  server: string;
  /** The Atlassian account email, which is the username half of basic auth. */
  login: string;
  /** The board the wizard's issue table comes from. */
  board?: string;
  /** Project key, for creating issues. */
  project?: string;
};

/** Whose Jira: a second client is a second site, a second account and a second token, which is
 * `jira init` into another config file. Named per workspace, so both can be open at once. */
const configPath = (file?: string): string =>
  file ?? process.env.JIRA_CONFIG_FILE ?? join(homedir(), ".config", ".jira", ".config.yml");

/**
 * The three fields we need out of jira-cli's YAML, without a YAML parser.
 *
 * The file is thousands of lines of custom-field schema and four lines that matter, all of them
 * scalars at a known depth: `server` and `login` at the top level, `id` under `board`. A parser
 * would be a dependency and a lot of code to read four values that are already this easy to see.
 */
// Pure and synchronous: nothing for an Effect to wrap.
export function parseJiraConfig(text: string): Partial<JiraSetup> {
  const top = (key: string): string | undefined =>
    new RegExp(`^${key}:\\s*(\\S+)\\s*$`, "m").exec(text)?.[1];
  // `board:` then an indented `id: 169` — the first indented id after the key.
  const nested = (parent: string, key: string): string | undefined => {
    const at = new RegExp(`^${parent}:\\s*$`, "m").exec(text);
    if (!at) return undefined;
    const after = text.slice(at.index + at[0].length);
    return new RegExp(`^\\s+${key}:\\s*"?([^"\\n]+)"?\\s*$`, "m").exec(after)?.[1]?.trim();
  };
  return {
    server: top("server")?.replace(/\/$/, ""),
    login: top("login"),
    board: nested("board", "id"),
    project: nested("project", "key"),
  };
}

/** Read once per file: it is only written by `jira init`, and it is a megabyte of custom fields.
 * The map holds one memoized Effect per path, which is the old Map of promises: concurrent
 * askers share a single read, and a missing or unreadable file is an empty setup, not an error
 * — the old `.catch(() => ({}))`. */
const setups = new Map<string, Effect.Effect<Partial<JiraSetup>>>();

export const jiraSetupEffect = (file?: string): Effect.Effect<Partial<JiraSetup>> =>
  Effect.suspend(() => {
    const path = configPath(file);
    const known = setups.get(path);
    if (known) return known;
    const asking = Effect.runSync(
      Effect.cached(
        Effect.tryPromise({ try: () => Bun.file(path).text(), catch: (e) => e }).pipe(
          Effect.map(parseJiraConfig),
          Effect.catchAll(() => Effect.succeed({})),
        ),
      ),
    );
    setups.set(path, asking);
    return asking;
  });


/** Base URL of the Jira instance, for the links in the UI. */
export const jiraBaseUrlEffect = (file?: string): Effect.Effect<string | undefined> =>
  Effect.map(jiraSetupEffect(file), (setup) => setup.server);


/** What is missing, said in the words of the thing you would do about it. Fails with the message
 * the old throws carried (BadRequestError maps where the old thrown Error went — a 400 carrying
 * its message). */
const credentialsEffect = (
  file?: string,
  tokenEnv?: string,
): Effect.Effect<{ server: string; auth: string }, BadRequestError> =>
  Effect.gen(function* () {
    const { server, login } = yield* jiraSetupEffect(file);
    // A second site is a second token: which variable holds it is the workspace's to say.
    const token = process.env[tokenEnv ?? "JIRA_API_TOKEN"];
    if (!server || !login) {
      return yield* Effect.fail(
        new BadRequestError({
          message: `no Jira site configured in ${configPath(file)} — run \`jira init\``,
        }),
      );
    }
    if (!token) {
      return yield* Effect.fail(
        new BadRequestError({ message: `${tokenEnv ?? "JIRA_API_TOKEN"} is not set in the environment` }),
      );
    }
    return { server, auth: `Basic ${btoa(`${login}:${token}`)}` };
  });

/**
 * One request. Errors carry Jira's own explanation, because "400" on its own has never helped
 * anyone: the API answers with `errorMessages` and `errors`, and both are worth repeating.
 */
export const jiraFetchEffect = <T>(
  path: string,
  init?: {
    method?: string;
    body?: unknown;
    query?: Record<string, string | undefined>;
    /** Which site: a workspace's own jira-cli config file, when it has one. */
    configFile?: string;
    /** Which environment variable holds that site's token. */
    tokenEnv?: string;
  },
): Effect.Effect<T, BadRequestError> =>
  Effect.gen(function* () {
    const { server, auth } = yield* credentialsEffect(init?.configFile, init?.tokenEnv);
    const url = new URL(path, server);
    for (const [key, value] of Object.entries(init?.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    const network = <A>(work: () => Promise<A>, what: string): Effect.Effect<A, BadRequestError> =>
      Effect.tryPromise({
        try: work,
        catch: (e) =>
          new BadRequestError({ message: `${what}: ${e instanceof Error ? e.message : String(e)}` }),
      });

    const response = yield* network(
      () =>
        fetch(url, {
          method: init?.method ?? "GET",
          headers: {
            authorization: auth,
            accept: "application/json",
            ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: init?.body === undefined ? undefined : JSON.stringify(init.body),
        }),
      "jira request failed",
    );

    const text = yield* network(() => response.text(), "jira response failed");
    if (!response.ok) {
      return yield* Effect.fail(
        new BadRequestError({ message: `jira ${response.status}: ${explain(text) || response.statusText}` }),
      );
    }
    return yield* Effect.try({
      try: () => (text ? (JSON.parse(text) as T) : (undefined as T)),
      catch: (e) =>
        new BadRequestError({ message: e instanceof Error ? e.message : String(e) }),
    });
  });


/** Jira's error shape, flattened to a line. */
function explain(text: string): string {
  try {
    const body = JSON.parse(text) as { errorMessages?: string[]; errors?: Record<string, string> };
    return [...(body.errorMessages ?? []), ...Object.values(body.errors ?? {})].join("; ");
  } catch {
    return text.split("\n")[0] ?? "";
  }
}
