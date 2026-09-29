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

import { run, COMMANDS, GROUP_HELP, type Io } from "../apps/cli/src/main.ts";
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
    { url: "http://a", source: "a", priority: 2 },
    { url: "http://b", source: "b", priority: 2 },
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
    env: serverEnv(tmp, { CORVI_TMUX_SOCKET: join(tmp, "tmux.sock") }),
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

  // An in-flight turn with no live window is interrupted to `wait` too (exit 5).
  const waited = capture();
  expect(
    await run(["--server", baseUrl, "--change", CHANGE_ID, "subagent", "wait", "seed-1", "--json"], waited.io),
  ).toBe(5);
  expect((JSON.parse(waited.out.join("")) as { status: string }).status).toBe("interrupted");

  // The flag form of send works as well as the positional form.
  const sent = capture();
  expect(
    await run(
      ["--server", baseUrl, "--change", CHANGE_ID, "subagent", "send", "--subagent", "seed-1", "More please", "--json"],
      sent.io,
    ),
  ).toBe(0);

  const turned = capture();
  expect(
    await run(
      ["--server", baseUrl, "--change", CHANGE_ID, "subagent", "turn", "--subagent", "seed-1", "Looks good", "--json"],
      turned.io,
    ),
  ).toBe(0);

  const result = capture();
  expect(
    await run(["--server", baseUrl, "--change", CHANGE_ID, "subagent", "result", "seed-1", "--json"], result.io),
  ).toBe(0);
  expect((JSON.parse(result.out.join("")) as { body: string }).body).toBe("Looks good");
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
  expect(help).toContain("corvi subagent wait");
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

test("profile write states its scope, and repository files name the checkout path", async () => {
  const file = join(tmp, "scope-profile.md");
  await writeFile(file, "---\nlabel: Scope test\nharness: pi\n---\nCheck it.\n", "utf8");

  // The scope is required, never defaulted: a wrong default would silently misfile it.
  const noScope = capture();
  expect(await run(["subagent", "profile", "write", "x", "--from", file], noScope.io, { env: {} })).toBe(2);
  expect(noScope.err.join("")).toContain("--scope");

  // Repository scope is the checkout's own: the answer is the path, written directly.
  const repository = capture();
  expect(
    await run(["subagent", "profile", "write", "x", "--scope", "repository", "--from", file], repository.io, {
      env: {},
    }),
  ).toBe(2);
  expect(repository.err.join("")).toContain(".corvi/subagents/x.md");

  const action = capture();
  expect(
    await run(["action", "profile", "write", "x", "--scope", "repository", "--from", file], action.io, { env: {} }),
  ).toBe(2);
  expect(action.err.join("")).toContain(".corvi/actions/x.md");
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
