import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";

import { make, type CommandFailure, type CommandResult, type Host, type Sessions } from "@corvi/terminals/tmux";
import { ID, env } from "@corvi/configuration/node";
import { childEnv } from "../apps/server/src/capabilities/env.ts";
import { budget, runSh, testTempDir, tmuxTempDir, waitFor } from "./helpers.ts";

/**
 * The tmux-creation-order matrix: whatever creates the change's tmux session — the pty that
 * attaches it when a browser connects (`attachCommand`), or the server's own `ensureSession`
 * before anything is written into it — and whatever the tmux server was already doing, every
 * pane's shell starts with the change's own context (`CORVI_CHANGE_ID`, `CORVI_CHANGE_DIR`) and
 * no other change's.
 *
 * tmux gives a new session the **server's** global environment, never the creating client's —
 * and that server's environment is whichever client started it. So the order used to decide the
 * answer: a session the pty created on a server an earlier `ensureSession` had started grew
 * panes with no context at all, one the pty created on a server another change's pty had
 * started grew panes with *that change's* context, and only the lucky orders looked right. The
 * context now rides `-e` on both creation paths and is healed onto sessions that already exist
 * (packages/terminals/src/tmux.ts). This matrix is the order independence that must hold.
 *
 * A real tmux server per case (a private socket each) and the real attach path: the product's
 * `attachCommand` under the app's own spawner, driven through test/support/attach.ts on Node —
 * the runtime the app runs its terminals on. The assertions read both `show-environment` and a
 * real pane's `env`, which is the only thing a shell actually starts with. Skipped where the
 * tools are missing rather than failed, as the terminal suite is.
 */
const attachDriver = join(import.meta.dir, "support", "attach.ts");
const usable =
  (await runSh(["which", "tmux"])).code === 0 &&
  (await runSh(["node", "-e", "require('node-pty')"], join(import.meta.dir, "..", "apps", "server"))).code === 0;

/** The directory the per-case sockets live in: the run's own, short enough for a unix socket and
 * named so the cleaner knows whose it is (test/helpers.ts). */
const socketDir = usable ? await tmuxTempDir() : "";

let caseNumber = 0;

/** A pty the way the app starts one: the product's attach argv under the app's own spawner,
 * driven on Node (test/support/attach.ts) where node-pty is real. The process holds the tmux
 * client — one per browser connection — and killing it detaches it, as closing a page does. */
type AttachedPty = { readonly kill: () => void };

type Scene = {
  readonly sessions: Sessions;
  readonly id: string;
  readonly dir: string;
  /** Another change, to be the "someone else got here first" of a case. */
  readonly other: { readonly id: string; readonly dir: string };
  readonly ensure: (id: string, dir: string) => Promise<void>;
  /** A session made without the context — exactly the shape an older server left behind. */
  readonly ensureBare: (id: string, dir: string) => Promise<void>;
  readonly attach: (id: string, dir: string) => AttachedPty;
  readonly exists: (id: string) => Promise<boolean>;
  readonly clients: (id: string) => Promise<number>;
  /** The change's context as this session must hold it: said by `show-environment`, and said
   * again by a real pane's `env`. `notIds` are the other changes whose names must appear
   * nowhere — a leaked context fails as loudly as a missing one. */
  readonly expectContext: (id: string, dir: string, notIds?: readonly string[]) => Promise<void>;
  readonly close: () => Promise<void>;
};

