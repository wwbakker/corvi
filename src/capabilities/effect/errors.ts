import { Data } from "effect";

/**
 * Error values consumed by the route response mapper. Each carries a display message.
 * Domain-specific contracts and transport error mapping are described in docs/guides/api-design.md.
 *
 * This file knows nothing about HTTP: mapping these to status codes lives in http.ts, the only
 * place that knows what a Response is.
 */

/** The thing asked about does not exist. */
export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly message: string;
}> {}

/** The request itself is wrong: bad id, bad state transition, missing field. */
export class BadRequestError extends Data.TaggedError("BadRequestError")<{
  readonly message: string;
}> {}

/** The current state forbids it; the caller may retry with force. */
export class ConflictError extends Data.TaggedError("ConflictError")<{
  readonly message: string;
  readonly needsForce?: boolean;
}> {}

/** Something on our side failed while serving a well-formed request. */
export class InternalError extends Data.TaggedError("InternalError")<{
  readonly message: string;
}> {}

/** An external CLI (`git`, `gh`, `az`, ...) failed. What it said and what it cost.
 * `message` is what the UI shows — for `shOrThrow` that is `<cmd> failed: <stderr>`, for a
 * timeout `<cmd> timed out after N seconds` — and `formatError` hands it to the response
 * verbatim. */
export class CliError extends Data.TaggedError("CliError")<{
  readonly message: string;
  readonly tool: string;
  readonly command: string;
  readonly stderr: string;
  readonly exitCode: number;
}> {}

/** Schema validation failed. Where it failed decides its status code: a request body is the
 * caller's mistake; a file or CLI JSON on disk is ours. */
export class DecodeError extends Data.TaggedError("DecodeError")<{
  readonly source: "request-body" | "file" | "cli";
  readonly message: string;
}> {}

export type IweError = NotFoundError | BadRequestError | ConflictError | CliError | DecodeError | InternalError;

/** True when `e` is one of ours (and therefore has a status code waiting in http.ts). */
export const isIweError = (e: unknown): e is IweError =>
  typeof e === "object" && e !== null && "_tag" in e &&
  ["NotFoundError", "BadRequestError", "ConflictError", "CliError", "DecodeError", "InternalError"].includes(
    (e as { _tag: unknown })._tag as string,
  );

/** The human-readable message for any of ours. */
export const formatError = (e: IweError): string => e.message;
