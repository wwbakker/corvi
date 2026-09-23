import { Effect } from "effect";
import { BadRequestError } from "@corvi/contracts/errors";
import type { Site } from "./jira.ts";

/**
 * Talking to Jira Cloud directly, over its own REST API.
 *
 * The site is the workspace's own configuration, and this is the whole transport: a server, an
 * account email and a token — which may be typed into the extension's settings or read from the
 * environment variable the site names. Nothing else is configured, and no other tool is involved:
 * not to run, not to configure, and not to hold the token.
 */

/** The site's URL: a bare host is what people type, so it gets the scheme. http(s) only — a
 * scheme this transport cannot speak must be rejected rather than read as a host, which is what
 * "ftp://x.example" would otherwise become. */
function serverUrl(server: string): URL | undefined {
  const trimmed = server.trim();
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(absolute);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.hostname ? url : undefined;
  } catch {
    return undefined;
  }
}

/** What a request needs, or why there is not one to make. */
type SiteCheck = { server: URL; auth: string } | { problem: string };

/**
 * Is this site usable, and if so how does one speak to it.
 *
 * One statement of what "configured" means, for the callers about to make a request and for the
 * ones that have to say why they cannot — the board view, which reports rather than fails, and
 * `createIssue`, which must not report a missing project for a site with no server. The order is
 * the order the fields are filled in, and each failure names the field.
 *
 * The token is the site's own when one is stored, and the environment's otherwise — a credential
 * typed against a site is more specific than a variable set for whatever process started the
 * server. A variable that is set but empty is not a token, so it falls through like an unset one.
 */
export function siteCheck(site: Site): SiteCheck {
  const address = site.server?.trim();
  if (!address) {
    return { problem: "no Jira server for this workspace — set Server in Settings" };
  }
  const server = serverUrl(address);
  if (!server) {
    return { problem: `"${address}" is not a server address — set Server in Settings` };
  }

  const email = site.email?.trim();
  if (!email) {
    return { problem: "no Jira account email for this workspace — set Account email in Settings" };
  }

  const variable = site.tokenEnv?.trim() || "JIRA_API_TOKEN";
  const token = site.token?.trim() || process.env[variable];
  if (!token) {
    return {
      problem: `no Jira token for this workspace — set API token in Settings, or export ${variable}`,
    };
  }

  return { server, auth: `Basic ${btoa(`${email}:${token}`)}` };
}

const credentials = (site: Site): Effect.Effect<{ server: URL; auth: string }, BadRequestError> =>
  Effect.gen(function* () {
    const check = siteCheck(site);
    if ("problem" in check) return yield* new BadRequestError({ message: check.problem });
    return check;
  });

/** Where the site is, for the links the UI builds: the same normalization every request uses, so
 * a bare host typed on the settings page links somewhere real. Undefined when there is nothing to
 * link to, which is the widget showing the issue without a URL rather than a broken one. */
export const siteBaseUrl = (site: Site): string | undefined => {
  const address = site.server?.trim();
  if (!address) return undefined;
  return serverUrl(address)?.origin;
};

/**
 * One request. Errors carry Jira's own explanation, because "400" on its own has never helped
 * anyone: the API answers with `errorMessages` and `errors`, and both are worth repeating.
 */
export const jiraFetch = <T>(
  path: string,
  init?: {
    method?: string;
    body?: unknown;
    query?: Record<string, string | undefined>;
    /** Which Jira: the workspace's own site, or the config-wide default it inherits. */
    site?: Site;
  },
): Effect.Effect<T, BadRequestError> =>
  Effect.gen(function* () {
    const { server, auth } = yield* credentials(init?.site ?? {});
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
      return yield* new BadRequestError({
        message: `jira ${response.status}: ${explain(text) || response.statusText}`,
      });
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
