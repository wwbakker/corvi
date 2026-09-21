import { env } from "../../capabilities/identity.ts";

/**
 * The environment variables the app's settings can be overridden with, by config field.
 *
 * The precedence chain itself lives in `@corvi/configuration/settings`; this map is the app's
 * naming of the variables, built from the product's own identity so the prefix is spelled once.
 *
 * The settings page shows a set variable as locked rather than pretending to edit it: an
 * environment variable wins, so writing the file would change nothing and look like a bug. The
 * resolver reads the same map, so a field's override is named once.
 */
export const ENV_OVERRIDES: Record<string, string> = {
  changesRoot: env("ROOT"),
  archiveRoot: env("ARCHIVE_ROOT"),
  repositoriesDirectory: env("REPOSITORIES_DIRECTORY"),
  worktreeCopy: env("WORKTREE_COPY"),
};
