import { Effect } from "effect";
import { jiraFetch } from "./jiraHttp.ts";
import type { Site } from "./jira.ts";
import { config } from "../../config.ts";
import { BadRequestError } from "../../effect/errors.ts";

/**
 * The account to assign to: whatever is configured, or the one the token belongs to. A name is
 * not enough — Jira wants an account id — so a configured assignee is looked up.
 */
export const accountId = (
  configured: string,
  site: Site,
): Effect.Effect<string | undefined, BadRequestError> =>
  Effect.gen(function* () {
    if (!configured.trim()) {
      return (
        yield* jiraFetch<{ accountId?: string }>("/rest/api/3/myself", {
          configFile: site.configFile,
          tokenEnv: site.tokenEnv,
        })
      ).accountId;
    }
    // Already an account id: Atlassian's are opaque strings, and a name never looks like one.
    if (!configured.includes("@") && !configured.includes(" ")) return configured;
    const found = yield* jiraFetch<{ accountId?: string; displayName?: string }[]>(
      "/rest/api/3/user/search",
      { configFile: site.configFile, tokenEnv: site.tokenEnv, query: { query: configured } },
    );
    return found[0]?.accountId;
  });
