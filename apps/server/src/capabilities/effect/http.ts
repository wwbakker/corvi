import { formatError, isIweError } from "@corvi/contracts/errors";
import type { IweError } from "@corvi/contracts/errors";

/**
 * The only place in the effect layer that knows what a Response is: which of our errors maps
 * to which status code, and the `{ error: message }` JSON shape of a failure response.
 * Everything upstream just fails with a typed error.
 *
 * NotFoundError → 404, BadRequestError → 400, ConflictError → 409, CliError → 400, DecodeError →
 * 400 for a request body (the caller's mistake) but 500 for a file or CLI decode (ours),
 * InternalError → 500.
 */

const json = (data: unknown, status: number): Response => Response.json(data, { status });

const statusFor = (e: IweError): number => {
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
    case "InternalError":
      return 500;
  }
};

/** Anything a route effect fails with becomes a Response — ours by taxonomy, anything else
 * (a defect that escaped, an untyped Error) as 400 with its message. */
export const toResponse = (e: unknown): Response => {
  if (isIweError(e)) return json({ error: formatError(e) }, statusFor(e));
  return json({ error: e instanceof Error ? e.message : String(e) }, 400);
};
