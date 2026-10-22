import { afterEach, beforeEach, expect, test } from "bun:test";
import { Deferred, Effect, Fiber, Option, Result } from "effect";
import { TestClock } from "effect/testing";
import { gh, ghOrThrow, GitHubRateLimited, refusalNow } from "@corvi/github/rate-limit";
import type { Workspace } from "../apps/server/src/workspace/server/index.ts";
import {
  fakeShell,
  forgetRateLimit,
  runWithShell,
  runWithShellAs,
  runWithShellEither,
  runWithShellWithTestClock,
  type FakeShell,
  type ShellCall,
} from "./helpers.ts";

/**
 * The `gh` seam: which budget a failure exhausted, the gate that refuses before a process
 * exists, the single probe per closure that learns when GitHub answers again, and the reset that
 * reopens it. Every command here is scripted — the real limit cannot be reproduced without
 * spending the budget it is about.
 */

beforeEach(() => forgetRateLimit());
// The gate belongs to the tokens and lives in this process: a test that leaves it shut would
// refuse the next file a worker runs.
afterEach(() => forgetRateLimit());

const GRAPHQL_LIMIT = "GraphQL: API rate limit already exceeded for user ID 13013300.";
const REST_LIMIT =
  "HTTP 403: API rate limit exceeded for 203.0.113.7. (https://api.github.com/rate_limit)";
const SECONDARY_LIMIT =
  "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.";

/** The probe's answer, with the resets given as the instants the test reasons about. */
const rateLimit = (resets: { graphql?: number; core?: number }): string =>
  JSON.stringify({
    resources: {
      ...(resets.graphql === undefined
        ? {}
        : { graphql: { remaining: 0, reset: resetOf(resets.graphql) } }),
      ...(resets.core === undefined ? {} : { core: { remaining: 4_000, reset: resetOf(resets.core) } }),
    },
  });

const resetOf = (at: number): number => Math.floor(at / 1_000);

const failureOf = (outcome: Result.Result<unknown, unknown>): unknown => {
  if (Result.isFailure(outcome)) return outcome.failure;
  throw new Error(`expected a failure, got ${JSON.stringify(outcome.success)}`);
};

const rateLimited = (outcome: Result.Result<unknown, unknown>): GitHubRateLimited => {
  const error = failureOf(outcome);
  if (!(error instanceof GitHubRateLimited)) {
    throw new Error(`expected GitHubRateLimited, got ${JSON.stringify(error)}`);
  }
  return error;
};

const lines = (shell: FakeShell): readonly string[] => shell.calls.map((call) => call.cmd.join(" "));

const probes = (shell: FakeShell): readonly string[] => lines(shell).filter((line) => line === "gh api rate_limit");

const spawned = (shell: FakeShell): readonly string[] => lines(shell).filter((line) => line !== "gh api rate_limit");

// --- Classification ----------------------------------------------------------------------------

test("a limit's words name the budget, and the command's own is the fallback", async () => {
  const cases = [
    // GitHub's words win when they name a budget.
    { command: "gh pr list", message: GRAPHQL_LIMIT, onStdout: false, resource: "graphql" },
    { command: "gh api repos/org/repo", message: GRAPHQL_LIMIT, onStdout: false, resource: "graphql" },
    // REST's sentence from a GraphQL command is still that command's budget: gating the budget it
    // did not spend would leave the exhausted one open for the storm this change exists to stop.
    { command: "gh pr list", message: REST_LIMIT, onStdout: false, resource: "graphql" },
    { command: "gh pr list", message: REST_LIMIT, onStdout: true, resource: "graphql" },
    { command: "gh api repos/org/repo", message: REST_LIMIT, onStdout: false, resource: "core" },
    // The burst throttle is neither budget, whatever the command.
    { command: "gh pr list", message: SECONDARY_LIMIT, onStdout: false, resource: "secondary" },
    {
      command: "gh api repos/org/repo",
      message: "You have triggered an abuse detection mechanism.",
      onStdout: false,
      resource: "secondary",
    },
  ] as const;

  for (const { command, message, onStdout, resource } of cases) {
    forgetRateLimit();
    const shell = fakeShell({
      "gh api rate_limit": rateLimit({ graphql: Date.now() + 60 * 60_000 }),
      [command]: onStdout ? { code: 1, stdout: message } : { code: 1, stderr: message },
    });
    expect(rateLimited(await runWithShellEither(shell, gh(command.split(" ")))).resource).toBe(resource);
    // A budget limit shuts its own budget only: the other one is still asked.
    if (resource === "secondary") continue;
    const sibling = resource === "graphql" ? "gh api repos/org/repo" : "gh pr list";
    if (sibling === command) continue;
    expect(lines(shell)).not.toContain(sibling);
    await runWithShell(shell, Effect.result(gh(sibling.split(" "))));
    expect(lines(shell)).toContain(sibling);
  }
});

