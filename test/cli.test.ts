/**
 * The CLI: discovery, change context, and the control commands against a real isolated server.
 *
 * The commands themselves are thin, so the tests spend their weight on the parts that are not:
 * which server is chosen (and what happens when none, or several, own the change), which change a
 * bare command is about, and the exit codes a machine caller reads. The server runs in its own
 * process with the wrapper's isolated roots, exactly as the app's server does.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { instanceRecordPath } from "@corvi/configuration/node";
import { InstanceRecordSchema } from "@corvi/contracts/instance";
import { Schema } from "effect";

import { run, type Io } from "../apps/cli/src/main.ts";
import { parseArgs } from "../apps/cli/src/args.ts";
import { changeIdFromDirectory, changeIdIn, resolveChangeId } from "../apps/cli/src/change-context.ts";
import { instanceRecords, pidFilePorts, resolveServer, serverCandidates } from "../apps/cli/src/discovery.ts";
import { serverEnv, testRun, testTempDir, waitForUrl } from "./helpers.ts";

const CHANGE_ID = "CLI-1";

type Capture = {
  readonly io: Io;
  readonly out: readonly string[];
  readonly err: readonly string[];
};

const capture = (): Capture => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
};

test("parseArgs reads flags with and without values, and everything else positionally", () => {
  const args = parseArgs(["--json", "--change", "PROJ-1", "action", "run", "review", "--window=@3", "--"]);
  expect(args.positionals).toEqual(["action", "run", "review"]);
  expect(args.flags.get("json")).toBe(true);
  expect(args.flags.get("change")).toBe("PROJ-1");
  expect(args.flags.get("window")).toBe("@3");
  // `--json change list` must not read "change" as the value of "json".
  expect(parseArgs(["--json", "change", "list"]).positionals).toEqual(["change", "list"]);
});

test("changeIdIn reads only a record that carries an id", () => {
  expect(changeIdIn('{"id":"PROJ-1"}')).toBe("PROJ-1");
  expect(changeIdIn('{"id":""}')).toBeUndefined();
  expect(changeIdIn('{"branch":"x"}')).toBeUndefined();
  expect(changeIdIn("not json")).toBeUndefined();
});

test("a change is found by walking up from the working directory", async () => {
  const dir = await testTempDir("cli-context");
  try {
    await mkdir(join(dir, "a", "b"), { recursive: true });
    await writeFile(join(dir, "change.json"), JSON.stringify({ id: "PROJ-UP" }), "utf8");
    expect(await changeIdFromDirectory(join(dir, "a", "b"))).toBe("PROJ-UP");
    expect(await changeIdFromDirectory("/")).toBeUndefined();
    // The flag and the environment beat the directory.
    expect(await resolveChangeId({ flag: "FLAG", env: "ENV", cwd: dir })).toBe("FLAG");
    expect(await resolveChangeId({ env: "ENV", cwd: dir })).toBe("ENV");
    expect(await resolveChangeId({ cwd: dir })).toBe("PROJ-UP");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discovery reads instance records and pid-file ports, and orders its candidates", async () => {
  const dir = await testTempDir("cli-discovery");
  try {
    await writeFile(
      join(dir, "corvi-app-4100.json"),
      JSON.stringify({ url: "http://127.0.0.1:4100/", port: 4100, pid: 1, startedAt: "t" }),
      "utf8",
    );
    await writeFile(join(dir, "corvi-app-4101.json"), "not json", "utf8");
    await writeFile(join(dir, "corvi-app-4102.pid"), "123", "utf8");
    await writeFile(join(dir, "unrelated.json"), "{}", "utf8");

    const records = await instanceRecords(dir);
    expect(records.map((record) => record.port)).toEqual([4100]);
    expect(await pidFilePorts(dir)).toEqual([4102]);

    const candidates = await serverCandidates({
      url: "http://127.0.0.1:9000/",
      envUrl: "http://127.0.0.1:9000",
      dir,
      devPort: 4000,
    });
    // The explicit URL and CORVI_URL are the same address, so it appears once, first.
    expect(candidates.map((candidate) => candidate.url)).toEqual([
      "http://127.0.0.1:9000",
      "http://127.0.0.1:4100",
      "http://127.0.0.1:4102",
      "http://127.0.0.1:4000",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the server is chosen by what it knows, and ambiguity is an error, not a guess", async () => {
  const candidates = [
    { url: "http://a", source: "a" },
    { url: "http://b", source: "b" },
  ];
  const probeWith = (answers: Record<string, readonly string[]>) => async (url: string) => {
    const answer = answers[url];
    if (answer === undefined) throw new Error("no answer");
    return answer;
  };

  // No change named: the first server that answers at all.
  expect(
    (await resolveServer({ candidates, probe: probeWith({ "http://b": [] }) })).url,
  ).toBe("http://b");

  // A change named: exactly the server that owns it.
  expect(
    (
      await resolveServer({
        candidates,
        changeId: CHANGE_ID,
        probe: probeWith({ "http://a": ["OTHER"], "http://b": [CHANGE_ID] }),
      })
    ).url,
  ).toBe("http://b");

  // None owns it: refused, and the message names the addresses that did answer.
  await expect(
    resolveServer({ candidates, changeId: CHANGE_ID, probe: probeWith({ "http://a": [], "http://b": [] }) }),
  ).rejects.toThrow(/no server owns change/);

  // Several own it: refused, and the message names them.
  await expect(
    resolveServer({
      candidates,
      changeId: CHANGE_ID,
      probe: probeWith({ "http://a": [CHANGE_ID], "http://b": [CHANGE_ID] }),
    }),
  ).rejects.toThrow(/several servers own change/);

  // Nobody answered: refused as unreachable, not as "no change".
  await expect(resolveServer({ candidates, probe: probeWith({}) })).rejects.toThrow(/no Corvi server answered/);
});

// --- Against a real server -------------------------------------------------------------------

let tmp: string;
let server: ReturnType<typeof Bun.spawn>;
let baseUrl: string;
let savedStateHome: string | undefined;

beforeAll(async () => {
  tmp = await testTempDir("cli-server");
  savedStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(tmp, "state");

  // A change record on disk where the server reads them, so the commands have something to act
  // on without provisioning a worktree.
  const dir = join(tmp, "changes", CHANGE_ID);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "change.json"),
    JSON.stringify({
      id: CHANGE_ID,
      branch: CHANGE_ID,
      title: "CLI test",
      state: "Ideation",
      createdAt: "2026-01-01T00:00:00.000Z",
      formatVersion: 2,
    }),
    "utf8",
  );

  server = Bun.spawn(["node", "apps/server/src/server.ts", `--corvi-test-run=${testRun()}`], {
    cwd: resolve("."),
    env: serverEnv(tmp),
    stdout: "pipe",
    stderr: "pipe",
  });
  baseUrl = await waitForUrl(server);
});

afterAll(async () => {
  server?.kill();
  await server?.exited;
  if (savedStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedStateHome;
  await rm(tmp, { recursive: true, force: true });
});

test("the server records itself for discovery, and the record parses", async () => {
  const port = Number(new URL(baseUrl).port);
  const text = await readFile(instanceRecordPath(port), "utf8");
  const record = Schema.decodeUnknownSync(InstanceRecordSchema)(JSON.parse(text));
  expect(record.port).toBe(port);
  expect(record.url).toContain(baseUrl);
  expect(record.pid).toBeGreaterThan(0);
});

test("change list and show answer with the change record", async () => {
  const list = capture();
  expect(await run(["--server", baseUrl, "change", "list", "--json"], list.io)).toBe(0);
  const parsed = JSON.parse(list.out.join("")) as { id: string }[];
  expect(parsed.map((change) => change.id)).toContain(CHANGE_ID);

  const show = capture();
  expect(await run(["--server", baseUrl, "--change", CHANGE_ID, "change", "show", "--json"], show.io)).toBe(0);
  expect((JSON.parse(show.out.join("")) as { state: string }).state).toBe("Ideation");
});

test("change phase sets the state, and the transition rules still refuse the illegal ones", async () => {
  const phase = capture();
  expect(
    await run(["--server", baseUrl, "--change", CHANGE_ID, "change", "phase", "Implementation", "--json"], phase.io),
  ).toBe(0);
  expect((JSON.parse(phase.out.join("")) as { state: string }).state).toBe("Implementation");

  const bad = capture();
  expect(
    await run(["--server", baseUrl, "--change", CHANGE_ID, "change", "phase", "Sideways", "--json"], bad.io),
  ).toBe(2);
  expect(bad.err.join("")).toContain("Ideation");
});

test("action list answers with the discoverable actions", async () => {
  const list = capture();
  expect(await run(["--server", baseUrl, "--change", CHANGE_ID, "action", "list", "--json"], list.io)).toBe(0);
  expect(Array.isArray(JSON.parse(list.out.join("")))).toBe(true);
});

test("an unknown change is a refusal (4), not a crash", async () => {
  const missing = capture();
  expect(await run(["--server", baseUrl, "--change", "NOPE", "change", "show"], missing.io)).toBe(4);
  expect(missing.err.join("")).toContain("NOPE");
});

test("a change command without a change is a usage error (2)", async () => {
  const none = capture();
  // No --change, no CORVI_CHANGE_ID, and a working directory with no change.json above it.
  expect(await run(["--server", baseUrl, "change", "show"], none.io, { cwd: "/", env: {} })).toBe(2);
  expect(none.err.join("")).toContain("no change given");
});

test("discovery finds the server from its own record, with no URL flag or environment", async () => {
  const found = capture();
  const code = await run(["change", "list", "--json"], found.io, {
    env: { CORVI_CHANGE_ID: CHANGE_ID },
  });
  expect(code).toBe(0);
  expect(JSON.parse(found.out.join("")) as { id: string }[]).toBeArray();
});
