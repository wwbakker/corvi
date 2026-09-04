import { homedir } from "node:os";
import { join } from "node:path";

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

const setups = new Map<string, Promise<Partial<JiraSetup>>>();

/** Read once per file: it is only written by `jira init`, and it is a megabyte of custom fields. */
export function jiraSetup(file?: string): Promise<Partial<JiraSetup>> {
  const path = configPath(file);
  if (!setups.has(path)) {
    setups.set(
      path,
      Bun.file(path)
        .text()
        .then(parseJiraConfig)
        .catch(() => ({})),
    );
  }
  return setups.get(path)!;
}

/** Base URL of the Jira instance, for the links in the UI. */
export const jiraBaseUrl = async (file?: string): Promise<string | undefined> =>
  (await jiraSetup(file)).server;

/** What is missing, said in the words of the thing you would do about it. */
async function credentials(
  file?: string,
  tokenEnv?: string,
): Promise<{ server: string; auth: string }> {
  const { server, login } = await jiraSetup(file);
  // A second site is a second token: which variable holds it is the workspace's to say.
  const token = process.env[tokenEnv ?? "JIRA_API_TOKEN"];
  if (!server || !login) {
    throw new Error(`no Jira site configured in ${configPath(file)} — run \`jira init\``);
  }
  if (!token) throw new Error(`${tokenEnv ?? "JIRA_API_TOKEN"} is not set in the environment`);
  return { server, auth: `Basic ${btoa(`${login}:${token}`)}` };
}

/**
 * One request. Errors carry Jira's own explanation, because "400" on its own has never helped
 * anyone: the API answers with `errorMessages` and `errors`, and both are worth repeating.
 */
export async function jiraFetch<T>(
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
): Promise<T> {
  const { server, auth } = await credentials(init?.configFile, init?.tokenEnv);
  const url = new URL(path, server);
  for (const [key, value] of Object.entries(init?.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    method: init?.method ?? "GET",
    headers: {
      authorization: auth,
      accept: "application/json",
      ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`jira ${response.status}: ${explain(text) || response.statusText}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Jira's error shape, flattened to a line. */
function explain(text: string): string {
  try {
    const body = JSON.parse(text) as { errorMessages?: string[]; errors?: Record<string, string> };
    return [...(body.errorMessages ?? []), ...Object.values(body.errors ?? {})].join("; ");
  } catch {
    return text.split("\n")[0] ?? "";
  }
}
