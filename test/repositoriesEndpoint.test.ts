import { afterAll, beforeAll, expect, test } from "bun:test";
import { checkoutsOf } from "./helpers.ts";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientError, makeChangesClient } from "@corvi/client";
import { DirectoryName, RepositoryId, ChangeId } from "@corvi/contracts/changes";
import { serve, type Serving } from "../apps/server/src/capabilities/serve.ts";
import { repositoriesRoutes } from "../apps/server/src/change/repositories-route.ts";

/**
 * The first wired slice, end to end over HTTP: the legacy record is projected read-only, the
 * workflow joins it with the checkout facts, the route encodes the DTO, and the client decodes
 * the same schema. The server and the client cannot silently disagree on the shape.
 */
let tmp: string;
let root: string;
let server: Serving;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "corvi-"));
  root = join(tmp, "changes");
  process.env.CORVI_ROOT = root;
  process.env.CORVI_ARCHIVE_ROOT = join(tmp, "changes-archive");
  await mkdir(join(root, "demo"), { recursive: true });
  await Bun.write(
    join(root, "demo", "change.json"),
    JSON.stringify(
      {
        id: "demo",
        title: "Demo",
        branch: "demo",
        checkouts: checkoutsOf(["/sources/repo"]),
        state: "Implementation",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      null,
      2,
    ) + "\n",
  );
  server = await serve({ port: 0, hostname: "127.0.0.1", routes: repositoriesRoutes });
});

afterAll(async () => {
  server?.stop();
  await rm(tmp, { recursive: true, force: true });
});

test("the dashboard read is served and decoded by the client", async () => {
  const client = makeChangesClient({ baseUrl: server.url.toString() });
  const views = await client.inspectRepositories(ChangeId.make("demo"));
  expect(views).toEqual([
    {
      repositoryId: RepositoryId.make("demo:repo"),
      directoryName: DirectoryName.make("repo"),
      state: "Active",
      checkoutLocation: join(root, "demo", "repo"),
      checkout: { _tag: "Missing" },
    },
  ]);
});

test("an unknown change is a 404 the client classifies", async () => {
  const client = makeChangesClient({ baseUrl: server.url.toString() });
  const failure = await client.inspectRepositories(ChangeId.make("absent")).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(ClientError);
  expect((failure as ClientError).status).toBe(404);
});
