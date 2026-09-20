/**
 * The included integrations whose lifecycle work the cutover adapters call by name. Extensions
 * loaded from outside the repository still contribute through the extension registry until the
 * platform is removed; these names are excluded from those generic paths so the same step is
 * never planned, run, or reported twice.
 */

/** Git and Jira: the `change:started` hooks the start adapter runs itself. */
export const includedStartIntegrations: readonly string[] = ["git", "jira"];

/** Jira and GitHub Issues: the completion steps the lifecycle plans and runs itself. */
export const includedCompletionIntegrations: readonly string[] = ["jira", "github-issues"];

/** GitHub and Jira: the loose ends the cancel response collects itself. */
export const includedLooseEndIntegrations: readonly string[] = ["github", "jira"];