test("each command's real argv shape spends the budget gh actually uses", async () => {
  const cases = [
    { command: "gh api graphql -f query=query{}", resource: "graphql" },
    // `gh api` with anything but the graphql path is REST, flags and all.
    { command: "gh api -X POST repos/o/r/pulls/1/merge", resource: "core" },
    { command: "gh api repos/o/r/pulls/1", resource: "core" },
    { command: "gh pr checks 7 --json name,state,bucket", resource: "graphql" },
    { command: "gh pr list --head feature --state all --limit 1 --json number", resource: "graphql" },
    // gh's mutations are GraphQL: create, merge and close all go through its mutation API.
    { command: "gh pr create --fill", resource: "graphql" },
    { command: "gh pr merge 7 --squash", resource: "graphql" },
    { command: "gh issue close 7 -R o/r -c done", resource: "graphql" },
    // Creating an issue is a GraphQL mutation too (`api.IssueCreate`).
    { command: "gh issue create -R o/r -t title", resource: "graphql" },
    { command: "gh issue list -R o/r --state open", resource: "graphql" },
    { command: "gh repo view --json nameWithOwner", resource: "graphql" },
  ] as const;

  for (const { command, resource } of cases) {
    forgetRateLimit();
    // REST's wording names no budget, so the command's own is what the failure is classified by.
    const shell = fakeShell({
      "gh api rate_limit": rateLimit({ graphql: Date.now() + 60 * 60_000 }),
      [command]: { code: 1, stderr: REST_LIMIT },
    });
    expect(rateLimited(await runWithShellEither(shell, gh(command.split(" ")))).resource).toBe(resource);
  }
});

test("asking whether the gate is shut records nothing", async () => {
  const shell = fakeShell({ "gh pr list": "[]" });

  const asked = await runWithShell(
    shell,
    Effect.all([refusalNow("graphql"), refusalNow("core"), refusalNow("secondary")]),
  );
  expect(asked.every(Option.isNone)).toBe(true);
  // An open gate is answered from what is recorded, and asking leaves nothing behind: no spawn,
  // no probe, and the next command runs as usual.
  expect(spawned(shell)).toHaveLength(0);
  expect(probes(shell)).toHaveLength(0);
  expect(await runWithShell(shell, gh(["gh", "pr", "list"]))).toMatchObject({ code: 0, stdout: "[]" });
  expect(spawned(shell)).toEqual(["gh pr list"]);
  expect(probes(shell)).toHaveLength(0);
});

test("a failure that is not a limit stays the result a caller branches on, and gates nothing", async () => {
  const shell = fakeShell((cmd) =>
    cmd.join(" ") === "gh pr list" ? { code: 1, stderr: "no git remotes found" } : "[]",
  );

  expect(await runWithShell(shell, gh(["gh", "pr", "list"]))).toMatchObject({
    code: 1,
    stderr: "no git remotes found",
  });
  // Nothing was asked about the budget, and the next call runs as usual.
  expect(probes(shell)).toHaveLength(0);
  expect(await runWithShell(shell, gh(["gh", "pr", "list"]))).toMatchObject({ code: 1 });
  expect(spawned(shell)).toEqual(["gh pr list", "gh pr list"]);
});

test("ghOrThrow: a non-zero exit is the CLI's failure, said as shOrThrow says it", async () => {
  const shell = fakeShell({
    "gh pr create --fill": { code: 1, stderr: "no commits between main and feature" },
    "gh pr merge 7 --squash": "",
  });

  expect(failureOf(await runWithShellEither(shell, ghOrThrow(["gh", "pr", "create", "--fill"])))).toMatchObject({
    _tag: "CliError",
    message: "gh pr create --fill failed: no commits between main and feature",
    exitCode: 1,
  });
  expect(await runWithShell(shell, ghOrThrow(["gh", "pr", "merge", "7", "--squash"]))).toBe("");
});

// --- The gate ----------------------------------------------------------------------------------