const scene = async (): Promise<Scene> => {
  const number = ++caseNumber;
  const socket = join(socketDir, `corvi-m${number}`);
  const tmp = await testTempDir("tmux-env");
  const id = `PROJ-M${number}`;
  const dir = join(tmp, "changes", id);
  await mkdir(dir, { recursive: true });
  const other = { id: `PROJ-OTHER${number}`, dir: join(tmp, "changes", `PROJ-OTHER${number}`) };
  await mkdir(other.dir, { recursive: true });

  const ptys: AttachedPty[] = [];

  /** Run one argv as the process layer would — argv in, result out. `Host.run` hands over the
   * complete command (the package's tmuxCmd has already put `tmux -S <socket>` in front), so
   * this executes exactly what it is given. Everything runs with the scrubbed environment of
   * the app's own server process (apps/server/src/capabilities/env.ts): no `CORVI_*` at all.
   * That is what makes every case here reproducible — whatever terminal the suite itself
   * happens to run in, a server this starts holds no change context to leak in by luck. */
  const runArgv = async (argv: readonly string[]): Promise<CommandResult> => {
    const proc = Bun.spawn([...argv], {
      env: childEnv(process.env),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout: stdout.trim(), stderr: stderr.trim() };
  };

  /** This test's own probes against its server. */
  const tmux = (args: readonly string[]): Promise<CommandResult> => runArgv(["tmux", "-S", socket, ...args]);

  const host: Host = {
    run: (args) => Effect.promise(() => runArgv(args)),
    runOrThrow: (args) =>
      Effect.promise(async () => {
        const result = await runArgv(args);
        if (result.code !== 0) {
          throw { message: result.stderr || "tmux failed", stderr: result.stderr, exitCode: result.code } satisfies CommandFailure;
        }
        return result;
      }),
    socket,
    name: ID,
    env,
  };
  const sessions = make(host);

  const ensure = async (toId: string, toDir: string): Promise<void> => {
    await Effect.runPromise(sessions.ensureSession(toId, toDir));
  };

  const ensureBare = async (toId: string, toDir: string): Promise<void> => {
    const made = await tmux(["new-session", "-d", "-s", sessions.sessionName(toId), "-c", toDir]);
    expect(made.code).toBe(0);
  };

  const attach = (toId: string, toDir: string): AttachedPty => {
    const child = Bun.spawn(["node", attachDriver, toId, toDir], {
      env: { ...childEnv(process.env), CORVI_TMUX_SOCKET: socket },
      stdout: "pipe",
      stderr: "pipe",
    });
    const held: AttachedPty = {
      kill: () => {
        child.kill();
        void child.exited;
      },
    };
    ptys.push(held);
    return held;
  };

  const exists = async (toId: string): Promise<boolean> =>
    (await tmux(["has-session", "-t", sessions.sessionName(toId)])).code === 0;

  const clients = async (toId: string): Promise<number> =>
    (await tmux(["list-clients", "-t", sessions.sessionName(toId)])).stdout.split("\n").filter(Boolean).length;

  const expectContext = async (toId: string, toDir: string, notIds: readonly string[] = []): Promise<void> => {
    const shown = await tmux(["show-environment", "-t", sessions.sessionName(toId)]);
    expect(shown.stdout).toContain(`${env("CHANGE_ID")}=${toId}`);
    expect(shown.stdout).toContain(`${env("CHANGE_DIR")}=${toDir}`);

    // What a shell actually starts with: a real pane of the session runs `env`, and its output is
    // the last word on what the next pane would inherit too.
    const out = join(tmp, `pane-env-${toId}.txt`);
    await tmux(["new-window", "-d", "-t", sessions.sessionName(toId), `env > ${out}`]);
    await waitFor(`a pane of ${sessions.sessionName(toId)} to print its environment`, async () =>
      (await Bun.file(out).text().catch(() => "")).length > 0,
    );
    const pane = await Bun.file(out).text();
    // Line-anchored: a value that merely contains another change's id would false-positive.
    const lines = pane.split("\n");
    expect(lines).toContain(`${env("CHANGE_ID")}=${toId}`);
    expect(lines).toContain(`${env("CHANGE_DIR")}=${toDir}`);
    for (const foreign of notIds) {
      expect(shown.stdout).not.toContain(`${env("CHANGE_ID")}=${foreign}`);
      expect(lines.some((line) => line.startsWith(`${env("CHANGE_ID")}=${foreign}`))).toBe(false);
    }
  };

  const close = async (): Promise<void> => {
    for (const held of ptys) held.kill();
    await tmux(["kill-server"]).catch(() => undefined);
    await rm(tmp, { recursive: true, force: true });
  };

  return { sessions, id, dir, other, ensure, ensureBare, attach, exists, clients, expectContext, close };
};

/** A pty that connects now is what a browser connecting to the terminal page makes: the attach
 * command creates the session on its own when nothing else has. */
const openAndAssert = async (
  creator: "attach" | "ensureSession",
  started: "fresh" | "ensureSession" | "attach",
): Promise<void> => {
  const s = await scene();
  try {
    if (started === "ensureSession") await s.ensure(s.other.id, s.other.dir);
    if (started === "attach") s.attach(s.other.id, s.other.dir);
    if (started !== "fresh") {
      await waitFor(`the other change's session to exist`, () => s.exists(s.other.id));
    }

    if (creator === "attach") {
      s.attach(s.id, s.dir);
      await waitFor(`the session of ${s.id} to exist`, () => s.exists(s.id));
    } else {
      await s.ensure(s.id, s.dir);
    }

    await s.expectContext(s.id, s.dir, [s.other.id]);
  } finally {
    await s.close();
  }
};

const cases = [
  ["attach", "fresh"],
  ["attach", "ensureSession"],
  ["attach", "attach"],
  ["ensureSession", "fresh"],
  ["ensureSession", "ensureSession"],
  ["ensureSession", "attach"],
] as const;

for (const [creator, started] of cases) {
  const by = creator === "attach" ? "a browser's pty attaches it" : "the server ensures it";
  const before =
    started === "fresh"
      ? "on a fresh tmux server"
      : started === "ensureSession"
        ? "on a tmux server another change's ensureSession started"
        : "on a tmux server another change's pty started";
  test.skipIf(!usable)(`a pane gets its change's context when ${by} ${before}`, async () => {
    await openAndAssert(creator, started);
  }, budget(60_000));
}

test.skipIf(!usable)("a re-attach joins the session it finds and leaves its context alone", async () => {
  // `new-session -A` is both halves of the product: attach when the session is there, create
  // when it is not. The context's `-e` rides the same command, so this pins that an attach to an
  // existing session still attaches — and changes nothing about the context it found.
  const s = await scene();
  try {
    await s.ensure(s.id, s.dir);
    s.attach(s.id, s.dir);
    await waitFor(`the first client of ${s.id} to attach`, async () => (await s.clients(s.id)) === 1);
    s.attach(s.id, s.dir);
    await waitFor(`the second client of ${s.id} to attach`, async () => (await s.clients(s.id)) === 2);
    await s.expectContext(s.id, s.dir);
  } finally {
    await s.close();
  }
}, budget(60_000));

test.skipIf(!usable)("ensureSession puts the context onto a session that was made without it", async () => {
  // A session can predate its context — made by an older server, or on a server whose
  // environment held none — and its next window must still start a shell that knows where it
  // is. `ensureSession` heals it; panes already running keep the environment they have.
  const s = await scene();
  try {
    await s.ensureBare(s.id, s.dir);
    // Without the heal this is where it stays: no context at all, for every pane it ever grows.
    const beforeHeal = await s.exists(s.id);
    expect(beforeHeal).toBe(true);
    await s.ensure(s.id, s.dir);
    await s.expectContext(s.id, s.dir);
  } finally {
    await s.close();
  }
}, budget(60_000));
