/**
 * The azure-devops extension's shared wire vocabulary: what the server's pages and routes serve,
 * and what the browser decodes. The schemas are the one statement of the shapes; the types are
 * derived from them, so the two halves cannot drift.
 */
import { Schema } from "effect";

import { WidgetStateSchema } from "@corvi/contracts/api";

/** One environment's state: deployed, deploying, or the last attempt failed. */
export const DeployedSchema = Schema.Struct({
  environment: Schema.String,
  version: Schema.optional(Schema.String),
  /** When that deploy finished, or started if it is still going. */
  at: Schema.optional(Schema.String),
  /** Green when it is deployed, amber while it is deploying, red when the last attempt failed. */
  state: WidgetStateSchema,
  detail: Schema.String,
  url: Schema.optional(Schema.String),
});
export type Deployed = typeof DeployedSchema.Type;

/** One service's row: its pipelines and where each environment stands. */
export const ServiceSchema = Schema.Struct({
  /** What the pipelines call it: `example-service`. */
  name: Schema.String,
  pipeline: Schema.Struct({ id: Schema.Number, name: Schema.String }),
  /** The build pipeline this deploys, when there is one by the expected name. */
  build: Schema.optional(Schema.Struct({ id: Schema.Number, name: Schema.String })),
  environments: Schema.mutable(Schema.Array(DeployedSchema)),
});
export type Service = typeof ServiceSchema.Type;

/** The page's read: the services, or why there are none. */
export const ServicesResponseSchema = Schema.Struct({
  services: Schema.mutable(Schema.Array(ServiceSchema)),
  error: Schema.optional(Schema.String),
});
export type ServicesResponse = typeof ServicesResponseSchema.Type;

/** A build that produced something deployable: what it was called, and what it made. */
export const BuildableSchema = Schema.Struct({
  runId: Schema.Number,
  buildNumber: Schema.String,
  /** Undefined while the build is still running: the version is scraped from its logs, which do
   * not exist yet. */
  version: Schema.optional(Schema.String),
  branch: Schema.String,
  finishedAt: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  /** Where this version already is, so a version you are about to deploy says so first. */
  deployedTo: Schema.mutable(Schema.Array(Schema.String)),
  /** Still building: shown so a deploy in progress does not look like it fell off the list, but
   * not something you can pick — there is no version yet to deploy. */
  running: Schema.optional(Schema.Boolean),
  startedAt: Schema.optional(Schema.String),
  /** The recent average for this pipeline, for the same progress bar the GitHub card draws. */
  expectedMs: Schema.optional(Schema.Number),
});
export type Buildable = typeof BuildableSchema.Type;