test("a GraphQL limit shuts GraphQL until the reset it reports, learned from one probe", async () => {
  const graphqlReset = Date.now() + 30 * 60_000;
  const coreReset = Date.now() + 90 * 60_000;
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line === "gh api rate_limit") return rateLimit({ graphql: graphqlReset, core: coreReset });
    // The REST call is the other budget: it runs and answers while GraphQL is shut.
    if (line === "gh api repos/org/repo") return "";
    return { code: 1, stderr: GRAPHQL_LIMIT };
  });

  const limited = rateLimited(await runWithShellEither(shell, gh(["gh", "pr", "list"])));
  expect(limited.resource).toBe("graphql");
  // GraphQL's reset, not REST's and not a backoff: the payload is per resource.
  expect(limited.resetsAt).toBe(new Date(resetOf(graphqlReset) * 1_000).toISOString());
  expect(limited.message).toMatch(
    /^GitHub rate limit reached; resets at \d\d:\d\d UTC \(in \d+ minutes\)$/,
  );

  // The gate refuses before a process exists: one probe answered the whole closure.
  const before = spawned(shell).length;
  expect(rateLimited(await runWithShellEither(shell, gh(["gh", "pr", "list"])))).toMatchObject({
    resource: "graphql",
    resetsAt: limited.resetsAt,
  });
  expect(spawned(shell)).toHaveLength(before);
  expect(probes(shell)).toHaveLength(1);

  // `gh pr merge` is a GraphQL mutation, so the same budget refuses it without spawning; the REST
  // call is the other budget and still runs.
  expect(rateLimited(await runWithShellEither(shell, gh(["gh", "pr", "merge", "7", "--squash"]))).resource).toBe(
    "graphql",
  );
  expect(lines(shell)).not.toContain("gh pr merge 7 --squash");
  expect(await runWithShell(shell, gh(["gh", "api", "repos/org/repo"]))).toMatchObject({ code: 0 });
});

test("a REST 403 shuts only REST, at core's own reset", async () => {
  const coreReset = Date.now() + 20 * 60_000;
  const graphqlReset = Date.now() + 50 * 60_000;
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line === "gh api rate_limit") return rateLimit({ core: coreReset, graphql: graphqlReset });
    if (line === "gh pr list") return "[]";
    return { code: 1, stderr: REST_LIMIT };
  });

  const limited = rateLimited(await runWithShellEither(shell, gh(["gh", "api", "repos/org/repo"])));
  expect(limited.resource).toBe("core");
  expect(limited.resetsAt).toBe(new Date(resetOf(coreReset) * 1_000).toISOString());

  const before = spawned(shell).length;
  expect(rateLimited(await runWithShellEither(shell, gh(["gh", "api", "repos/org/repo"]))).resource).toBe("core");
  expect(spawned(shell)).toHaveLength(before);

  // GraphQL still answers.
  expect(await runWithShell(shell, gh(["gh", "pr", "list"]))).toMatchObject({ code: 0, stdout: "[]" });
});

test("a secondary limit pauses both budgets for a minute, and spends no probe", async () => {
  const shell = fakeShell((cmd) =>
    cmd.join(" ") === "gh api rate_limit" ? rateLimit({ graphql: Date.now() + 60 * 60_000 }) : { code: 1, stderr: SECONDARY_LIMIT },
  );

  const before = Date.now();
  const limited = rateLimited(await runWithShellEither(shell, gh(["gh", "pr", "list"])));
  expect(limited.resource).toBe("secondary");
  // A pause, not a budget: no payload carries a secondary reset, and a probe inside the window
  // would be one more request exactly when not to send one.
  const resetsAt = new Date(limited.resetsAt).getTime();
  expect(resetsAt).toBeGreaterThanOrEqual(before + 59_000);
  expect(resetsAt).toBeLessThanOrEqual(Date.now() + 61_000);
  expect(probes(shell)).toHaveLength(0);

  const spawnedBefore = spawned(shell).length;
  expect(rateLimited(await runWithShellEither(shell, gh(["gh", "api", "repos/org/repo"]))).resource).toBe(
    "secondary",
  );
  expect(spawned(shell)).toHaveLength(spawnedBefore);
});

test("a reset GitHub reports in the past is a backoff, not a gate that never closes", async () => {
  const shell = fakeShell((cmd) =>
    cmd.join(" ") === "gh api rate_limit"
      ? rateLimit({ graphql: Date.now() - 60_000 })
      : { code: 1, stderr: GRAPHQL_LIMIT },
  );

  // Our clock runs ahead of GitHub's (the VM drift the repository notes describe): refusing until
  // then would be no gate at all, and every failing call would spend a probe of its own.
  const before = Date.now();
  const limited = rateLimited(await runWithShellEither(shell, gh(["gh", "pr", "list"])));
  expect(new Date(limited.resetsAt).getTime()).toBeGreaterThanOrEqual(before + 59_000);

  const spawnedBefore = spawned(shell).length;
  expect(rateLimited(await runWithShellEither(shell, gh(["gh", "pr", "list"]))).resource).toBe("graphql");
  expect(spawned(shell)).toHaveLength(spawnedBefore);
  expect(probes(shell)).toHaveLength(1);
});

