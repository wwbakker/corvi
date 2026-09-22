import type { ChangeWireDto as Change } from "@corvi/contracts/api";
import type { Config } from "@corvi/configuration/config";
import { env } from "@corvi/configuration/node";
import { resolveSetting } from "@corvi/configuration/settings";

/**
 * The jira extension's raw reads of the fields the core used to own.
 *
 * The core no longer types or writes them, but every file boundary decodes with unknown keys
 * preserved, so a change.json, a config.json or a workspace entry written before the
 * `extensions` bag existed still carries them at runtime. These are the one place the jira
 * extension names them, and the one narrow cast each read needs; nothing else in the extension
 * — and nothing in the core — reaches for a legacy field.
 */

/** The environment variables the extension's declared settings name, so the settings page's
 * lock and the fallback here cannot drift apart. */
export const JIRA_ENV = {
  assignee: env("JIRA_ASSIGNEE"),
  startTransition: env("JIRA_START_TRANSITION"),
  doneTransition: env("JIRA_DONE_TRANSITION"),
} as const;

/** The legacy `jira` string a change record written before the bag still carries. */
// Pure and synchronous: nothing for an Effect to wrap.
export const legacyTicketOf = (change: Change): string | undefined => {
  const value = (change as Change & { jira?: unknown }).jira;
  return typeof value === "string" && value.trim() ? value : undefined;
};

/** The legacy flat jira settings, as the config still holds them. The environment variable beats
 * the file, exactly as the resolved chain did before the fields left the core. */
// Pure and synchronous: nothing for an Effect to wrap.
export const legacyGlobalOf = (config: Config): {
  assignee: string;
  startTransition: string;
  doneTransition: string;
} => {
  const legacy = config as Config & {
    jiraAssignee?: string;
    jiraStartTransition?: string;
    jiraDoneTransition?: string;
  };
  return {
    assignee: resolveSetting({ env: JIRA_ENV.assignee, file: legacy.jiraAssignee, fallback: "" }),
    startTransition: resolveSetting({
      env: JIRA_ENV.startTransition,
      file: legacy.jiraStartTransition,
      fallback: "In Progress",
    }),
    doneTransition: resolveSetting({
      env: JIRA_ENV.doneTransition,
      file: legacy.jiraDoneTransition,
      fallback: "Done",
    }),
  };
};

/** The legacy per-workspace `jira` site object, when the workspace carries one: `false`, absent
 * or a non-object means the workspace declares no site of its own. An early object also carried
 * a `configFile`; nothing reads it any more, so neither does this. */
// Pure and synchronous: nothing for an Effect to wrap.
export const legacySiteOfWorkspace = (workspace: object): {
  project?: string;
  board?: string;
  tokenEnv?: string;
} => {
  const value = (workspace as { jira?: unknown }).jira;
  if (typeof value !== "object" || value === null) return {};
  const site = value as {
    project?: unknown;
    board?: unknown;
    tokenEnv?: unknown;
  };
  const str = (field: unknown): string | undefined =>
    typeof field === "string" && field.trim() ? field : undefined;
  return {
    project: str(site.project),
    board: str(site.board),
    tokenEnv: str(site.tokenEnv),
  };
};
