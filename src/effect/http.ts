import { formatError, isIweError } from "./errors.ts";
import type { IweError } from "./errors.ts";

/**
 * The only place in the effect layer that knows what a Response is: which of our errors maps
 * to which status code, and the `{ error: message }` JSON shape the old fail() in server.ts
 * produced. Everything upstream just fails with a typed error.
 *
 * NotFoundError → 404, BadRequestError → 400, ConflictError → 409, CliError → 400 (what
 * fail() did with any thrown Error), DecodeError → 400 for a request body (the caller's
 * mistake) but 500 for a file or CLI decode (ours).
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
  }
};

/** Anything a route effect fails with becomes a Response — ours by taxonomy, anything else
 * (a defect that escaped, an untyped Error) exactly as the old fail() treated it: 400 with
 * its message. */
export const toResponse = (e: unknown): Response => {
  if (isIweError(e)) return json({ error: formatError(e) }, statusFor(e));
  return json({ error: e instanceof Error ? e.message : String(e) }, 400);
};
