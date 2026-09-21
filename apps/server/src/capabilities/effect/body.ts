import { Effect, ParseResult, Schema } from "effect";
import { BadRequestError, DecodeError, type IweError } from "@corvi/contracts/errors";

/**
 * Reading request bodies, kept free of the rest of the web plumbing: the integration modules'
 * routes use these, and importing `apps/server/src/capabilities/web.ts` from an integration would close a
 * module cycle (web → the change routes → the integration list → the integration).
 */

/** The request body as JSON. A body that will not parse is the caller's mistake, said as the
 * routes say it: a BadRequestError, which the status-code mapping turns into a 400. */
export const bodyOf = (req: Request): Effect.Effect<unknown, BadRequestError> =>
  Effect.tryPromise({
    try: () => req.json(),
    catch: (e) => new BadRequestError({ message: e instanceof Error ? e.message : String(e) }),
  });

/** A body that is allowed to be absent or broken, read as `{}` — what `.catch(() => ({}))` did. */
export const bodyOrEmpty = (req: Request): Effect.Effect<unknown> =>
  Effect.promise(() => req.json().catch(() => ({})));

/** Read a request body as JSON and decode it with the route's schema. The schema is the boundary
 * contract: a body that does not fit is the caller's 400 naming the field, never a cast. Unknown
 * properties survive, so a newer page can send a field this core does not know yet. */
export const bodyAs = <A, I>(
  req: Request,
  schema: Schema.Schema<A, I>,
): Effect.Effect<A, IweError> =>
  bodyOf(req).pipe(
    Effect.flatMap((body) =>
      Schema.decodeUnknown(schema, { onExcessProperty: "preserve" })(body).pipe(
        Effect.mapError((error) => {
          const detail = ParseResult.ArrayFormatter.formatIssueSync(error.issue)
            .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
            .join("; ");
          return new DecodeError({ source: "request-body", message: detail });
        }),
      ),
    ),
  );
