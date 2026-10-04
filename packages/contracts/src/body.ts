import { Effect, Schema, SchemaIssue } from "effect";
import { BadRequestError, DecodeError, type IweError } from "./errors.ts";

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

/** Whether a value is a plain object: an object literal or a `null`-prototype object. Class
 * instances (such as `Schema.Class` decoded values) are excluded so spreading them cannot drop
 * their prototype. */
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Deep-splice keys the raw value carries but the decoded value lacks. Effect 4 removed
 * `onExcessProperty: "preserve"`, and Corvi depends on the invariant that rewriting a persisted
 * document (a `change.json`, the config file) must not drop fields another Corvi version wrote.
 * Decoding with the closed schema drops those unknown keys, so they are added back here — at the
 * top level and, recursively, inside plain objects and arrays. Known keys keep the decoded value
 * (so defaults and transformations survive) and class instances are returned untouched.
 */
export const mergeUnknownKeys = (decoded: unknown, raw: unknown): unknown => {
  if (Array.isArray(decoded) && Array.isArray(raw)) {
    return decoded.map((item, index) => (index < raw.length ? mergeUnknownKeys(item, raw[index]) : item));
  }
  if (isPlainObject(decoded) && isPlainObject(raw)) {
    const merged: Record<string, unknown> = { ...decoded };
    for (const [key, value] of Object.entries(raw)) {
      // Own-property membership, not `key in`: an inherited `constructor`/`toString` must not be
      // treated as a decoded field, and a raw value there must be spliced back as an own key.
      if (!Object.hasOwn(merged, key)) {
        // Define, not assign: `merged.__proto__ = value` would invoke the prototype setter (the
        // raw value is untrusted). `defineProperty` makes `__proto__` an own, enumerable key.
        Object.defineProperty(merged, key, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      } else {
        merged[key] = mergeUnknownKeys(merged[key], value);
      }
    }
    return merged;
  }
  return decoded;
};

/** Decode `input` with `schema` while preserving unknown keys, the v4 replacement for the
 * removed `onExcessProperty: "preserve"` option. */
export const decodePreserving = <S extends Schema.Constraint>(
  schema: S,
  input: unknown,
): Effect.Effect<Schema.Schema.Type<S>, Schema.SchemaError, S["DecodingServices"]> =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.map((decoded) => mergeUnknownKeys(decoded, input) as Schema.Schema.Type<S>),
  );

/** Render a schema issue the way the v3 ArrayFormatter did: one `path: message` line per issue,
 * joined with `; `, so the detail strings callers already show do not change. */
export const formatIssues = (error: Schema.SchemaError): string =>
  SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues
    .map((issue) => {
      const path = issue.path ?? [];
      return path.length ? `${path.join(".")}: ${issue.message}` : issue.message;
    })
    .join("; ");

/** Read a request body as JSON and decode it with the route's schema. The schema is the boundary
 * contract: a body that does not fit is the caller's 400 naming the field, never a cast. Unknown
 * properties survive, so a newer page can send a field this core does not know yet. */
export const bodyAs = <S extends Schema.Constraint>(
  req: Request,
  schema: S,
): Effect.Effect<Schema.Schema.Type<S>, IweError, S["DecodingServices"]> =>
  bodyOf(req).pipe(
    Effect.flatMap((body) =>
      decodePreserving(schema, body).pipe(
        Effect.mapError((error) => new DecodeError({ source: "request-body", message: formatIssues(error) })),
      ),
    ),
  );
