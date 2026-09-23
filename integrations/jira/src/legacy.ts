import type { ChangeWireDto as Change } from "@corvi/contracts/api";
import { env } from "@corvi/configuration/node";
import { resolveSetting } from "@corvi/configuration/settings";

/**
 * The jira extension's raw reads of the fields the core used to own.
 *
 * The core no longer types or writes them, but every file boundary decodes with unknown keys
 * preserved, so a change.json, a config.json or a workspace entry written before the
 * `extensions` bag existed still carries them at runtime. These are the one place the jira
 * extension names them; nothing else in the extension — and nothing in the core — reaches for
 * a legacy field.
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

/** The flat fields older config files still carry, as the preserve decode leaves them on the
 * object: this type is their declaration, so a reader of them needs no cast. */
export type LegacyFlatSettings = {
  jiraAssignee?: string;
  jiraStartTransition?: string;
  jiraDoneTransition?: string;
};

/** The legacy flat jira settings, as the config still holds them: the global scope's old
 * spelling of the three settings, and where their defaults live. The chain resolves them as the
 * fallback's tail (environment > workspace > global bag > these), so this states only the
 * values — the precedence is `@corvi/configuration/settings`' alone. */
// Pure and synchronous: nothing for an Effect to wrap.
export const legacyGlobalOf = (config: LegacyFlatSettings): {
  assignee: string;
  startTransition: string;
  doneTransition: string;
} => {
  return {
    assignee: resolveSetting({ global: config.jiraAssignee, fallback: "" }),
    startTransition: resolveSetting({
      global: config.jiraStartTransition,
      fallback: "In Progress",
    }),
    doneTransition: resolveSetting({
      global: config.jiraDoneTransition,
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