test("the probe is not gated by the limit it is learning about", async () => {
  const coreReset = Date.now() + 15 * 60_000;
  const graphqlReset = Date.now() + 25 * 60_000;
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line === "gh api rate_limit") return rateLimit({ core: coreReset, graphql: graphqlReset });
    if (line === "gh api repos/org/repo") return { code: 1, stderr: REST_LIMIT };
    return { code: 1, stderr: GRAPHQL_LIMIT };
  });

  // REST goes first, so `gh api rate_limit` — a REST call itself — is gated when GraphQL fails.
  expect(rateLimited(await runWithShellEither(shell, gh(["gh", "api", "repos/org/repo"]))).resource).toBe("core");

  const limited = rateLimited(await runWithShellEither(shell, gh(["gh", "pr", "list"])));
  expect(limited.resource).toBe("graphql");
  // The reset is GraphQL's own, not the flat backoff a refused probe would have produced.
  expect(limited.resetsAt).toBe(new Date(resetOf(graphqlReset) * 1_000).toISOString());
  expect(probes(shell)).toHaveLength(2);
});

test("failures at the same moment share one probe", async () => {
  const release = Deferred.makeUnsafe<void>();
  const graphqlReset = Date.now() + 20 * 60_000;
  const calls: ShellCall[] = [];
  const shell: FakeShell = {
    calls,
    run: (cmd, opts) => {
      calls.push({ cmd: [...cmd], cwd: opts?.cwd });
      if (cmd.join(" ") === "gh api rate_limit") {
        return Effect.as(Deferred.await(release), {
          code: 0,
          stdout: rateLimit({ graphql: graphqlReset }),
          stderr: "",
        });
      }
      return Effect.succeed({ code: 1, stdout: "", stderr: GRAPHQL_LIMIT });
    },
  };

  const outcomes = await runWithShell(
    shell,
    Effect.gen(function* () {
      const fibers = yield* Effect.forEach([1, 2, 3], () =>
        Effect.forkChild(Effect.result(gh(["gh", "pr", "list"]))),
      );
      // Every call has reached the shell before the one probe answers them.
      for (let turn = 0; turn < 32; turn++) yield* Effect.yieldNow;
      expect(spawned(shell)).toHaveLength(3);
      yield* Deferred.succeed(release, undefined);
      return yield* Effect.forEach(fibers, (fiber) => Fiber.join(fiber));
    }),
  );

  for (const outcome of outcomes) expect(rateLimited(outcome).resource).toBe("graphql");
  expect(probes(shell)).toHaveLength(1);
});

test("an interrupted probe still leaves a gate the next call can meet", async () => {
  const started = Deferred.makeUnsafe<void>();
  const graphqlReset = Date.now() + 20 * 60_000;
  const calls: ShellCall[] = [];
  let probeAttempts = 0;
  const shell: FakeShell = {
    calls,
    run: (cmd, opts) => {
      calls.push({ cmd: [...cmd], cwd: opts?.cwd });
      if (cmd.join(" ") === "gh api rate_limit") {
        probeAttempts++;
        // The first probe never answers: the request that hit the limit is cancelled while it
        // waits, which is the state that must not wedge the gate.
        return probeAttempts === 1
          ? Effect.andThen(Deferred.succeed(started, undefined), Effect.never)
          : Effect.succeed({ code: 0, stdout: rateLimit({ graphql: graphqlReset }), stderr: "" });
      }
      return Effect.succeed({ code: 1, stdout: "", stderr: GRAPHQL_LIMIT });
    },
  };

  const next = await runWithShell(
    shell,
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.result(gh(["gh", "pr", "list"])));
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      // Bounded on purpose: a probe nobody answers would hang this instead of failing it.
      const outcome = yield* gh(["gh", "pr", "list"]).pipe(
        Effect.result,
        Effect.timeoutOption("1 second"),
      );
      expect(Option.isSome(outcome)).toBe(true);
      // A fresh closure after an explicit retry probes and gates as usual.
      forgetRateLimit();
      return yield* gh(["gh", "pr", "list"]).pipe(Effect.result, Effect.timeoutOption("1 second"));
    }),
  );

  const limited = rateLimited(Option.getOrThrow(next));
  expect(limited.resource).toBe("graphql");
  expect(limited.resetsAt).toBe(new Date(resetOf(graphqlReset) * 1_000).toISOString());
  expect(probeAttempts).toBe(3);
});

