import { test, expect } from "bun:test";
import { Effect } from "effect";
import { toResponse } from "../apps/server/src/capabilities/effect/http.ts";
import { runRoute } from "../apps/server/src/capabilities/effect/run.ts";
import {
  BadRequestError,
  CliError,
  ConflictError,
  DecodeError,
  formatError,
  isIweError,
  NotFoundError,
} from "@corvi/contracts/errors";

/**
 * http.ts is the one module that knows a Response, so every status code the UI branches on is
 * decided here. These tests pin the status table and the `{ error: message }` shape, because a
 * status silently changing would not fail a compile.
 */

const cliError = (): CliError =>
  new CliError({
    message: "git status failed: not a repository",
    tool: "git",
    command: "git status",
    stderr: "not a repository",
    exitCode: 128,
  });

test("each taxonomy error maps to its status and carries its message as `error`", async () => {
  const cases: readonly (readonly [unknown, number, string])[] = [
    [new NotFoundError({ message: "no such change" }), 404, "no such change"],
    [new BadRequestError({ message: "bad id" }), 400, "bad id"],
    [new ConflictError({ message: "dirty", needsForce: true }), 409, "dirty"],
    [cliError(), 400, "git status failed: not a repository"],
    [new DecodeError({ source: "request-body", message: "body is not json" }), 400, "body is not json"],
  ];
  for (const [error, status, message] of cases) {
    const response = toResponse(error);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: message });
  }
});

test("a DecodeError is the caller's 400 only for a request body; file and CLI JSON are 500", async () => {
  for (const source of ["file", "cli"] as const) {
    const response = toResponse(new DecodeError({ source, message: `${source} json is stale` }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: `${source} json is stale` });
  }
});

test("a non-tagged Error becomes a 400 with its message, not a taxonomy status", async () => {
  const response = toResponse(new Error("boom"));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "boom" });
});

test("a thrown non-Error becomes a 400 with its String() form", async () => {
  const response = toResponse("plain failure");
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "plain failure" });
});

test("an object tagged outside the taxonomy is not treated as ours", () => {
  expect(isIweError({ _tag: "OtherError", message: "not ours" })).toBe(false);
});

test("isIweError accepts every taxonomy tag and rejects non-errors", () => {
  expect(isIweError(new NotFoundError({ message: "x" }))).toBe(true);
  expect(isIweError(new BadRequestError({ message: "x" }))).toBe(true);
  expect(isIweError(new ConflictError({ message: "x" }))).toBe(true);
  expect(isIweError(cliError())).toBe(true);
  expect(isIweError(new DecodeError({ source: "cli", message: "x" }))).toBe(true);
  expect(isIweError(new Error("x"))).toBe(false);
  expect(isIweError("x")).toBe(false);
  expect(isIweError(null)).toBe(false);
  expect(isIweError(undefined)).toBe(false);
});

test("formatError is the message the UI shows", () => {
  expect(formatError(new ConflictError({ message: "dirty", needsForce: true }))).toBe("dirty");
});

test("runRoute resolves with the effect's own Response on success", async () => {
  const expected = Response.json({ ok: true }, { status: 201 });
  const response = await runRoute(Effect.succeed(expected));
  expect(response).toBe(expected);
});

test("runRoute maps a typed failure through the same status table", async () => {
  const cases: readonly (readonly [unknown, number, string])[] = [
    [new NotFoundError({ message: "missing" }), 404, "missing"],
    [new BadRequestError({ message: "bad" }), 400, "bad"],
    [new ConflictError({ message: "dirty" }), 409, "dirty"],
    [cliError(), 400, "git status failed: not a repository"],
    [new DecodeError({ source: "file", message: "stale file" }), 500, "stale file"],
  ];
  for (const [error, status, message] of cases) {
    const response = await runRoute(Effect.fail(error));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: message });
  }
});

test("runRoute turns an escaped defect into a 400 instead of rejecting", async () => {
  const response = await runRoute(Effect.die(new Error("kaboom")));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "kaboom" });
});

test("runRoute handles a defect that is not an Error", async () => {
  const response = await runRoute(Effect.die("plain defect"));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "plain defect" });
});
