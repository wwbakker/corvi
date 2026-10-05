import { expect, test } from "bun:test";
import { Effect, Result, Schema } from "effect";
import {
  BadRequestError,
  CliError,
  ConflictError,
  DecodeError,
  InternalError,
  NotFoundError,
  TooManyRequestsError,
  formatError,
  isIweError,
} from "@corvi/contracts/errors";
import { ChangeFormatTooNew, ChangeNotFound, ChangeStoreError } from "@corvi/changes/errors";
import { ChangeId } from "@corvi/contracts/changes";
import { OperationError } from "@corvi/repositories/git";
import { CheckoutError, NotARepository } from "@corvi/repositories";

/**
 * The domain errors are now `Schema.TaggedError`: schema-backed, `instanceof Error`, yieldable in
 * `Effect.gen`, and `catchTag`-able. These assertions pin those properties — including that every
 * field survives an encode/decode round-trip unchanged — so a future change cannot quietly drop
 * back to a plain class or widen a field.
 */

/** A tagged error is schema-backed when its class decodes itself, is an `Error`, and carries its
 * tag and every field back through an encode/decode round-trip. The `fields` assertions catch a
 * schema mistake that changes a decoded value; type widening (brand/literal/optional) is caught
 * by `tsc`, not here. */
const assertSchemaBacked = <S extends Schema.ConstraintCodec<unknown, unknown, never, never>>(
  schema: S,
  tag: string,
  instance: S["Type"],
  fields: Readonly<Record<string, unknown>>,
): void => {
  expect(instance).toBeInstanceOf(Error);
  expect((instance as { _tag: string })._tag).toBe(tag);
  const encoded = Schema.encodeSync(schema)(instance);
  const decoded = Schema.decodeUnknownSync(schema)(encoded);
  expect(decoded).toBeInstanceOf(schema as unknown as new (...args: never[]) => unknown);
  expect((decoded as { _tag: string })._tag).toBe(tag);
  for (const [key, value] of Object.entries(fields)) {
    expect((decoded as unknown as Record<string, unknown>)[key]).toEqual(value);
  }
};

test("the taxonomy's errors are Schema.TaggedError-backed and round-trip their fields", () => {
  const notFound = new NotFoundError({ message: "gone" });
  assertSchemaBacked(NotFoundError, "NotFoundError", notFound, { message: "gone" });
  expect(isIweError(notFound)).toBe(true);
  expect(formatError(notFound)).toBe("gone");

  // The class populates `message` from the field, so no force-assignment workaround is needed.
  const bad = new BadRequestError({ message: "bad id" });
  assertSchemaBacked(BadRequestError, "BadRequestError", bad, { message: "bad id" });
  expect(bad.message).toBe("bad id");

  assertSchemaBacked(ConflictError, "ConflictError", new ConflictError({ message: "dirty", needsForce: true }), {
    message: "dirty",
    needsForce: true,
  });
  assertSchemaBacked(
    TooManyRequestsError,
    "TooManyRequestsError",
    new TooManyRequestsError({ message: "slow", retryAfterSeconds: 5 }),
    { message: "slow", retryAfterSeconds: 5 },
  );
  assertSchemaBacked(InternalError, "InternalError", new InternalError({ message: "boom" }), {
    message: "boom",
  });
  assertSchemaBacked(
    CliError,
    "CliError",
    new CliError({
      message: "git failed",
      tool: "git",
      command: "git status",
      stderr: "not a repository",
      exitCode: 128,
    }),
    { message: "git failed", tool: "git", command: "git status", stderr: "not a repository", exitCode: 128 },
  );
  assertSchemaBacked(
    DecodeError,
    "DecodeError",
    new DecodeError({ source: "request-body", message: "bad body" }),
    { source: "request-body", message: "bad body" },
  );
});

test("the change and repository errors are Schema.TaggedError-backed, brands included", () => {
  // The branded `changeId` must come back as the same branded value, not a plain string.
  const changeId = ChangeId.make("c1");
  assertSchemaBacked(
    ChangeNotFound,
    "ChangeNotFound",
    new ChangeNotFound({ changeId, message: "missing" }),
    { changeId, message: "missing" },
  );
  assertSchemaBacked(
    ChangeFormatTooNew,
    "ChangeFormatTooNew",
    new ChangeFormatTooNew({ changeId, recordFormat: 3, appFormat: 2, message: "newer" }),
    { changeId, recordFormat: 3, appFormat: 2, message: "newer" },
  );
  assertSchemaBacked(
    OperationError,
    "Git.OperationError",
    new OperationError({ operation: "discover", message: "git is missing" }),
    { operation: "discover", message: "git is missing" },
  );
  assertSchemaBacked(
    CheckoutError,
    "CheckoutError",
    new CheckoutError({ operation: "inspect", directory: "/x", message: "no" }),
    { operation: "inspect", directory: "/x", message: "no" },
  );
  assertSchemaBacked(NotARepository, "NotARepository", new NotARepository({ directory: "/x" }), {
    directory: "/x",
  });
});

test("a literal-union field stays a literal union on decode", () => {
  // `Result.isFailure` rather than `expect(fn).toThrow()`: a successful tagged-error decode
  // returns an `Error` instance, and Bun's bare `toThrow()` would treat that as a throw.
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(OperationError)({
        _tag: "Git.OperationError",
        operation: "not-a-git-operation",
        message: "x",
      }),
    ),
  ).toBe(true);
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(CheckoutError)({
        _tag: "CheckoutError",
        operation: "not-a-checkout-operation",
        directory: "/x",
        message: "x",
      }),
    ),
  ).toBe(true);
});

test("a cause is preserved by identity through construction and the round-trip", () => {
  const error = new Error("inner failure");
  const withError = new ChangeStoreError({
    changeId: ChangeId.make("c1"),
    operation: "read",
    message: "could not read",
    cause: error,
  });
  expect(withError.cause).toBe(error);

  const throughSchema = Schema.decodeUnknownSync(ChangeStoreError)(
    Schema.encodeSync(ChangeStoreError)(withError),
  );
  expect(throughSchema.cause).toBe(error);

  const nonError: unknown = { code: "ENOENT", path: "/tmp/x" };
  const withNonError = new ChangeStoreError({
    changeId: ChangeId.make("c2"),
    operation: "write",
    message: "could not write",
    cause: nonError,
  });
  const decodedNonError = Schema.decodeUnknownSync(ChangeStoreError)(
    Schema.encodeSync(ChangeStoreError)(withNonError),
  );
  expect(decodedNonError.cause).toBe(nonError);
});

test("a Schema.TaggedError is yieldable and catchTag/catchTags-able", async () => {
  const program = Effect.gen(function* () {
    const unreachable: number = yield* new BadRequestError({ message: "from gen" });
    return String(unreachable);
  });
  const caughtTag = await Effect.runPromise(
    Effect.catchTag(program, "BadRequestError", (error) => Effect.succeed(error.message)),
  );
  expect(caughtTag).toBe("from gen");

  const caughtTags = await Effect.runPromise(
    Effect.catchTags(program, {
      BadRequestError: (error) => Effect.succeed(`tag=${error._tag} message=${error.message}`),
    }),
  );
  expect(caughtTags).toBe("tag=BadRequestError message=from gen");
});
