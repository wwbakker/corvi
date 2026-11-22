/** The subagent routes' query boundary: an explicit `turn` is a plain positive message number, and
 * it names one subagent. The wait/result behavior itself is pinned in
 * `test/subagents.instances.test.ts`; this is the HTTP encoding the CLI and the page speak.
 *
 * The guard rejects before the instance is read, so a change with no subagents is enough: the
 * server is real, its world isolated by `serverEnv`.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { rm } from "node:fs/promises";

import { testTempDir, startTestServer, stopTestServer } from "./helpers.ts";

const CHANGE = "ROUTES-turn";

let tmp: string;
let server: ReturnType<typeof Bun.spawn>;
let url: string;

beforeAll(async () => {
  tmp = await testTempDir("subagents-routes");
  ({ server, url } = await startTestServer(tmp));
  const created = await fetch(`${url}/api/changes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: CHANGE, state: "Ideation" }),
  });
  expect(created.status).toBe(201);
}, 60_000);

afterAll(async () => {
  await stopTestServer(server, tmp);
  await rm(tmp, { recursive: true, force: true });
});

const statusAt = async (path: string): Promise<number> =>
  (await fetch(`${url}/api/changes/${CHANGE}/subagents${path}`)).status;

test("a non-integer turn is a bad request at the HTTP boundary", async () => {
  // The query is a plain positive integer or nothing: `0x10` and `1e3` must not be converted.
  expect(await statusAt("/await?turn=abc")).toBe(400);
  expect(await statusAt("/await?turn=0x10")).toBe(400);
  expect(await statusAt("/await?turn=1e3")).toBe(400);
  expect(await statusAt("/await?turn=1.5")).toBe(400);
  expect(await statusAt("/await?turn=0")).toBe(400);
  expect(await statusAt("/seed-1/result?turn=0x10")).toBe(400);
});

test("turn names one named subagent, never --all", async () => {
  expect(await statusAt("/await?id=a&all=1&turn=1")).toBe(400);
  expect(await statusAt("/await?id=a&id=b&turn=1")).toBe(400);
  expect(await statusAt("/await?turn=1")).toBe(400);
});

test("a change's harness selectors are patched and cleared through the record route", async () => {
  const patch = async (body: unknown): Promise<Record<string, unknown>> => {
    const answer = await fetch(`${url}/api/changes/${CHANGE}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(answer.status).toBe(200);
    return (await answer.json()) as Record<string, unknown>;
  };

  const selected = await patch({ userHarness: "global:review-env", subagentHarness: "global:worker" });
  expect(selected.userHarness).toBe("global:review-env");
  expect(selected.subagentHarness).toBe("global:worker");

  // "Default" is null: the key is stored as nothing, so later default changes still apply.
  const cleared = await patch({ userHarness: null, subagentHarness: "" });
  expect(cleared.userHarness).toBeUndefined();
  expect(cleared.subagentHarness).toBeUndefined();
});

test("a change is created with its harness selectors in one write", async () => {
  const id = "ROUTES-created-harness";
  const created = await fetch(`${url}/api/changes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id,
      state: "Ideation",
      userHarness: "global:review-env",
      subagentHarness: "builtin:pi-bare",
    }),
  });
  expect(created.status).toBe(201);
  const read = await fetch(`${url}/api/changes/${id}`);
  expect(read.status).toBe(200);
  const record = (await read.json()) as { userHarness?: string; subagentHarness?: string };
  expect(record.userHarness).toBe("global:review-env");
  expect(record.subagentHarness).toBe("builtin:pi-bare");
});