test("a probe that is interrupted answers the calls that joined it", async () => {
  const started = Deferred.makeUnsafe<void>();
  const calls: ShellCall[] = [];
  let probeAttempts = 0;
  const shell: FakeShell = {
    calls,
    run: (cmd, opts) => {
      calls.push({ cmd: [...cmd], cwd: opts?.cwd });
      if (cmd.join(" ") === "gh api rate_limit") {
        probeAttempts++;
        // The leader's probe never answers; a later closure's would.
        return probeAttempts === 1
          ? Effect.andThen(Deferred.succeed(started, undefined), Effect.never)
          : Effect.succeed({
              code: 0,
              stdout: rateLimit({ graphql: Date.now() + 20 * 60_000 }),
              stderr: "",
            });
      }
      return Effect.succeed({ code: 1, stdout: "", stderr: GRAPHQL_LIMIT });
    },
  };

  const outcome = await runWithShell(
    shell,
    Effect.gen(function* () {
      const leader = yield* Effect.forkChild(Effect.result(gh(["gh", "pr", "list"])));
      yield* Deferred.await(started);
      // A second call joins the probe that is already in flight…
      const joiner = yield* Effect.forkChild(Effect.result(gh(["gh", "pr", "list"])));
      for (let turn = 0; turn < 8; turn++) yield* Effect.yieldNow;
      // …and then the request that started it is cancelled.
      yield* Fiber.interrupt(leader);
      return yield* Fiber.join(joiner).pipe(Effect.timeoutOption("1 second"));
    }),
  );

  // The joiner was released by the probe's finalizer, with the backoff: it did not wait forever.
  expect(Option.isSome(outcome)).toBe(true);
  const limited = rateLimited(Option.getOrThrow(outcome));
  expect(limited.resource).toBe("graphql");
  expect(probes(shell)).toHaveLength(1);
});

test("a probe that dies still answers the calls that joined it", async () => {
  const started = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  const calls: ShellCall[] = [];
  const shell: FakeShell = {
    calls,
    run: (cmd, opts) => {
      calls.push({ cmd: [...cmd], cwd: opts?.cwd });
      if (cmd.join(" ") === "gh api rate_limit") {
        // A throw out of the shell, not a failed command: `shell.run` dies — after the caller
        // that joined this probe has had its chance to arrive.
        return Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return yield* Effect.die(new Error("the shell blew up"));
        });
      }
      return Effect.succeed({ code: 1, stdout: "", stderr: GRAPHQL_LIMIT });
    },
  };

  const outcome = await runWithShell(
    shell,
    Effect.gen(function* () {
      yield* Effect.forkChild(Effect.exit(gh(["gh", "pr", "list"])));
      yield* Deferred.await(started);
      const joiner = yield* Effect.forkChild(Effect.result(gh(["gh", "pr", "list"])));
      for (let turn = 0; turn < 8; turn++) yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      return yield* Fiber.join(joiner).pipe(Effect.timeoutOption("1 second"));
    }),
  );

  // The joiner was released by the probe's finalizer with the backoff, and did not start a probe
  // of its own: one probe, answered for everyone who was waiting on it.
  expect(Option.isSome(outcome)).toBe(true);
  expect(rateLimited(Option.getOrThrow(outcome)).resource).toBe("graphql");
  expect(probes(shell)).toHaveLength(1);
});

test("the gate reopens when the reset arrives", async () => {
  const resetAt = resetOf(Date.now() + 10 * 60_000) * 1_000;
  let asked = 0;
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line === "gh api rate_limit") return rateLimit({ graphql: resetAt });
    if (line === "gh pr list") return ++asked === 1 ? { code: 1, stderr: GRAPHQL_LIMIT } : "[]";
    return "[]";
  });

  await runWithShellWithTestClock(
    shell,
    Effect.gen(function* () {
      expect(rateLimited(yield* Effect.result(gh(["gh", "pr", "list"]))).resource).toBe("graphql");
      // A minute before the reset it is still refused, without asking GitHub.
      yield* TestClock.adjust(9 * 60_000);
      expect(Result.isFailure(yield* Effect.result(gh(["gh", "pr", "list"])))).toBe(true);
      expect(spawned(shell)).toEqual(["gh pr list"]);
      // At the reset GitHub answers again.
      yield* TestClock.adjust(60_000);
      expect(yield* gh(["gh", "pr", "list"])).toMatchObject({ code: 0, stdout: "[]" });
    }),
  );
  expect(asked).toBe(2);
});

