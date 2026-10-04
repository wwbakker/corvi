import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { bodyAs, decodePreserving, formatIssues } from "../packages/contracts/src/body.ts";
import { ChangeWireSchema } from "../packages/contracts/src/api.ts";

/**
 * `decodePreserving` is the v4 replacement for the removed `onExcessProperty: "preserve"`. Its
 * whole job is that a rewrite cannot drop persisted fields, so the interesting cases are keys
 * that collide with `Object.prototype` (`constructor`, `toString`) and the `__proto__` setter:
 * nothing in the tree may lose them, and no untrusted body may reach the prototype.
 */

/** Raw input as `JSON.parse` builds it: `__proto__` is an own key, not a setter call. */
const rawChange = (): unknown =>
  JSON.parse(
    '{"id":"x","branch":"x","createdAt":"2026-01-01","constructor":{"a":1},' +
      '"toString":"keep-me","__proto__":{"polluted":"yes"},"extra":1}',
  );

/** Read by a string-typed key so `toString`/`constructor` resolve to the index signature, not the
 * `Object.prototype` method TS would otherwise report. */
const at = (value: Record<string, unknown>, key: string): unknown => value[key];

const expectPrototypeNamedKeysSurvive = (value: Record<string, unknown>): void => {
  expect(Object.hasOwn(value, "constructor")).toBe(true);
  expect(at(value, "constructor")).toEqual({ a: 1 });
  expect(Object.hasOwn(value, "toString")).toBe(true);
  expect(at(value, "toString")).toBe("keep-me");
  expect(Object.hasOwn(value, "__proto__")).toBe(true);
  expect(at(value, "__proto__")).toEqual({ polluted: "yes" });
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
};

test("decodePreserving keeps prototype-named keys as own keys and never touches the prototype", async () => {
  const decoded = (await Effect.runPromise(
    decodePreserving(ChangeWireSchema, rawChange()),
  )) as unknown as Record<string, unknown>;
  expectPrototypeNamedKeysSurvive(decoded);
  expect(decoded.extra).toBe(1);
});

test("bodyAs keeps prototype-named unknown keys from an untrusted body", async () => {
  const req = new Request("http://corvi.test/changes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(rawChange()),
  });
  const decoded = (await Effect.runPromise(bodyAs(req, ChangeWireSchema))) as unknown as Record<
    string,
    unknown
  >;
  expectPrototypeNamedKeysSurvive(decoded);
  expect(decoded.extra).toBe(1);
});

test("decodePreserving walks an array of objects and keeps each element's unknown keys", async () => {
  const schema = Schema.Struct({
    items: Schema.Array(Schema.Struct({ id: Schema.String })),
  });
  const input = {
    items: [
      { id: "a", extra: 1, nested: { deep: true } },
      { id: "b", extra: 2 },
    ],
  };
  const decoded = (await Effect.runPromise(decodePreserving(schema, input))) as unknown as {
    items: Record<string, unknown>[];
  };
  expect(decoded.items[0]?.extra).toBe(1);
  expect(decoded.items[0]?.nested).toEqual({ deep: true });
  expect(decoded.items[1]?.extra).toBe(2);
});

test("formatIssues renders one `path: message` line per issue, joined with `; `", async () => {
  const schema = Schema.Struct({ id: Schema.String, n: Schema.Number });
  const error = await Effect.runPromise(
    Effect.flip(Schema.decodeUnknownEffect(schema)({ n: "no" }, { errors: "all" })),
  );
  expect(formatIssues(error)).toBe("id: Missing key; n: Expected number");
});
