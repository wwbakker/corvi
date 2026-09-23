import { test, expect, beforeAll, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { serverEnv, testRun, testTempDir, waitForUrl } from "./helpers.ts";

/**
 * Two application instances share nothing: each has its own changes root, config, built page,
 * cache file and tmux socket (`serverEnv`), and stopping one must not take the other's resources
 * with it. This is the scoped-shutdown guarantee the runtime ownership work is about, proved at
 * the process boundary — the only place two instances can genuinely be observed.
 */
let firstTmp: string;
let secondTmp: string;
let first: ReturnType<typeof Bun.spawn>;
let second: ReturnType<typeof Bun.spawn>;
let firstUrl: string;
let secondUrl: string;

const boot = (tmp: string): ReturnType<typeof Bun.spawn> =>
  Bun.spawn(["node", "apps/server/src/server.ts", `--corvi-test-run=${testRun()}`], {
    env: serverEnv(tmp),
    stdout: "pipe",
    stderr: process.env.CORVI_TEST_LOUD ? "inherit" : "ignore",
  });

beforeAll(async () => {
  firstTmp = await testTempDir("instances-a");
  secondTmp = await testTempDir("instances-b");
  first = boot(firstTmp);
  second = boot(secondTmp);
  [firstUrl, secondUrl] = await Promise.all([waitForUrl(first), waitForUrl(second)]);
});

afterAll(async () => {
  first?.kill();
  second?.kill();
  await Promise.all([first?.exited, second?.exited]);
  await rm(firstTmp, { recursive: true, force: true });
  await rm(secondTmp, { recursive: true, force: true });
});

/** A change id is created as an idea: no repositories to provision, so creation is only the
 * record, and the only question is which instance's store it lands in. */
const createIdea = async (url: string, id: string): Promise<void> => {
  const response = await fetch(`${url}/api/changes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, state: "Ideation" }),
  });
  expect(response.status).toBe(201);
};

const changeIds = async (url: string): Promise<string[]> =>
  (
    (await fetch(`${url}/api/changes`).then((r) => r.json())) as { id: string }[]
  ).map((change) => change.id);

test("changes written to one instance are invisible to the other", async () => {
  await createIdea(firstUrl, "PROJ-ONLY-A");
  const inFirst = await changeIds(firstUrl);
  const inSecond = await changeIds(secondUrl);
  expect(inFirst).toContain("PROJ-ONLY-A");
  expect(inSecond).not.toContain("PROJ-ONLY-A");
});

test("each instance has its own configuration file", async () => {
  const firstSettings = (await fetch(`${firstUrl}/api/settings`).then((r) => r.json())) as {
    path: string;
  };
  const secondSettings = (await fetch(`${secondUrl}/api/settings`).then((r) => r.json())) as {
    path: string;
  };
  expect(firstSettings.path).toContain("instances-a");
  expect(secondSettings.path).toContain("instances-b");
  expect(firstSettings.path).not.toBe(secondSettings.path);
});

test("stopping one instance leaves the other serving its own state", async () => {
  first.kill();
  await first.exited;

  // The stopped instance is gone…
  await expect(fetch(`${firstUrl}/api/changes`)).rejects.toThrow();
  // …and the survivor still answers, with the change it owns and neither of the first's files.
  const ids = await changeIds(secondUrl);
  expect(ids).not.toContain("PROJ-ONLY-A");
  expect(await createIdea(secondUrl, "PROJ-ONLY-B").then(() => changeIds(secondUrl))).toContain(
    "PROJ-ONLY-B",
  );
});
