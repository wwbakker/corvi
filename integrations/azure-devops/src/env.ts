import { env } from "@corvi/configuration/node";

/** The environment variables the extension's declared settings name, so the settings page's
 * lock and the reads here cannot drift apart. */
export const AZURE_ENV = {
  organization: env("AZURE_ORG"),
  project: env("AZURE_PROJECT"),
  environments: env("AZURE_ENVIRONMENTS"),
} as const;
