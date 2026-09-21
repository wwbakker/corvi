import type { Effect } from "effect";
import type { Capabilities } from "./capabilities.ts";

// --- Routes get the real prize of typed errors: the host maps them to status codes --------

export {
  BadRequestError,
  CliError,
  ConflictError,
  DecodeError,
  NotFoundError,
} from "@corvi/contracts/errors";
export type RouteError = import("@corvi/contracts/errors").IweError;

/** A route under `/api/ext/<extension>/…`, behind the same origin guard as the core's
 * routes, run as the workspace the request names. Failures map to HTTP status codes through
 * the same mapping the core's routes use — fail with the taxonomy and the status is right.
 *
 * The declared `path` may contain `:name` segments, each capturing one path segment of the
 * request into `params["name"]`. Matching tries the extension's patterns in registration
 * order, then the next extension in load order — the first pattern whose shape fits wins.
 * Handlers that only take `req` stay assignable as they are: a function with fewer parameters
 * is one with more. */
export type RouteHandler = (
  req: Request,
  params: Record<string, string>,
) => Effect.Effect<Response, RouteError, Capabilities>;

export type RequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
