import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  formatError,
  isCorviError,
  type CorviError,
} from "@corvi/contracts/errors";
import { messageOf } from "@corvi/shell/cli";

/**
 * The only place in the effect layer that knows what a Response is: which of our errors maps
 * to which status code, and the `{ error: message }` JSON shape of a failure response.
 * Everything upstream just fails with a typed error.
 *
 * NotFoundError → 404, BadRequestError → 400, ConflictError → 409, CliError → 400, DecodeError →
 * 400 for a request body (the caller's mistake) but 500 for a file or CLI decode (ours),
 * TooManyRequestsError → 429, InternalError → 500.
 */

const json = (data: unknown, status: number, headers?: HeadersInit): Response =>
  Response.json(data, { status, headers });

const statusFor = (e: CorviError): number => {
  switch (e._tag) {
    case "NotFoundError":
      return 404;
    case "BadRequestError":
      return 400;
    case "ConflictError":
      return 409;
    case "CliError":
      return 400;
    case "DecodeError":
      return e.source === "request-body" ? 400 : 500;
    case "TooManyRequestsError":
      return 429;
    case "InternalError":
      return 500;
  }
};

/** Anything a route effect fails with becomes a Response — ours by taxonomy, anything else
 * (a defect that escaped, an untyped Error) as 400 with its message. A rate-limit refusal also
 * carries the `Retry-After` advice the error named. */
export const toResponse = (e: unknown): Response => {
  if (isCorviError(e)) {
    const retryAfter = e._tag === "TooManyRequestsError" && e.retryAfterSeconds !== undefined;
    return json(
      { error: formatError(e) },
      statusFor(e),
      retryAfter ? { "retry-after": String(e.retryAfterSeconds) } : undefined,
    );
  }
  return json({ error: e instanceof Error ? e.message : String(e) }, 400);
};

/** A tagged error that is not ours, mapped to the taxonomy: the tags a route knows are a 404 or
 * a 409, and anything else is the caller's 400. A foreign tagged error's `message` wins over its
 * tag, so the page never shows a type name where a sentence exists. */
export type CorviErrorTags = {
  readonly notFound?: readonly string[];
  readonly conflict?: readonly string[];
};

export const asCorviError = (error: unknown, tags: CorviErrorTags = {}): CorviError => {
  if (isCorviError(error)) return error;
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tag = String((error as { _tag: unknown })._tag);
    const raw = "message" in error ? (error as { message: unknown }).message : undefined;
    const message = raw ? String(raw) : tag;
    if (tags.notFound?.includes(tag)) return new NotFoundError({ message });
    if (tags.conflict?.includes(tag)) return new ConflictError({ message });
    return new BadRequestError({ message });
  }
  return new BadRequestError({ message: messageOf(error) });
};