test("a slow probe measures the backoff from when it answered", async () => {
  const calls: ShellCall[] = [];
  const shell: FakeShell = {
    calls,
    run: (cmd, opts) => {
      calls.push({ cmd: [...cmd], cwd: opts?.cwd });
      if (cmd.join(" ") === "gh api rate_limit") {
        // A probe that takes longer than the backoff — the CLI's timeout is two minutes — and
        // reports no reset.
        return Effect.andThen(TestClock.adjust(61_000), Effect.succeed({ code: 0, stdout: "{}", stderr: "" }));
      }
      return Effect.succeed({ code: 1, stdout: "", stderr: GRAPHQL_LIMIT });
    },
  };

  await runWithShellWithTestClock(
    shell,
    Effect.gen(function* () {
      expect(rateLimited(yield* Effect.result(gh(["gh", "pr", "list"]))).resource).toBe("graphql");
      // Its answer is what starts the minute: the gate is shut, not a window that expired while
      // the probe was still running.
      expect(rateLimited(yield* Effect.result(gh(["gh", "pr", "list"]))).resource).toBe("graphql");
      expect(probes(shell)).toHaveLength(1);
    }),
  );
});

test("forgetRateLimit opens the gate at once, and the next closure probes again", async () => {
  const shell = fakeShell((cmd) =>
    cmd.join(" ") === "gh api rate_limit"
      ? rateLimit({ graphql: Date.now() + 30 * 60_000 })
      : { code: 1, stderr: GRAPHQL_LIMIT },
  );

  expect(rateLimited(await runWithShellEither(shell, gh(["gh", "pr", "list"]))).resource).toBe("graphql");
  const gated = spawned(shell).length;
  expect(rateLimited(await runWithShellEither(shell, gh(["gh", "pr", "list"]))).resource).toBe("graphql");
  expect(spawned(shell)).toHaveLength(gated);

  forgetRateLimit();

  expect(rateLimited(await runWithShellEither(shell, gh(["gh", "pr", "list"]))).resource).toBe("graphql");
  expect(spawned(shell)).toHaveLength(gated + 1);
  expect(probes(shell)).toHaveLength(2);
});

test("one workspace's limit does not refuse another's commands", async () => {
  const other: Workspace = { id: "second", name: "Second workspace" };
  const shell = fakeShell((cmd) =>
    cmd.join(" ") === "gh api rate_limit"
      ? rateLimit({ graphql: Date.now() + 30 * 60_000 })
      : { code: 1, stderr: GRAPHQL_LIMIT },
  );

  // The default workspace exhausts its token.
  expect(rateLimited(await runWithShellEither(shell, gh(["gh", "pr", "list"]))).resource).toBe("graphql");
  const gated = spawned(shell).length;
  expect(rateLimited(await runWithShellEither(shell, gh(["gh", "pr", "list"]))).resource).toBe("graphql");
  expect(spawned(shell)).toHaveLength(gated);

  // The second workspace holds an account of its own (`GH_CONFIG_DIR` is per workspace), so it
  // still asks — and learns a reset of its own.
  const outcome = await runWithShellAs(
    other,
    shell,
    Effect.result(gh(["gh", "pr", "list"])),
  );
  expect(rateLimited(outcome).resource).toBe("graphql");
  expect(spawned(shell)).toHaveLength(gated + 1);
  expect(probes(shell)).toHaveLength(2);
});

test("a probe that cannot answer backs off for a minute instead of guessing", async () => {
  const shell = fakeShell((cmd) =>
    cmd.join(" ") === "gh api rate_limit"
      ? { code: 1, stderr: "gh: Not authenticated" }
      : { code: 1, stderr: GRAPHQL_LIMIT },
  );

  const before = Date.now();
  const limited = rateLimited(await runWithShellEither(shell, gh(["gh", "pr", "list"])));
  expect(limited.resource).toBe("graphql");
  const resetsAt = new Date(limited.resetsAt).getTime();
  expect(resetsAt).toBeGreaterThanOrEqual(before + 59_000);
  expect(resetsAt).toBeLessThanOrEqual(Date.now() + 61_000);
});
