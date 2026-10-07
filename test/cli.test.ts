/**
 * The CLI: discovery, change context, and the control commands against a real isolated server.
 *
 * The commands themselves are thin, so the tests spend their weight on the parts that are not:
 * which server is chosen (and what happens when none, or several, own the change), which change a
 * bare command is about, and the exit codes a machine caller reads. The server runs in its own
 * process with the wrapper's isolated roots, exactly as the app's server does.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { instanceRecordPath } from "@corvi/configuration/node";
import { InstanceRecordSchema } from "@corvi/contracts/instance";
import { ClientError } from "@corvi/client";
import { Schema } from "effect";

import { run, COMMANDS, GROUP_HELP, needsChange, repositoryForceRefusal, type Io } from "../apps/cli/src/main.ts";
import { parseArgs } from "../apps/cli/src/args.ts";
import { EXIT } from "../apps/cli/src/errors.ts";
import { changeIdFromDirectory, changeIdIn, resolveChangeId } from "../apps/cli/src/change-context.ts";
import {
  PROBE_TIMEOUT_LIVE_MS,
  instanceRecords,
  pidFilePorts,
  resolveServer,
  serverCandidates,
  type Candidate,
} from "../apps/cli/src/discovery.ts";
import { pruneInstanceRecords } from "../apps/server/src/app-root/instance.ts";
import { runSh, serverEnv, testRun, testTempDir, waitForUrl } from "./helpers.ts";

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
    // A record whose server is gone: the pid is not a running process.
    await writeFile(
      join(dir, "corvi-app-4099.json"),
      JSON.stringify({ url: "http://127.0.0.1:4099/", port: 4099, pid: 999_999_999, startedAt: "t" }),
      "utf8",
    );
    await writeFile(join(dir, "corvi-app-4101.json"), "not json", "utf8");
    await writeFile(join(dir, "corvi-app-4102.pid"), String(process.pid), "utf8");
    // A pid-file whose process is gone is skipped rather than probed.
    await writeFile(join(dir, "corvi-app-4103.pid"), "999999999", "utf8");
    await writeFile(join(dir, "unrelated.json"), "{}", "utf8");

    const records = await instanceRecords(dir);
    // The live record first, then the dead one; the record that does not parse is dropped.
    expect(records.map((record) => [record.port, record.live])).toEqual([
      [4100, true],
      [4099, false],
    ]);
    expect(await pidFilePorts(dir)).toEqual([4102]); // 4103's process is gone

    const candidates = await serverCandidates({
      url: "http://127.0.0.1:9000/",
      envUrl: "http://127.0.0.1:9000",
      dir,
      devPort: 4000,
    });
    // The explicit URL and CORVI_URL are the same address, so it appears once, first. The dead
    // record is skipped rather than probed, and the live one carries the longer deadline.
    expect(candidates.map((candidate) => candidate.url)).toEqual([
      "http://127.0.0.1:9000",
      "http://127.0.0.1:4100",
      "http://127.0.0.1:4102",
      "http://127.0.0.1:4000",
    ]);
    expect(candidates.find((candidate) => candidate.url === "http://127.0.0.1:4100")?.timeoutMs).toBe(
      PROBE_TIMEOUT_LIVE_MS,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a starting server prunes the discovery records whose pid is dead", async () => {
  const dir = await testTempDir("cli-prune");
  try {
    await writeFile(
      join(dir, "corvi-app-4200.json"),
      JSON.stringify({ url: "http://127.0.0.1:4200", port: 4200, pid: process.pid, startedAt: "t" }),
      "utf8",
    );
    await writeFile(
      join(dir, "corvi-app-4201.json"),
      JSON.stringify({ url: "http://127.0.0.1:4201", port: 4201, pid: 999_999_999, startedAt: "t" }),
      "utf8",
    );
    await writeFile(join(dir, "corvi-app-4202.json"), "not json", "utf8");
    await pruneInstanceRecords(dir);
    const remaining = await readdir(dir);
    expect(remaining).toContain("corvi-app-4200.json"); // our own pid: live
    expect(remaining).not.toContain("corvi-app-4201.json"); // dead: swept
    expect(remaining).toContain("corvi-app-4202.json"); // unparseable: left for a human
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the server is chosen by what it knows, and ambiguity is an error, not a guess", async () => {
  const candidates = [
    { url: "http://a", source: "a", priority: 2 },
    { url: "http://b", source: "b", priority: 2 },
  ];
  const probeWith = (answers: Record<string, readonly string[]>) => async (candidate: Candidate) => {
    const answer = answers[candidate.url];
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

  // An explicit address (--server/CORVI_URL) wins even when another server owns the change.
  expect(
    (
      await resolveServer({
        candidates: [
          { url: "http://named", source: "--server", priority: 0 },
          { url: "http://b", source: "record", priority: 2 },
        ],
        changeId: CHANGE_ID,
        probe: probeWith({ "http://named": ["OTHER"], "http://b": [CHANGE_ID] }),
      })
    ).url,
  ).toBe("http://named");

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
let repo: string;
let server: ReturnType<typeof Bun.spawn>;
let baseUrl: string;
let savedStateHome: string | undefined;

beforeAll(async () => {
  tmp = await testTempDir("cli-server");
  savedStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(tmp, "state");

  // A change record on disk where the server reads them, so the commands have something to act
  // on without provisioning a worktree — plus one real checkout for the repository profile
  // commands: `checkoutFor` resolves the worktree on the change's branch, and a committed
  // `git init -b <branch>` repo is its own worktree.
  const dir = join(tmp, "changes", CHANGE_ID);
  await mkdir(dir, { recursive: true });
  repo = join(tmp, "repo");
  await runSh(["git", "init", "-b", CHANGE_ID, repo]);
  await writeFile(join(repo, "README.md"), "hi\n");
  await runSh(["git", "add", "."], repo);
  await runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], repo);
  await writeFile(
    join(dir, "change.json"),
    JSON.stringify({
      id: CHANGE_ID,
      branch: CHANGE_ID,
      title: "CLI test",
      state: "Ideation",
      createdAt: "2026-01-01T00:00:00.000Z",
      formatVersion: 2,
      checkouts: [{ path: repo, location: "original", branch: { kind: "change" } }],
    }),
    "utf8",
  );

  server = Bun.spawn(["node", "apps/server/src/server.ts", `--corvi-test-run=${testRun()}`], {
    cwd: resolve("."),
    // The short poll makes an await's horizon (`CORVI_SUBAGENT_POLL_MS`) reachable in a test;
    // nothing here parks long enough to notice.
    env: serverEnv(tmp, { CORVI_SUBAGENT_POLL_MS: "300" }),
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
  // The seeded change is an idea: its only way out is starting the work, so the matrix refuses
  // a jump straight to Verification (the same `allowedTransition` the lifecycle workflow uses).
  const illegal = capture();
  expect(
    await run(["--server", baseUrl, "--change", CHANGE_ID, "change", "phase", "Verification", "--json"], illegal.io),
  ).toBe(4);

  const phase = capture();
  expect(
    await run(["--server", baseUrl, "--change", CHANGE_ID, "change", "phase", "Implementation", "--json"], phase.io),
  ).toBe(0);
  expect((JSON.parse(phase.out.join("")) as { state: string }).state).toBe("Implementation");

  // From Implementation the manual phases move among themselves.
  const verify = capture();
  expect(
    await run(["--server", baseUrl, "--change", CHANGE_ID, "change", "phase", "Verification", "--json"], verify.io),
  ).toBe(0);

  const bad = capture();
  expect(
    await run(["--server", baseUrl, "--change", CHANGE_ID, "change", "phase", "Sideways", "--json"], bad.io),
  ).toBe(2);
  expect(bad.err.join("")).toContain("Ideation");
});

test("change create maps argv to the body, always as an idea, with the recipe", async () => {
  const created = capture();
  const code = await run(
    [
      "--server", baseUrl, "change", "create", "CLI-NEW",
      "--title", "A new idea", "--branch", "CLI-NEW-work", "--workspace", "default", "--json",
    ],
    created.io,
  );
  expect(code).toBe(0);
  const body = JSON.parse(created.out.join("")) as {
    change: { id: string; title?: string; branch: string; workspace?: string; state?: string };
    provision: unknown[];
    refresh: unknown[];
    changeDir?: string;
    next: string[];
  };
  // The route body, decoded as the CLI prints it: the id is positional, the flags carried.
  expect(body.change.id).toBe("CLI-NEW");
  expect(body.change.title).toBe("A new idea");
  expect(body.change.branch).toBe("CLI-NEW-work");
  expect(body.change.workspace).toBe("default");
  expect(body.change.state).toBe("Ideation");
  expect(body.provision).toBeArray();
  expect(body.refresh).toBeArray();
  // `next` is the CLI's own addition, naming the directory the route reported.
  const dir = join(tmp, "changes", "CLI-NEW");
  expect(body.changeDir).toBe(dir);
  expect(body.next).toEqual([
    `write ${dir}/PLAN.md — the change's plan document`,
    "corvi change repository add <path> --change CLI-NEW",
    "corvi change start --change CLI-NEW",
  ]);
});

test("change create prints the recipe in its human output", async () => {
  const created = capture();
  expect(
    await run(["--server", baseUrl, "change", "create", "CLI-HUMAN", "--title", "Human output"], created.io),
  ).toBe(0);
  const lines = created.out.join("\n");
  expect(lines).toContain("created CLI-HUMAN (Ideation)");
  expect(lines).toContain("next:");
  expect(lines).toContain(`write ${join(tmp, "changes", "CLI-HUMAN")}/PLAN.md`);
});

test("change create needs an id and a title (usage 2)", async () => {
  const noId = capture();
  expect(await run(["--server", baseUrl, "change", "create", "--title", "x"], noId.io, { env: {} })).toBe(2);
  expect(noId.err.join("")).toContain("needs an id");

  const noTitle = capture();
  expect(
    await run(["--server", baseUrl, "change", "create", "CLI-NOTITLE"], noTitle.io, { env: {} }),
  ).toBe(2);
  expect(noTitle.err.join("")).toContain("--title");
});

test("change create ignores an ambient change when choosing the server", async () => {
  // Discovery has one answering server, and uses it even for a change it does not own, so this
  // only proves create is not blocked by an ambient id; the real gate is `needsChange`, asserted
  // below. Both the env and the flag form funnel through it.
  const ambient = capture();
  const code = await run(
    ["change", "create", "CLI-EXEMPT", "--title", "No ambient", "--json"],
    ambient.io,
    { env: { CORVI_CHANGE_ID: "NOT-MINE" } },
  );
  expect(code).toBe(0);
  expect((JSON.parse(ambient.out.join("")) as { change: { id: string } }).change.id).toBe("CLI-EXEMPT");

  const flagged = capture();
  expect(
    await run(
      ["--server", baseUrl, "--change", "NOT-MINE", "change", "create", "CLI-EXEMPT-FLAG", "--title", "No ambient", "--json"],
      flagged.io,
      { env: {} },
    ),
  ).toBe(0);
  expect((JSON.parse(flagged.out.join("")) as { change: { id: string } }).change.id).toBe("CLI-EXEMPT-FLAG");
});

test("needsChange is false for the change-less commands", () => {
  // The unit that decides whether an ambient change constrains discovery; the integration test
  // above cannot see it through a lone answering server.
  expect(needsChange(["change", "list"])).toBe(false);
  expect(needsChange(["change", "create"])).toBe(false);
  expect(needsChange(["change", "show"])).toBe(true);
});

test("a repository 409 is rewritten only when it carries a force question", () => {
  // A too-new record's write conflict has no `needsForce`: the server's message and status must
  // pass through, not become a `--force` sentence. `undefined` is what lets `report` do that.
  expect(
    repositoryForceRefusal(
      new ClientError({
        status: 409,
        message: "written by a newer version of Corvi — upgrade to edit it",
      }),
    ),
  ).toBeUndefined();
  expect(
    repositoryForceRefusal(
      new ClientError({ status: 409, message: "Conflict", body: { needsForce: [] } }),
    ),
  ).toBeUndefined();

  // A genuine force question names the checkouts and says `--force`; add can ask too.
  const refusal = repositoryForceRefusal(
    new ClientError({ status: 409, message: "Conflict", body: { needsForce: ["repo-two", "repo-three"] } }),
  );
  expect(refusal?.exitCode).toBe(EXIT.refused);
  expect(refusal?.message).toContain("repo-two, repo-three");
  expect(refusal?.message).toContain("--force");
  // A non-409 is not a force question either.
  expect(repositoryForceRefusal(new ClientError({ status: 500, message: "boom" }))).toBeUndefined();
});

test("change create validates before discovery: usage 2 beats an unreachable server, 3 is no server", async () => {
  // Isolate discovery: an empty state dir (no records, no pid-files) and an unreachable dev
  // default, so the only candidate is the address named and nothing can answer it.
  const state = await testTempDir("cli-no-server");
  const saved = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = state;
  try {
    const noTitle = capture();
    expect(
      await run(["--server", "http://127.0.0.1:1", "change", "create", "CLI-UNREACHABLE"], noTitle.io, {
        env: { CORVI_PORT: "1" },
      }),
    ).toBe(2);
    expect(noTitle.err.join("")).toContain("--title");

    const unreachable = capture();
    expect(
      await run(
        ["--server", "http://127.0.0.1:1", "change", "create", "CLI-UNREACHABLE", "--title", "x"],
        unreachable.io,
        { env: { CORVI_PORT: "1" } },
      ),
    ).toBe(3);
    expect(unreachable.err.join("")).toContain("no Corvi server answered");
  } finally {
    if (saved === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = saved;
    await rm(state, { recursive: true, force: true });
  }
});

test("change create refuses an id that is taken (4)", async () => {
  const taken = capture();
  expect(
    await run(["--server", baseUrl, "change", "create", CHANGE_ID, "--title", "Duplicate", "--json"], taken.io),
  ).toBe(4);
  expect(taken.err.join("")).toContain(CHANGE_ID);
});

test("a created change is listable afterwards", async () => {
  const created = capture();
  expect(
    await run(["--server", baseUrl, "change", "create", "CLI-LISTED", "--title", "Listable"], created.io),
  ).toBe(0);
  const list = capture();
  expect(await run(["--server", baseUrl, "change", "list", "--json"], list.io)).toBe(0);
  expect((JSON.parse(list.out.join("")) as { id: string }[]).map((change) => change.id)).toContain("CLI-LISTED");
});

test("change repository list shows the seeded checkout", async () => {
  const list = capture();
  expect(
    await run(["--server", baseUrl, "--change", CHANGE_ID, "change", "repository", "list", "--json"], list.io),
  ).toBe(0);
  const states = JSON.parse(list.out.join("")) as {
    name: string;
    path: string;
    location: string;
    branch: { kind: string };
  }[];
  expect(states.find((state) => state.name === basename(repo))).toMatchObject({
    path: repo,
    location: "original",
    branch: { kind: "change" },
  });
});

test("change repository add then list shows it, and remove by name drops it", async () => {
  // A second real repository: `add` resolves the path and the server creates a worktree for it.
  const second = join(tmp, "repository-two");
  await runSh(["git", "init", "-b", "main", second]);
  await writeFile(join(second, "README.md"), "two\n");
  await runSh(["git", "add", "."], second);
  await runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], second);

  const added = capture();
  expect(
    await run(
      ["--server", baseUrl, "--change", CHANGE_ID, "change", "repository", "add", second, "--json"],
      added.io,
    ),
  ).toBe(0);
  // `--json` is the route shape: the change, what was provisioned and refreshed.
  const body = JSON.parse(added.out.join("")) as {
    change: { checkouts?: { path: string }[] };
    provision: unknown[];
    refresh: unknown[];
  };
  expect(body.provision).toBeArray();
  expect(body.refresh).toBeArray();
  expect(body.change.checkouts?.map((checkout) => checkout.path)).toContain(second);

  const listed = capture();
  expect(
    await run(["--server", baseUrl, "--change", CHANGE_ID, "change", "repository", "list", "--json"], listed.io),
  ).toBe(0);
  expect((JSON.parse(listed.out.join("")) as { name: string }[]).map((state) => state.name)).toContain(
    basename(second),
  );

  const removed = capture();
  expect(
    await run(
      ["--server", baseUrl, "--change", CHANGE_ID, "change", "repository", "remove", basename(second), "--json"],
      removed.io,
    ),
  ).toBe(0);
  const after = capture();
  expect(
    await run(["--server", baseUrl, "--change", CHANGE_ID, "change", "repository", "list", "--json"], after.io),
  ).toBe(0);
  expect((JSON.parse(after.out.join("")) as { name: string }[]).map((state) => state.name)).not.toContain(
    basename(second),
  );
});

test("change repository remove refuses an unknown name (4)", async () => {
  const missing = capture();
  expect(
    await run(
      ["--server", baseUrl, "--change", CHANGE_ID, "change", "repository", "remove", "no-such-repo", "--json"],
      missing.io,
    ),
  ).toBe(4);
  expect(missing.err.join("")).toContain("no-such-repo");
});

test("change repository remove asks to force when the worktree has unpushed work (4)", async () => {
  const third = join(tmp, "repository-three");
  await runSh(["git", "init", "-b", "main", third]);
  await writeFile(join(third, "README.md"), "three\n");
  await runSh(["git", "add", "."], third);
  await runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], third);

  expect(
    await run(
      ["--server", baseUrl, "--change", CHANGE_ID, "change", "repository", "add", third, "--json"],
      capture().io,
    ),
  ).toBe(0);

  // A commit only the worktree has: a removal would lose it, so the server asks first.
  const worktree = join(tmp, "changes", CHANGE_ID, basename(third));
  await writeFile(join(worktree, "work.txt"), "only here\n");
  await runSh(["git", "add", "."], worktree);
  await runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "work"], worktree);

  const refused = capture();
  expect(
    await run(
      ["--server", baseUrl, "--change", CHANGE_ID, "change", "repository", "remove", basename(third), "--json"],
      refused.io,
    ),
  ).toBe(4);
  expect(refused.err.join("")).toContain("--force");

  const forced = capture();
  expect(
    await run(
      ["--server", baseUrl, "--change", CHANGE_ID, "change", "repository", "remove", basename(third), "--force", "--json"],
      forced.io,
    ),
  ).toBe(0);
});

test("change repository flag rules are usage errors before any probe", async () => {
  // Isolate discovery: nothing can answer, so a rule checked after it would show as exit 3.
  const state = await testTempDir("cli-repo-usage");
  const saved = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = state;
  try {
    const base = ["--server", "http://127.0.0.1:1", "--change", CHANGE_ID, "change", "repository", "add", repo];
    const cases: readonly (readonly [string[], string])[] = [
      [[...base, "--location", "sideways"], "--location"],
      [[...base, "--branch", "existing"], "--branch-name"],
      [[...base, "--branch", "existing", "--branch-name", "   "], "--branch-name"],
      [[...base, "--branch-name", "x"], "--branch-name"],
      [[...base, "--branch", "current"], "new worktree"],
    ];
    for (const [argv, needle] of cases) {
      const failed = capture();
      expect(await run(argv, failed.io, { env: { CORVI_PORT: "1" } })).toBe(2);
      expect(failed.err.join("")).toContain(needle);
    }
  } finally {
    if (saved === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = saved;
    await rm(state, { recursive: true, force: true });
  }
});

test("change repository add upserts a path, and list prints the five fields", async () => {
  const upsert = join(tmp, "repository-upsert");
  await runSh(["git", "init", "-b", "main", upsert]);
  await writeFile(join(upsert, "README.md"), "upsert\n");
  await runSh(["git", "add", "."], upsert);
  await runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], upsert);

  expect(
    await run(
      ["--server", baseUrl, "--change", CHANGE_ID, "change", "repository", "add", upsert, "--json"],
      capture().io,
    ),
  ).toBe(0);
  // The same path again with a base: it replaces the entry rather than appending a second one.
  expect(
    await run(
      ["--server", baseUrl, "--change", CHANGE_ID, "change", "repository", "add", upsert, "--base", "main", "--json"],
      capture().io,
    ),
  ).toBe(0);

  const listed = capture();
  expect(
    await run(["--server", baseUrl, "--change", CHANGE_ID, "change", "repository", "list", "--json"], listed.io),
  ).toBe(0);
  const matching = (JSON.parse(listed.out.join("")) as { name: string; base?: string }[]).filter(
    (state) => state.name === basename(upsert),
  );
  expect(matching).toHaveLength(1);
  expect(matching[0]!.base).toBe("main");
});

test("change repository list prints name, location, branch, base and target", async () => {
  const existing = join(tmp, "repository-existing");
  await runSh(["git", "init", "-b", "main", existing]);
  await writeFile(join(existing, "README.md"), "existing\n");
  await runSh(["git", "add", "."], existing);
  await runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], existing);
  await runSh(["git", "branch", "feature"], existing);

  expect(
    await run(
      [
        "--server", baseUrl, "--change", CHANGE_ID, "change", "repository", "add", existing,
        "--branch", "existing", "--branch-name", "feature", "--base", "main", "--target", "main", "--json",
      ],
      capture().io,
    ),
  ).toBe(0);

  const listed = capture();
  expect(
    await run(["--server", baseUrl, "--change", CHANGE_ID, "change", "repository", "list"], listed.io),
  ).toBe(0);
  const line = listed.out
    .join("\n")
    .split("\n")
    .find((one) => one.startsWith(basename(existing)));
  expect(line).toBe(`${basename(existing)}\tnew\texisting:feature\tmain\tmain`);
});

test("change repository add supports the original/current pairing", async () => {
  // The one location/branch cell the other cases leave out: a repository used where it is, on
  // whatever branch it already has.
  expect(
    await run(
      [
        "--server", baseUrl, "--change", CHANGE_ID, "change", "repository", "add", repo,
        "--location", "original", "--branch", "current", "--force", "--json",
      ],
      capture().io,
    ),
  ).toBe(0);

  const listed = capture();
  expect(
    await run(["--server", baseUrl, "--change", CHANGE_ID, "change", "repository", "list", "--json"], listed.io),
  ).toBe(0);
  const state = (
    JSON.parse(listed.out.join("")) as { name: string; location: string; branch: { kind: string } }[]
  ).find((one) => one.name === basename(repo));
  expect(state).toMatchObject({ location: "original", branch: { kind: "current" } });
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

test("a --json refusal is a JSON envelope on stderr with the status", async () => {
  const missing = capture();
  expect(
    await run(["--server", baseUrl, "--change", "NOPE", "change", "show", "--json"], missing.io),
  ).toBe(4);
  const envelope = JSON.parse(missing.err.join("")) as { error: string; exitCode: number; status: number };
  expect(envelope.exitCode).toBe(4);
  expect(envelope.status).toBe(404);
  expect(envelope.error).toContain("NOPE");
});

test("CORVI_URL is honoured through the CLI", async () => {
  const viaEnv = capture();
  const code = await run(["change", "list", "--json"], viaEnv.io, {
    env: { CORVI_URL: baseUrl, CORVI_CHANGE_ID: CHANGE_ID },
  });
  expect(code).toBe(0);
  expect(JSON.parse(viaEnv.out.join("")) as { id: string }[]).toBeArray();
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

test("subagent commands drive an instance over the HTTP API", async () => {
  // Seed an instance directly: create would launch a real harness. The rest — list, next, the
  // interrupted turn, the relayed reply, the result — is the API the extension and the CLI use.
  const dir = join(tmp, "changes", CHANGE_ID, "subagents", "seed-1");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "session.json"),
    JSON.stringify({
      id: "seed-1",
      changeId: CHANGE_ID,
      profile: "builtin:reviewer",
      label: "Reviewer",
      harness: "pi",
      createdBy: "orchestrator",
      createdAt: "2026-01-01T00:00:00.000Z",
      log: [{ kind: "created", at: "2026-01-01T00:00:00.000Z" }],
    }),
    "utf8",
  );
  await writeFile(
    join(dir, "001-orchestrator.md"),
    "---\nfrom: orchestrator\nat: 2026-01-01T00:00:00.000Z\n---\nReview it\n",
    "utf8",
  );

  const listed = capture();
  expect(await run(["--server", baseUrl, "--change", CHANGE_ID, "subagent", "list", "--json"], listed.io)).toBe(0);
  expect((JSON.parse(listed.out.join("")) as { id: string }[]).map((one) => one.id)).toContain("seed-1");

  const first = capture();
  expect(
    await run(["--server", baseUrl, "--change", CHANGE_ID, "subagent", "next", "--subagent", "seed-1", "--json"], first.io),
  ).toBe(0);
  expect((JSON.parse(first.out.join("")) as { status: string }).status).toBe("message");

  // The turn is in flight: a second next says so, with the lost/interrupted exit code.
  const second = capture();
  expect(
    await run(["--server", baseUrl, "--change", CHANGE_ID, "subagent", "next", "--subagent", "seed-1", "--json"], second.io),
  ).toBe(5);

  // An in-flight turn with no live window is interrupted to `await` too (exit 5), with the turn
  // it concerns in the outcome.
  const waited = capture();
  expect(
    await run(["--server", baseUrl, "--change", CHANGE_ID, "subagent", "await", "seed-1", "--json"], waited.io),
  ).toBe(5);
  const interrupted = JSON.parse(waited.out.join("")) as {
    status: string;
    outcomes: readonly { readonly id: string; readonly status: string; readonly turn?: number }[];
  };
  expect(interrupted.status).toBe("interrupted");
  expect(interrupted.outcomes).toEqual([{ id: "seed-1", status: "interrupted", turn: 1 }]);
  // The human line names the in-flight turn too.
  const interruptedHuman = capture();
  expect(
    await run(["--server", baseUrl, "--change", CHANGE_ID, "subagent", "await", "seed-1"], interruptedHuman.io),
  ).toBe(5);
  expect(interruptedHuman.out.join("\n")).toBe("interrupted seed-1 (turn 1)");

  // The flag form of send works as well as the positional form, and the receipt names the message.
  const sent = capture();
  expect(
    await run(
      ["--server", baseUrl, "--change", CHANGE_ID, "subagent", "send", "--subagent", "seed-1", "More please"],
      sent.io,
    ),
  ).toBe(0);
  expect(sent.out.join("\n")).toBe("sent to seed-1 (message 2)");

  const turned = capture();
  expect(
    await run(
      ["--server", baseUrl, "--change", CHANGE_ID, "subagent", "turn", "--subagent", "seed-1", "--in-reply-to", "1", "Looks good", "--json"],
      turned.io,
    ),
  ).toBe(0);
  expect((JSON.parse(turned.out.join("")) as { inReplyTo?: number }).inReplyTo).toBe(1);

  const result = capture();
  expect(
    await run(["--server", baseUrl, "--change", CHANGE_ID, "subagent", "result", "seed-1", "--json"], result.io),
  ).toBe(0);
  expect((JSON.parse(result.out.join("")) as { body: string }).body).toBe("Looks good");
  // The plain result prints the same "answers turn" header the manual documents.
  const resultHuman = capture();
  expect(
    await run(["--server", baseUrl, "--change", CHANGE_ID, "subagent", "result", "seed-1"], resultHuman.io),
  ).toBe(0);
  expect(resultHuman.out[0]).toContain("reply 3 (answers turn 1)");

  // `--turn` reads the reply for that turn instead of the latest. An explicit turn whose reply is
  // on disk answers ready even though the window is gone and a newer message is pending.
  const explicit = capture();
  expect(
    await run(
      ["--server", baseUrl, "--change", CHANGE_ID, "subagent", "await", "--subagent", "seed-1", "--turn=1"],
      explicit.io,
    ),
  ).toBe(0);
  expect(explicit.out.join("\n")).toBe("ready seed-1 (replied turn 1, reply 3)");

  const forTurn = capture();
  expect(
    await run(
      ["--server", baseUrl, "--change", CHANGE_ID, "subagent", "result", "--subagent", "seed-1", "--turn=1"],
      forTurn.io,
    ),
  ).toBe(0);
  expect(forTurn.out[0]).toContain("reply 3 (answers turn 1)");

  // A known inbound turn whose reply has not landed is null / "no reply yet", not an error; a turn
  // that names no inbound message is refused (4), mirroring `await --turn`.
  const noReply = capture();
  expect(
    await run(["--server", baseUrl, "--change", CHANGE_ID, "subagent", "result", "seed-1", "--turn", "2", "--json"], noReply.io),
  ).toBe(0);
  expect(noReply.out.join("")).toBe("null");
  const noReplyHuman = capture();
  expect(
    await run(["--server", baseUrl, "--change", CHANGE_ID, "subagent", "result", "seed-1", "--turn", "2"], noReplyHuman.io),
  ).toBe(0);
  expect(noReplyHuman.out.join("\n")).toBe("(no reply for turn 2 yet)");
  const unknown = capture();
  expect(
    await run(["--server", baseUrl, "--change", CHANGE_ID, "subagent", "result", "seed-1", "--turn", "9", "--json"], unknown.io),
  ).toBe(EXIT.refused);
});

test("subagent create prints the first message number it sent", async () => {
  // A seeded instance carrying an idempotency key: the create route returns it without launching a
  // harness, which is what lets the receipt be read here rather than on a real pi window.
  const dir = join(tmp, "changes", CHANGE_ID, "subagents", "seed-created");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "session.json"),
    JSON.stringify({
      id: "seed-created",
      changeId: CHANGE_ID,
      profile: "builtin:reviewer",
      label: "Reviewer",
      harness: "pi",
      createdBy: "orchestrator",
      createdAt: "2026-01-01T00:00:00.000Z",
      window: "seed-created-window",
      createdKey: "create-receipt",
      log: [{ kind: "created", at: "2026-01-01T00:00:00.000Z" }],
    }),
    "utf8",
  );
  await writeFile(
    join(dir, "001-orchestrator.md"),
    "---\nfrom: orchestrator\nat: 2026-01-01T00:00:00.000Z\n---\nReview it\n",
    "utf8",
  );

  const created = capture();
  expect(
    await run(
      ["--server", baseUrl, "--change", CHANGE_ID, "subagent", "create", "global:reviewer", "--idempotency-key", "create-receipt"],
      created.io,
    ),
  ).toBe(0);
  expect(created.out.join("\n")).toBe("created seed-created (message 1)");
});

test("subagent await prints one line per outcome, with the turn and reply", async () => {
  const replied = join(tmp, "changes", CHANGE_ID, "subagents", "seed-3");
  await mkdir(replied, { recursive: true });
  await writeFile(
    join(replied, "session.json"),
    JSON.stringify({
      id: "seed-3",
      changeId: CHANGE_ID,
      profile: "builtin:reviewer",
      label: "Reviewer",
      harness: "pi",
      createdBy: "orchestrator",
      createdAt: "2026-01-01T00:00:00.000Z",
      window: "seed-3-window",
      deliveredThrough: 1,
      log: [{ kind: "created", at: "2026-01-01T00:00:00.000Z" }],
    }),
    "utf8",
  );
  await writeFile(
    join(replied, "001-orchestrator.md"),
    "---\nfrom: orchestrator\nat: 2026-01-01T00:00:00.000Z\n---\nReview it\n",
    "utf8",
  );
  await writeFile(
    join(replied, "002-subagent.md"),
    "---\nfrom: subagent\nat: 2026-01-01T00:00:01.000Z\nin_reply_to: 1\n---\nLooks good\n",
    "utf8",
  );
  // A message-less instance with nothing pending: idle with no turn to name.
  const idle = join(tmp, "changes", CHANGE_ID, "subagents", "seed-4");
  await mkdir(idle, { recursive: true });
  await writeFile(
    join(idle, "session.json"),
    JSON.stringify({
      id: "seed-4",
      changeId: CHANGE_ID,
      profile: "builtin:reviewer",
      label: "Reviewer",
      harness: "pi",
      createdBy: "orchestrator",
      createdAt: "2026-01-01T00:00:00.000Z",
      window: "seed-4-window",
      log: [{ kind: "created", at: "2026-01-01T00:00:00.000Z" }],
    }),
    "utf8",
  );

  const single = capture();
  expect(await run(["--server", baseUrl, "--change", CHANGE_ID, "subagent", "await", "seed-3"], single.io)).toBe(0);
  expect(single.out.join("\n")).toBe("ready seed-3 (replied turn 1, reply 2)");

  const all = capture();
  expect(
    await run(
      ["--server", baseUrl, "--change", CHANGE_ID, "subagent", "await", "seed-3", "seed-4", "--all"],
      all.io,
    ),
  ).toBe(0);
  expect(all.out.join("\n")).toBe("ready seed-3 (replied turn 1, reply 2)\nready seed-4 (idle)");

  // A window gone with its prompt still undelivered: the lost answer names the pending turn.
  const gone = join(tmp, "changes", CHANGE_ID, "subagents", "seed-5");
  await mkdir(gone, { recursive: true });
  await writeFile(
    join(gone, "session.json"),
    JSON.stringify({
      id: "seed-5",
      changeId: CHANGE_ID,
      profile: "builtin:reviewer",
      label: "Reviewer",
      harness: "pi",
      createdBy: "orchestrator",
      createdAt: "2026-01-01T00:00:00.000Z",
      log: [{ kind: "created", at: "2026-01-01T00:00:00.000Z" }],
    }),
    "utf8",
  );
  await writeFile(
    join(gone, "001-orchestrator.md"),
    "---\nfrom: orchestrator\nat: 2026-01-01T00:00:00.000Z\n---\nReview it\n",
    "utf8",
  );
  const lost = capture();
  expect(await run(["--server", baseUrl, "--change", CHANGE_ID, "subagent", "await", "seed-5"], lost.io)).toBe(5);
  expect(lost.out.join("\n")).toBe("lost seed-5 (turn 1)");
});

test("subagent await --turn refuses a bad number or several targets (usage 2)", async () => {
  for (const value of ["abc", "-3", "0", "1.5"]) {
    const bad = capture();
    expect(
      await run(
        ["--server", "http://127.0.0.1:1", "--change", CHANGE_ID, "subagent", "await", "seed-1", "--turn", value],
        bad.io,
      ),
    ).toBe(EXIT.usage);
    expect(bad.err.join("\n")).toContain("--turn needs a positive message number");
  }
  // The explicit turn names one subagent: several ids or `--all` is usage before any probe.
  const several = capture();
  expect(
    await run(
      ["--server", "http://127.0.0.1:1", "--change", CHANGE_ID, "subagent", "await", "a", "b", "--turn", "1"],
      several.io,
    ),
  ).toBe(EXIT.usage);
  expect(several.err.join("\n")).toContain("--turn waits for one named subagent");
  const every = capture();
  expect(
    await run(
      ["--server", "http://127.0.0.1:1", "--change", CHANGE_ID, "subagent", "await", "a", "--all", "--turn", "1"],
      every.io,
    ),
  ).toBe(EXIT.usage);
  expect(every.err.join("\n")).toContain("--turn waits for one named subagent");
});

test("subagent turn refuses a bad --in-reply-to before any probe (usage 2)", async () => {
  // A value that is not a positive message number is usage, checked before discovery: the reply
  // body must never be silently replaced by a shifted flag value.
  for (const value of ["abc", "-3", "0", "1.5"]) {
    const bad = capture();
    expect(
      await run(
        [
          "--server",
          "http://127.0.0.1:1",
          "--change",
          CHANGE_ID,
          "subagent",
          "turn",
          "--subagent",
          "seed-1",
          "--in-reply-to",
          value,
          "Looks good",
        ],
        bad.io,
      ),
    ).toBe(EXIT.usage);
    expect(bad.err.join("\n")).toContain("--in-reply-to needs a positive message number");
  }
});

test("the exit codes are the documented contract, not an implementation detail", () => {
  // docs/manual/install.md states these values; machine callers read the code before the text,
  // so renumbering one silently would break every script that trusts the manual.
  expect(EXIT).toEqual({ ok: 0, failure: 1, usage: 2, noServer: 3, refused: 4, lost: 5, timeout: 6 });
});

test("an await that finds nothing ready answers timeout with its own exit code (6)", async () => {
  // A second seeded instance whose prompt is still undelivered: the hold-back keeps it from
  // answering ready, so the await runs to the horizon (the run's short CORVI_SUBAGENT_POLL_MS)
  // and the orchestrator's cue is timeout/6 — check in, then await again.
  const dir = join(tmp, "changes", CHANGE_ID, "subagents", "seed-2");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "session.json"),
    JSON.stringify({
      id: "seed-2",
      changeId: CHANGE_ID,
      profile: "builtin:reviewer",
      label: "Reviewer",
      harness: "pi",
      createdBy: "orchestrator",
      createdAt: "2026-01-01T00:00:00.000Z",
      // Its window is open (a created instance always carries one) while the relay has not
      // picked the prompt up: nobody to deliver to yet, not a lost window.
      window: "seed-2-window",
      log: [{ kind: "created", at: "2026-01-01T00:00:00.000Z" }],
    }),
    "utf8",
  );
  await writeFile(
    join(dir, "001-orchestrator.md"),
    "---\nfrom: orchestrator\nat: 2026-01-01T00:00:00.000Z\n---\nNot picked up yet\n",
    "utf8",
  );

  const waited = capture();
  expect(
    await run(["--server", baseUrl, "--change", CHANGE_ID, "subagent", "await", "seed-2", "--json"], waited.io),
  ).toBe(6);
  const timedOut = JSON.parse(waited.out.join("")) as { status: string; outcomes: readonly unknown[] };
  expect(timedOut.status).toBe("timeout");
  // The horizon carries no outcome, so re-issuing re-derives settled targets from state.
  expect(timedOut.outcomes).toEqual([]);
  // The human line is just `timeout`.
  const human = capture();
  expect(await run(["--server", baseUrl, "--change", CHANGE_ID, "subagent", "await", "seed-2"], human.io)).toBe(6);
  expect(human.out.join("\n")).toBe("timeout");
});

test("a repository profile is written and deleted through the checkout, and an unknown repository is refused", async () => {
  const text = "---\nlabel: Repo action\nkind: prompt\ntarget: active\n---\nhello\n";
  const from = join(tmp, "repo-action.md");
  await writeFile(from, text, "utf8");

  const wrote = capture();
  expect(
    await run(
      [
        "--server", baseUrl, "--change", CHANGE_ID, "action", "profile", "write", "repo-action",
        "--scope", "repository", "--repository", basename(repo), "--from", from, "--json",
      ],
      wrote.io,
    ),
  ).toBe(0);
  // The file landed in the checkout, exactly where discovery reads it.
  expect(await readFile(join(repo, ".corvi", "actions", "repo-action.md"), "utf8")).toBe(text);

  const refused = capture();
  expect(
    await run(
      [
        "--server", baseUrl, "--change", CHANGE_ID, "action", "profile", "write", "x",
        "--scope", "repository", "--repository", "nope", "--from", from, "--json",
      ],
      refused.io,
    ),
  ).toBe(4);
  expect(refused.err.join("")).toContain("no such repository");

  const deleted = capture();
  expect(
    await run(
      [
        "--server", baseUrl, "--change", CHANGE_ID, "action", "profile", "delete", "repo-action",
        "--scope", "repository", "--repository", basename(repo), "--json",
      ],
      deleted.io,
    ),
  ).toBe(0);
  expect(await Bun.file(join(repo, ".corvi", "actions", "repo-action.md")).exists()).toBe(false);
});

test("the repository scope's flag pairings are usage errors, named before any probe", async () => {
  const from = join(tmp, "repo-action.md");
  await writeFile(from, "---\nlabel: X\nkind: prompt\ntarget: active\n---\nx\n", "utf8");
  const base = ["--server", baseUrl, "--change", CHANGE_ID, "action", "profile", "write", "x"];

  const noRepository = capture();
  expect(
    await run([...base, "--scope", "repository", "--from", from], noRepository.io),
  ).toBe(2);
  expect(noRepository.err.join("")).toContain("--repository");

  const mispaired = capture();
  expect(
    await run([...base, "--scope", "global", "--repository", "repo", "--from", from], mispaired.io),
  ).toBe(2);
  expect(mispaired.err.join("")).toContain("--repository only goes with --scope repository");
});

test("a bare group prints its own usage, and the subagent one carries the delegation recipe", async () => {
  const group = capture();
  expect(await run(["subagent"], group.io)).toBe(0);
  const help = group.out.join("");
  expect(help).toContain("corvi subagent");
  // The recipe whose absence failed an agent told to "use subagents": find a profile key,
  // create with it, wait, read the answer.
  expect(help).toContain("corvi subagent profile list");
  expect(help).toContain("corvi subagent create");
  expect(help).toContain("corvi subagent await");
  expect(help).toContain("corvi subagent result");

  for (const name of ["change", "action"]) {
    const bare = capture();
    expect(await run([name], bare.io)).toBe(0);
    expect(bare.out.join("")).toContain(`corvi ${name}`);
  }

  // A bare profile subfamily is the same help, not an error — before any server is asked.
  const profile = capture();
  expect(await run(["subagent", "profile"], profile.io)).toBe(0);
  expect(profile.out.join("")).toBe(help);
});

test("a command typo is a usage error before any server is asked", async () => {
  const unknown = capture();
  expect(await run(["subagent", "wat"], unknown.io, { env: {} })).toBe(2);
  // The existing wording lists what the group does take.
  expect(unknown.err.join("")).toContain("subagent needs a command");

  const unknownProfile = capture();
  expect(await run(["subagent", "profile", "wat"], unknownProfile.io, { env: {} })).toBe(2);
  expect(unknownProfile.err.join("")).toContain("unknown profile command");
});

test("profile write states its scope, and a repository file names its checkout", async () => {
  const file = join(tmp, "scope-profile.md");
  await writeFile(file, "---\nlabel: Scope test\nharness: pi\n---\nCheck it.\n", "utf8");

  // The scope is required, never defaulted: a wrong default would silently misfile it.
  const noScope = capture();
  expect(await run(["subagent", "profile", "write", "x", "--from", file], noScope.io, { env: {} })).toBe(2);
  expect(noScope.err.join("")).toContain("--scope");

  // A repository file names its checkout — the scope is real now, and the repository with it.
  const noRepository = capture();
  expect(
    await run(["subagent", "profile", "write", "x", "--scope", "repository", "--from", file], noRepository.io, {
      env: {},
    }),
  ).toBe(2);
  expect(noRepository.err.join("")).toContain("--repository <name>");
});

test("subagent profile list names the keys create takes, shipped profiles included", async () => {
  const list = capture();
  expect(
    await run(
      ["--server", baseUrl, "--change", CHANGE_ID, "subagent", "profile", "list", "--json"],
      list.io,
    ),
  ).toBe(0);
  const discovery = JSON.parse(list.out.join("")) as {
    profiles: { key: string; label: string; harness: string; body: string }[];
    skipped: { key: string; reasons: string[] }[];
  };
  const reviewer = discovery.profiles.find((profile) => profile.key === "builtin:reviewer");
  expect(reviewer?.label).toBe("Reviewer");
  expect(reviewer?.harness).toBe("pi");
  // The body is the profile file's own initial prompt — not pinned to the shipped wording, just
  // present (the wording is the builtins' own to change).
  expect(reviewer?.body.trim().length ?? 0).toBeGreaterThan(0);
});

test("subagent profile write and delete round-trip a file, and a bad one is refused with its reasons", async () => {
  const file = join(tmp, "profile.md");
  await writeFile(file, "---\nlabel: Writer test\nharness: pi\n---\nCheck it.\n", "utf8");

  const written = capture();
  expect(
    await run(
      ["--server", baseUrl, "subagent", "profile", "write", "writer-test", "--scope", "global", "--from", file, "--json"],
      written.io,
    ),
  ).toBe(0);
  expect(JSON.parse(written.out.join("")) as { id: string; label?: string }).toMatchObject({
    id: "writer-test",
    label: "Writer test",
  });

  // The write lands in the change's discovery, keyed as create wants it.
  const listed = capture();
  expect(
    await run(
      ["--server", baseUrl, "--change", CHANGE_ID, "subagent", "profile", "list", "--json"],
      listed.io,
    ),
  ).toBe(0);
  const keys = (JSON.parse(listed.out.join("")) as { profiles: { key: string }[] }).profiles.map((p) => p.key);
  expect(keys).toContain("global:writer-test");

  // What is not a profile is a refusal (4), carrying the parser's reasons.
  await writeFile(file, "no frontmatter here", "utf8");
  const broken = capture();
  expect(
    await run(
      ["--server", baseUrl, "subagent", "profile", "write", "broken", "--scope", "global", "--from", file, "--json"],
      broken.io,
    ),
  ).toBe(4);
  const envelope = JSON.parse(broken.err.join("")) as { error: string; exitCode: number };
  expect(envelope.exitCode).toBe(4);
  expect(envelope.error).toContain("frontmatter");

  const deleted = capture();
  expect(
    await run(
      ["--server", baseUrl, "subagent", "profile", "delete", "writer-test", "--scope", "global", "--json"],
      deleted.io,
    ),
  ).toBe(0);
  expect(JSON.parse(deleted.out.join("")) as { id: string }).toMatchObject({ id: "writer-test" });

  const after = capture();
  expect(
    await run(
      ["--server", baseUrl, "--change", CHANGE_ID, "subagent", "profile", "list", "--json"],
      after.io,
    ),
  ).toBe(0);
  const gone = (JSON.parse(after.out.join("")) as { profiles: { key: string }[] }).profiles.map((p) => p.key);
  expect(gone).not.toContain("global:writer-test");
});

test("action profile files round-trip and show up as runnable actions", async () => {
  const file = join(tmp, "action.md");
  await writeFile(
    file,
    "---\nlabel: Test action\nkind: prompt\ntarget: agent\nsubmit: true\n---\nDo the thing.\n",
    "utf8",
  );

  const written = capture();
  expect(
    await run(
      ["--server", baseUrl, "action", "profile", "write", "test-action", "--scope", "global", "--from", file, "--json"],
      written.io,
    ),
  ).toBe(0);

  // The files view the page edits through: as written, with any problems.
  const files = capture();
  expect(await run(["--server", baseUrl, "action", "profile", "list", "--json"], files.io)).toBe(0);
  const ids = (JSON.parse(files.out.join("")) as { files: { id: string }[] }).files.map((f) => f.id);
  expect(ids).toContain("test-action");

  // And the menu it feeds: the runnable keys.
  const runnable = capture();
  expect(
    await run(["--server", baseUrl, "--change", CHANGE_ID, "action", "list", "--json"], runnable.io),
  ).toBe(0);
  const keys = (JSON.parse(runnable.out.join("")) as { key: string }[]).map((a) => a.key);
  expect(keys).toContain("global:test-action");

  const deleted = capture();
  expect(
    await run(
      ["--server", baseUrl, "action", "profile", "delete", "test-action", "--scope", "global", "--json"],
      deleted.io,
    ),
  ).toBe(0);
});

test("an argv token is never a command through Object.prototype", async () => {
  // A plain record inherits `toString`, `constructor` and the rest: those must read as unknown
  // commands (2), never print a function or crash with a raw TypeError.
  for (const argv of [["toString"], ["constructor", "list"]] as const) {
    const c = capture();
    expect(await run([...argv], c.io, { env: {} })).toBe(2);
    expect(c.err.join("")).toContain("unknown");
  }
});

test("--help on a group is that group's own usage", async () => {
  const bare = capture();
  expect(await run(["subagent"], bare.io)).toBe(0);
  const help = capture();
  expect(await run(["subagent", "--help"], help.io)).toBe(0);
  expect(help.out.join("")).toBe(bare.out.join(""));
});

test("the command tables and the help text cannot drift apart", () => {
  for (const [group, commands] of Object.entries(COMMANDS)) {
    const help = GROUP_HELP[group] ?? "";
    for (const command of commands) expect(`${group}: ${help}`).toContain(command);
  }
});

test("a workspace-scoped file round-trips, and the workspace flag has rules", async () => {
  // The workspace comes from the server itself — the one its config knows.
  const files = capture();
  expect(await run(["--server", baseUrl, "action", "profile", "list", "--json"], files.io)).toBe(0);
  const workspaces = (JSON.parse(files.out.join("")) as { workspaces: { id: string }[] }).workspaces;
  expect(workspaces.length).toBeGreaterThan(0);
  const ws = workspaces[0]!.id;

  const file = join(tmp, "ws-action.md");
  await writeFile(file, "---\nlabel: WS action\nkind: prompt\ntarget: agent\nsubmit: true\n---\nDo it.\n", "utf8");
  const written = capture();
  expect(
    await run(
      [
        "--server", baseUrl, "action", "profile", "write", "ws-test", "--scope", "workspace",
        "--workspace", ws, "--from", file, "--json",
      ],
      written.io,
    ),
  ).toBe(0);

  const listed = capture();
  expect(await run(["--server", baseUrl, "action", "profile", "list", "--json"], listed.io)).toBe(0);
  const keys = (JSON.parse(listed.out.join("")) as { files: { scope: string; workspace?: string; id: string }[] }).files
    .map((one) => `${one.scope}:${one.workspace === undefined ? "" : `${one.workspace}:`}${one.id}`);
  expect(keys).toContain(`workspace:${ws}:ws-test`);

  const deleted = capture();
  expect(
    await run(
      ["--server", baseUrl, "action", "profile", "delete", "ws-test", "--scope", "workspace", "--workspace", ws, "--json"],
      deleted.io,
    ),
  ).toBe(0);

  // The flag rules are usage errors, locally — never a round trip to the server.
  const missing = capture();
  expect(
    await run(["action", "profile", "write", "x", "--scope", "workspace", "--from", file], missing.io, { env: {} }),
  ).toBe(2);
  expect(missing.err.join("")).toContain("--workspace");

  const mixed = capture();
  expect(
    await run(["action", "profile", "write", "x", "--scope", "global", "--workspace", ws, "--from", file], mixed.io, {
      env: {},
    }),
  ).toBe(2);
  expect(mixed.err.join("")).toContain("only goes with");
});

test("profile write reads a piped file's text from stdin", async () => {
  const shim = join(import.meta.dir, "..", "apps", "cli", "bin", "corvi");
  const proc = Bun.spawn(
    [shim, "--server", baseUrl, "subagent", "profile", "write", "stdin-test", "--scope", "global", "--json"],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  proc.stdin.write("---\nlabel: Stdin test\nharness: pi\n---\nCheck it.\n");
  proc.stdin.end();
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  expect(await proc.exited).toBe(0);
  expect(stderr).toBe("");
  expect((JSON.parse(stdout) as { id: string }).id).toBe("stdin-test");

  const deleted = capture();
  expect(
    await run(["--server", baseUrl, "subagent", "profile", "delete", "stdin-test", "--scope", "global", "--json"], deleted.io),
  ).toBe(0);
});

test("the shim is `corvi` end to end: dispatch, usage, and the exit contract", async () => {
  const shim = join(import.meta.dir, "..", "apps", "cli", "bin", "corvi");

  const listed = Bun.spawnSync([shim, "--server", baseUrl, "change", "list", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(listed.exitCode).toBe(0);
  expect((JSON.parse(listed.stdout.toString()) as { id: string }[]).map((c) => c.id)).toContain(CHANGE_ID);

  const usage = Bun.spawnSync([shim], { stdout: "pipe", stderr: "pipe" });
  expect(usage.exitCode).toBe(0);
  expect(usage.stdout.toString()).toContain("corvi — control a change");

  const typo = Bun.spawnSync([shim, "subagent", "profile", "wat"], { stdout: "pipe", stderr: "pipe" });
  expect(typo.exitCode).toBe(2);
  expect(typo.stderr.toString()).toContain("unknown profile command");
});
