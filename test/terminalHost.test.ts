import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { join } from "node:path";
import {
  ensureHost,
  HostClient,
  restartHost,
  type EnsureOptions,
  type SessionInfo,
} from "../apps/server/src/terminals/host/client.ts";
import { hostBuildId, mismatches } from "../apps/server/src/terminals/host/identity.ts";
import {
  OSC_INTRO,
  OSC_ST,
  MAX_OSC_CARRY,
  MAX_OSC_PAYLOAD,
  MAX_TITLE_CARRY,
  parseOsc,
  sanitizeStatus,
  scanTerminal,
  TITLE_CAP,
} from "../apps/server/src/terminals/host/osc.ts";
import { parseJobs } from "../apps/server/src/terminals/host/jobs.ts";
import {
  PROTOCOL,
  parseRequest,
  requestIdFrom,
  requestTypeOf,
} from "../apps/server/src/terminals/host/protocol.ts";
import { runSh, testTempDir, until, waitFor } from "./helpers.ts";

/**
 * The terminal host's own suite. Protocol and OSC parsing are pure, so they run under Bun with the
 * rest of the suite. The pty path cannot: Bun loads node-pty but never delivers output, so the
 * host itself is exercised by spawning `main.ts` under Node (the product's server runtime) and
 * driving it through the client.
 */

// --- protocol -------------------------------------------------------------------------------------

describe("terminal host protocol", () => {
  test("parses hello and keeps requestId", () => {
    expect(parseRequest({ type: "hello", token: "abc", requestId: 7 })).toEqual({
      type: "hello",
      token: "abc",
      requestId: 7,
    });
  });

  test("parses session.open and drops a non-string env or metadata rather than the request", () => {
    const parsed = parseRequest({
      type: "session.open",
      id: "s1",
      command: ["sh", "-i"],
      cols: 80,
      env: { A: "1", B: 2 },
      metadata: { change: "C1" },
    });
    expect(parsed).toEqual({
      type: "session.open",
      id: "s1",
      command: ["sh", "-i"],
      cols: 80,
      metadata: { change: "C1" },
    });
    const valid = parseRequest({
      type: "session.open",
      id: "s1",
      env: { A: "1" },
      metadata: { change: "C1", window: "W1" },
    });
    expect(valid).toEqual({
      type: "session.open",
      id: "s1",
      env: { A: "1" },
      metadata: { change: "C1", window: "W1" },
    });
    expect(parseRequest({ type: "session.open", id: "s1", metadata: { change: 1 } })).toEqual({
      type: "session.open",
      id: "s1",
    });
  });

  test("rejects a session.open without an id", () => {
    expect(parseRequest({ type: "session.open", cols: 80 })).toBeUndefined();
    expect(parseRequest({ type: "session.attach" })).toBeUndefined();
  });

  test("rejects unknown types and non-objects", () => {
    expect(parseRequest({ type: "no.such.request" })).toBeUndefined();
    expect(parseRequest(null)).toBeUndefined();
    expect(parseRequest("hello")).toBeUndefined();
    expect(parseRequest([1, 2])).toBeUndefined();
  });

  test("names the raw type and requestId for an error reply", () => {
    expect(requestTypeOf({ type: "session.list" })).toBe("session.list");
    expect(requestTypeOf({ type: 5 })).toBe("unknown");
    expect(requestTypeOf(undefined)).toBe("unknown");
    expect(requestIdFrom({ requestId: 4 })).toBe(4);
    expect(requestIdFrom({ requestId: "4" })).toBeUndefined();
    expect(requestIdFrom(undefined)).toBeUndefined();
  });

  test("carries the protocol version", () => {
    expect(PROTOCOL).toBe(1);
  });
});

// --- OSC ------------------------------------------------------------------------------------------

const BEL = Buffer.from([0x07]);
const b64 = (object: Record<string, unknown>): Buffer =>
  Buffer.from(Buffer.from(JSON.stringify(object), "utf8").toString("base64"), "ascii");
const empty = Buffer.alloc(0);
const valid = (status: string): Buffer => Buffer.concat([OSC_INTRO, b64({ status, name: "pi" }), BEL]);

describe("terminal host OSC", () => {
  test("plain output passes through unchanged", () => {
    const result = parseOsc(Buffer.from("hello world\n"), empty);
    expect(result.clean.toString("utf8")).toBe("hello world\n");
    expect(result.carry.length).toBe(0);
    expect(result.statuses.length).toBe(0);
  });

  test("a split introducer is held, then completed", () => {
    const first = parseOsc(Buffer.from("\x1b]1337;cor"), empty);
    expect(first.clean.length).toBe(0);
    expect(first.carry.toString("binary")).toBe("\x1b]1337;cor");
    const rest = Buffer.concat([Buffer.from("vi="), b64({ status: "working", name: "pi" }), BEL]);
    const second = parseOsc(rest, first.carry);
    expect(second.carry.length).toBe(0);
    expect(second.statuses.map((status) => status.status)).toEqual(["working"]);
  });

  test("a split payload is held, then completed", () => {
    const body = b64({ status: "waiting", message: "choose" });
    const first = parseOsc(Buffer.concat([OSC_INTRO, body.subarray(0, 4)]), empty);
    expect(first.statuses.length).toBe(0);
    expect(first.carry.length).toBeGreaterThan(0);
    const second = parseOsc(Buffer.concat([body.subarray(4), BEL]), first.carry);
    expect(second.statuses.length).toBe(1);
    expect(second.statuses[0]?.status).toBe("waiting");
    expect(second.statuses[0]?.message).toBe("choose");
  });

  test("a nested introducer resyncs to the later valid sequence", () => {
    const result = parseOsc(Buffer.concat([OSC_INTRO, Buffer.from("AAA"), valid("working")]), empty);
    expect(result.clean.toString("utf8")).toBe("AAA");
    expect(result.statuses.map((status) => status.status)).toEqual(["working"]);
  });

  test("a non-base64 introducer resyncs to ordinary output", () => {
    const result = parseOsc(Buffer.concat([OSC_INTRO, Buffer.from("#ordinary\n")]), empty);
    expect(result.clean.toString("utf8")).toBe("#ordinary\n");
    expect(result.carry.length).toBe(0);
    expect(result.statuses.length).toBe(0);
  });

  test("an oversized unterminated introducer forwards the rest", () => {
    const body = Buffer.from("A".repeat(MAX_OSC_CARRY + 1));
    const result = parseOsc(Buffer.concat([OSC_INTRO, body]), empty);
    expect(result.clean.length).toBe(body.length);
    expect(result.carry.length).toBe(0);
    expect(result.statuses.length).toBe(0);
  });

  test("a terminated but oversized payload is dropped and its tail forwarded", () => {
    const body = Buffer.from("A".repeat(MAX_OSC_PAYLOAD + 1));
    const result = parseOsc(Buffer.concat([OSC_INTRO, body, BEL]), empty);
    expect(result.statuses.length).toBe(0);
    expect(result.clean.length).toBe(body.length + 1);
    expect(result.clean.subarray(0, 3).toString("utf8")).toBe("AAA");
  });

  test("an oversized unterminated introducer still lets a later valid sequence through", () => {
    const result = parseOsc(
      Buffer.concat([OSC_INTRO, Buffer.from("A".repeat(MAX_OSC_CARRY + 1)), valid("waiting")]),
      empty,
    );
    expect(result.clean.toString("utf8").startsWith("A".repeat(64))).toBe(true);
    expect(result.statuses.map((status) => status.status)).toEqual(["waiting"]);
  });

  test("a string-terminated sequence parses", () => {
    const result = parseOsc(
      Buffer.concat([OSC_INTRO, b64({ status: "waiting", name: "pi" }), OSC_ST]),
      empty,
    );
    expect(result.clean.length).toBe(0);
    expect(result.statuses.map((status) => status.status)).toEqual(["waiting"]);
  });

  test("validation caps strings and rejects unknown statuses", () => {
    expect(sanitizeStatus({ status: "exploded" })).toBeUndefined();
    expect(sanitizeStatus(null)).toBeUndefined();
    const long = sanitizeStatus({ status: "working", name: "x".repeat(999) });
    expect(long?.name?.length).toBe(120);
  });
});

describe("terminal host foreground jobs", () => {
  test("maps a pty's foreground group to the job running in it", () => {
    // At a prompt the terminal's foreground group is the shell's own.
    const idle = parseJobs("  100   100   100 /bin/zsh", 1);
    expect(idle.at).toBe(1);
    expect(idle.foregroundOf.get(100)).toBe(100);
    expect(idle.nameOfGroup.get(100)).toBe("zsh");
    // With a job in front, the shell's terminal names the job's group instead.
    const busy = parseJobs(["  100   100   101 /bin/zsh", "  101   101   101 /usr/bin/sleep"].join("\n"), 2);
    expect(busy.foregroundOf.get(100)).toBe(101);
    expect(busy.nameOfGroup.get(101)).toBe("sleep");
    // A process with no terminal has no foreground group at all.
    expect(parseJobs("  200   200     0 /usr/bin/other", 0).foregroundOf.get(200)).toBeUndefined();
  });

  test("names a pipeline by its leader, and a leaderless group by a member", () => {
    const sample = parseJobs(
      [
        "  300   300   300 /usr/bin/grep",
        "  301   300   300 /usr/bin/head",
        // The group's leader (402) is not in the listing; its member still names it.
        "  400   402   400 /bin/zsh",
        "  500   500   500 /Applications/Corvi Helper.app/Contents/MacOS/Corvi Helper",
      ].join("\n"),
      0,
    );
    expect(sample.nameOfGroup.get(300)).toBe("grep");
    expect(sample.nameOfGroup.get(402)).toBe("zsh");
    // A path is cut to the name a label can carry.
    expect(sample.nameOfGroup.get(500)).toBe("Corvi Helper");
  });

  test("uses the name a program gave itself", () => {
    // `ps` reports pi's own process title, not the node it runs on.
    expect(parseJobs("  300   300   300 pi", 0).nameOfGroup.get(300)).toBe("pi");
  });
});

describe("terminal host OSC titles and cwd", () => {
  const none = Buffer.alloc(0);
  /** One OSC sequence as a terminal receives it: `ESC ] code ; payload BEL`. */
  const osc = (code: string, payload: string, terminator = "\x07"): Buffer =>
    Buffer.from(`\x1b]${code};${payload}${terminator}`, "utf8");

  test("reads the tab title and the window title", () => {
    expect(scanTerminal(osc("1", "/tmp"), none).title).toBe("/tmp");
    expect(scanTerminal(osc("2", "vim - file.ts"), none).title).toBe("vim - file.ts");
    expect(scanTerminal(osc("0", "pi - corvi"), none).title).toBe("pi - corvi");
  });

  test("the newest title in a chunk wins, as it does in a terminal", () => {
    // A prompt sets the window title and then the tab title; the short one is the one to show.
    const chunk = Buffer.concat([osc("2", "wessel@host:~/corvi"), osc("1", "corvi")]);
    expect(scanTerminal(chunk, none).title).toBe("corvi");
  });

  test("a string-terminated title parses", () => {
    expect(scanTerminal(osc("1", "corvi", "\x1b\\"), none).title).toBe("corvi");
  });

  test("a title split across chunks is carried", () => {
    const head = scanTerminal(Buffer.from("\x1b]1;co"), none);
    expect(head.title).toBeUndefined();
    expect(head.carry.toString("utf8")).toBe("\x1b]1;co");
    expect(scanTerminal(Buffer.from("rvi\x07"), head.carry).title).toBe("corvi");
  });

  test("an introducer split after its escape is carried too", () => {
    const head = scanTerminal(Buffer.from("\x1b"), none);
    expect(head.carry.length).toBe(1);
    expect(scanTerminal(Buffer.from("]1;x\x07"), head.carry).title).toBe("x");
  });

  test("other OSC numbers are not titles", () => {
    const chunk = Buffer.concat([
      osc("7", "file://host/tmp"),
      osc("8", ";https://example.com"),
      osc("10", "rgb:ffff/ffff/ffff"),
      osc("52", "c;AAAA"),
      osc("133", "A"),
      Buffer.from("\x1b]1337;corvi=eyJzdGF0dXMiOiJ3b3JraW5nIn0=\x07", "ascii"),
      osc("7501", "state=done:app=pi"),
    ]);
    expect(scanTerminal(chunk, none).title).toBeUndefined();
  });

  test("a title is one line, and capped", () => {
    expect(scanTerminal(osc("1", "  one\n\ttwo  "), none).title).toBe("one two");
    expect(scanTerminal(osc("1", "x".repeat(TITLE_CAP + 50)), none).title?.length).toBe(TITLE_CAP);
  });

  test("an empty title leaves the last real one in place", () => {
    const chunk = Buffer.concat([osc("1", "corvi"), osc("1", "")]);
    expect(scanTerminal(chunk, none).title).toBe("corvi");
  });

  test("a malformed sequence does not swallow the next one", () => {
    // A raw ESC inside the payload: the sequence is abandoned and a later one still reads.
    const stray = Buffer.concat([Buffer.from("\x1b]1;bad\x1bX", "binary"), osc("2", "good")]);
    expect(scanTerminal(stray, none).title).toBe("good");
    // An introducer that starts again before a terminator means the first never ended.
    const nested = Buffer.concat([Buffer.from("\x1b]1;never ends", "utf8"), osc("2", "good")]);
    expect(scanTerminal(nested, none).title).toBe("good");
  });

  test("reads the directory a shell announces, percent-decoded", () => {
    // OSC 7 is a cwd, not a title, even though it arrives the same way.
    const result = scanTerminal(osc("7", "file://host/Users/me/corvi%20app"), none);
    expect(result.directory).toBe("/Users/me/corvi app");
    expect(result.title).toBeUndefined();
    // An empty host part and an ST terminator are the other common spelling.
    expect(scanTerminal(osc("7", "file:///tmp", "\x1b\\"), none).directory).toBe("/tmp");
  });

  test("a cwd and a title in one chunk are both read, each last-one-wins", () => {
    // The order oh-my-zsh sends at each prompt: the window title, the tab title, then the cwd.
    const chunk = Buffer.concat([
      osc("2", "wessel@host:~/corvi"),
      osc("1", "corvi"),
      osc("7", "file://host/Users/me/corvi"),
    ]);
    const result = scanTerminal(chunk, none);
    expect(result.directory).toBe("/Users/me/corvi");
    expect(result.title).toBe("corvi");
  });

  test("a cwd that is not an absolute file URI is ignored", () => {
    expect(scanTerminal(osc("7", "https://example.com/x"), none).directory).toBeUndefined();
    expect(scanTerminal(osc("7", "file://host"), none).directory).toBeUndefined();
    expect(scanTerminal(osc("7", "file://host/%zz"), none).directory).toBeUndefined();
  });

  test("a cwd split across chunks is carried", () => {
    const head = scanTerminal(Buffer.from("\x1b]7;file://host/Us"), none);
    expect(head.directory).toBeUndefined();
    expect(scanTerminal(Buffer.from("ers/me\x07"), head.carry).directory).toBe("/Users/me");
  });

  test("an absurd unterminated sequence is not carried", () => {
    const body = Buffer.concat([
      Buffer.from("\x1b]2;", "ascii"),
      Buffer.from("A".repeat(MAX_TITLE_CARRY + 1)),
    ]);
    const result = scanTerminal(body, none);
    expect(result.title).toBeUndefined();
    expect(result.carry.length).toBe(0);
  });
});

// --- identity ---------------------------------------------------------------------------------------

describe("terminal host identity", () => {
  test("names every difference with both values, in a stable order", () => {
    const ours = { checkout: "/a", buildId: "aaa", protocol: 2 };
    expect(mismatches(ours, ours)).toEqual([]);
    expect(mismatches(ours, { checkout: "/b", buildId: "bbb", protocol: 1 })).toEqual([
      { kind: "checkout", theirs: "/b", ours: "/a" },
      { kind: "build", theirs: "bbb", ours: "aaa" },
      { kind: "protocol", theirs: 1, ours: 2 },
    ]);
    expect(mismatches(ours, { ...ours, buildId: "bbb" })).toEqual([
      { kind: "build", theirs: "bbb", ours: "aaa" },
    ]);
  });

  test("is a content hash of the host's own modules", async () => {
    const dir = await testTempDir("host-identity");
    try {
      for (const module of ["main.ts", "host.ts", "protocol.ts"])
        writeFileSync(join(dir, module), `// ${module}\n`);
      const first = hostBuildId(dir);
      expect(first).toMatch(/^[0-9a-f]{12}$/);
      expect(hostBuildId(dir)).toBe(first);
      // The server's client sits beside the host's modules in the real tree; it is not part of the
      // host, so changing it must not ask for a host restart.
      writeFileSync(join(dir, "client.ts"), "// the server's side\n");
      expect(hostBuildId(dir)).toBe(first);
      writeFileSync(join(dir, "host.ts"), "// the host's own code, changed\n");
      expect(hostBuildId(dir)).not.toBe(first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// --- integration under Node ------------------------------------------------------------------------

const usable = (await runSh(["which", "node"])).code === 0;

test("the terminal-host integration requires node on PATH", () => {
  // Without Node the pty half cannot run, and a silent skip would hide that. Fail loudly instead.
  expect(usable).toBe(true);
});

type HostFixture = {
  readonly dir: string;
  readonly options: EnsureOptions;
  readonly client: HostClient;
  readonly pid: number;
};

/** Spawn a host for one test and hand back the connected client. `runtime: "node"` is the point:
 * the pty path must run under Node, whatever runtime the suite itself is on. */
const openHost = async (idleMs?: number): Promise<HostFixture> => {
  const dir = await testTempDir("host");
  const socket = join(dir, "host.sock");
  const options: EnsureOptions = {
    socket,
    checkout: dir,
    buildId: "test",
    runtime: "node",
    ...(idleMs !== undefined ? { idleMs } : {}),
  };
  const { client } = await ensureHost(options);
  return { dir, options, client, pid: (await client.info()).pid };
};

/** Shut the host down and remove its directory. Ownership is ours (we spawned it), so a stuck
 * host is killed by its recorded pid, never by name. */
const closeHost = async (fixture: HostFixture): Promise<void> => {
  await fixture.client.shutdown().catch(() => undefined);
  fixture.client.close();
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!alive(fixture.pid)) break;
    await Bun.sleep(20);
  }
  try {
    process.kill(fixture.pid, "SIGKILL");
  } catch {
    // already gone
  }
  await rm(fixture.dir, { recursive: true, force: true });
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const session = (sessions: readonly SessionInfo[], id: string): SessionInfo | undefined =>
  sessions.find((entry) => entry.id === id);

/** Speak the raw protocol on a fresh connection: handshake, send lines, collect replies. */
const rawExchange = async (
  socketPath: string,
  rawLines: readonly string[],
): Promise<Record<string, unknown>[]> => {
  const token = readFileSync(`${socketPath}.token`, "utf8").trim();
  const socket: Socket = connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  const replies: Record<string, unknown>[] = [];
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) replies.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  socket.write(`${JSON.stringify({ type: "hello", token, requestId: 1 })}\n`);
  await waitFor("the welcome", async () => replies.some((reply) => reply.type === "welcome"));
  for (const line of rawLines) socket.write(line.endsWith("\n") ? line : `${line}\n`);
  await Bun.sleep(200);
  socket.destroy();
  return replies;
};

describe.skipIf(!usable)("terminal host under Node", () => {
  test("opens a shell, attaches, runs a command, and records metadata", async () => {
    const fixture = await openHost();
    try {
      const seen: string[] = [];
      fixture.client.onData("s1", (data) => seen.push(data.toString("utf8")));
      await fixture.client.open("s1", {
        cwd: fixture.dir,
        command: ["/bin/sh"],
        cols: 80,
        rows: 24,
        metadata: { change: "C1", window: "W1" },
      });
      await fixture.client.attach("s1");
      await Bun.sleep(200);
      await fixture.client.write("s1", "echo MARK_$(( 0 + 1 ))_HERE\n");
      await waitFor("the marker to arrive", async () => seen.join("").includes("MARK_1_HERE"));
      expect(session(await fixture.client.list(), "s1")?.metadata).toEqual({ change: "C1", window: "W1" });

      const identity: string[] = [];
      fixture.client.onData("s2", (data) => identity.push(data.toString("utf8")));
      await fixture.client.open("s2", {
        cwd: fixture.dir,
        command: [
          "/bin/sh",
          "-c",
          'printf "ID=%s INC=%s\\n" "$CORVI_SESSION_ID" "$CORVI_SESSION_INCARNATION"; sleep 3',
        ],
      });
      await fixture.client.attach("s2");
      await waitFor("the identity to print", async () => identity.join("").includes("ID=s2 INC=1"));
    } finally {
      await closeHost(fixture);
    }
  }, 30_000);

  test("adopts a host after the client detaches", async () => {
    const fixture = await openHost();
    try {
      fixture.client.close();
      const second = await ensureHost(fixture.options);
      try {
        expect(second.adopted).toBe(true);
        expect((await second.client.info()).pid).toBe(fixture.pid);
        expect(alive(fixture.pid)).toBe(true);
      } finally {
        await second.client.shutdown().catch(() => undefined);
        second.client.close();
      }
    } finally {
      await closeHost(fixture);
    }
  }, 30_000);

  test("keeps a host with a session in it, and says why it is not ours", async () => {
    const fixture = await openHost();
    try {
      await fixture.client.open("busy", {
        cwd: fixture.dir,
        command: ["/bin/sh", "-c", "sleep 30"],
        cols: 80,
        rows: 24,
      });
      const kept = await ensureHost({ ...fixture.options, buildId: "other" });
      try {
        expect(kept.adopted).toBe(true);
        expect(kept.stale).toEqual([{ kind: "build", theirs: "test", ours: "other" }]);
        expect((await kept.client.info()).pid).toBe(fixture.pid);
        expect(alive(fixture.pid)).toBe(true);
        // The whole point: the shell inside is still there to adopt.
        expect(session(await kept.client.list(), "busy")?.alive).toBe(true);
      } finally {
        // Adopted, so detach rather than shut the host down.
        kept.client.close();
      }
    } finally {
      await closeHost(fixture);
    }
  }, 30_000);

  test("keeps another checkout's host even with nothing alive in it", async () => {
    const fixture = await openHost();
    const other = await testTempDir("host-other");
    try {
      const kept = await ensureHost({ ...fixture.options, checkout: other });
      try {
        expect(kept.adopted).toBe(true);
        expect(kept.stale).toEqual([{ kind: "checkout", theirs: fixture.dir, ours: other }]);
        expect((await kept.client.info()).pid).toBe(fixture.pid);
      } finally {
        kept.client.close();
      }
    } finally {
      await closeHost(fixture);
      await rm(other, { recursive: true, force: true });
    }
  }, 30_000);

  test("keeps a host that only differs in build, even with nothing alive in it", async () => {
    // Nothing is lost by replacing an empty host, and it is still not this client's to take: the
    // decision is the user's, from the icon. Anything else would put a restart nobody asked for
    // under a running agent the moment the host became busy again.
    const fixture = await openHost();
    try {
      const kept = await ensureHost({ ...fixture.options, buildId: "other" });
      try {
        expect(kept.adopted).toBe(true);
        expect(kept.stale).toEqual([{ kind: "build", theirs: "test", ours: "other" }]);
        expect((await kept.client.info()).pid).toBe(fixture.pid);
        expect(alive(fixture.pid)).toBe(true);
      } finally {
        kept.client.close();
      }
    } finally {
      await closeHost(fixture);
    }
  }, 30_000);

  test("adopts a host that speaks another protocol rather than signalling it", async () => {
    const dir = await testTempDir("host-protocol");
    const socketPath = join(dir, "host.sock");
    writeFileSync(`${socketPath}.token`, "token", { mode: 0o600 });
    const owner = {
      pid: process.pid,
      socket: socketPath,
      checkout: dir,
      buildId: "test",
      protocol: PROTOCOL + 1,
      startedAt: new Date().toISOString(),
    };
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline === -1) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim() === "") continue;
          const request = JSON.parse(line) as { type: string; requestId?: number };
          const reply =
            request.type === "hello"
              ? { type: "welcome", requestId: request.requestId, owner }
              : { type: "ok", request: request.type, requestId: request.requestId, owner };
          socket.write(`${JSON.stringify(reply)}\n`);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const adopted = await ensureHost({ socket: socketPath, checkout: dir, buildId: "test" });
      try {
        expect(adopted.adopted).toBe(true);
        expect(adopted.stale).toEqual([{ kind: "protocol", theirs: PROTOCOL + 1, ours: PROTOCOL }]);
      } finally {
        adopted.client.close();
      }
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("restarting replaces the host and ends the sessions it held", async () => {
    const fixture = await openHost();
    try {
      await fixture.client.open("doomed", {
        cwd: fixture.dir,
        command: ["/bin/sh", "-c", "sleep 30"],
        cols: 80,
        rows: 24,
      });
      const restarted = await restartHost(fixture.options);
      try {
        expect(restarted.adopted).toBe(false);
        expect(restarted.stale).toEqual([]);
        expect((await restarted.client.info()).pid).not.toBe(fixture.pid);
        expect(await restarted.client.list()).toHaveLength(0);
        await waitFor("the old host to be gone", async () => !alive(fixture.pid));
      } finally {
        await restarted.client.shutdown().catch(() => undefined);
        restarted.client.close();
      }
    } finally {
      await closeHost(fixture);
    }
  }, 30_000);

  test("six concurrent callers end with exactly one host", async () => {
    const dir = await testTempDir("host");
    const options: EnsureOptions = {
      socket: join(dir, "host.sock"),
      checkout: dir,
      buildId: "test",
      runtime: "node",
    };
    const results = await Promise.all(Array.from({ length: 6 }, () => ensureHost(options)));
    try {
      const pids = new Set(
        (await Promise.all(results.map((result) => result.client.info()))).map((owner) => owner.pid),
      );
      expect(pids.size).toBe(1);
      expect(results.filter((result) => !result.adopted).length).toBe(1);
    } finally {
      await results[0]!.client.shutdown().catch(() => undefined);
      for (const result of results) result.client.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("retains a killed session with its exit signal", async () => {
    const fixture = await openHost();
    try {
      await fixture.client.open("s", { cwd: fixture.dir, command: ["/bin/sh"], cols: 80, rows: 24 });
      await fixture.client.attach("s");
      await Bun.sleep(300);
      let exitSignal = 0;
      fixture.client.onExit("s", (_code, signal) => {
        exitSignal = signal;
      });
      await fixture.client.kill("s");
      await waitFor(
        "the session to be retained dead",
        async () => session(await fixture.client.list(), "s")?.alive === false,
      );
      const retained = session(await fixture.client.list(), "s");
      expect(retained?.signal).toBeGreaterThan(0);
      expect(exitSignal).toBeGreaterThan(0);
      expect(retained?.status).toBeUndefined();
      const attached = await fixture.client.attach("s", 0);
      expect(attached.alive).toBe(false);
      expect(attached.signal).toBeGreaterThan(0);
    } finally {
      await closeHost(fixture);
    }
  }, 30_000);

  test("reopens an id with a new incarnation and no stale output", async () => {
    const fixture = await openHost();
    try {
      const seen: string[] = [];
      fixture.client.onData("r", (data) => seen.push(data.toString("utf8")));
      await fixture.client.open("r", { cwd: fixture.dir, command: ["/bin/sh"], cols: 80, rows: 24 });
      await fixture.client.attach("r");
      await Bun.sleep(200);
      await fixture.client.write("r", "echo OLD_$(( 0 + 1 ))_MARK\n");
      await waitFor("the old marker", async () => seen.join("").includes("OLD_1_MARK"));
      const firstIncarnation = session(await fixture.client.list(), "r")?.incarnation ?? 0;
      let oldExits = 0;
      fixture.client.onExit("r", (_code, _signal, incarnation) => {
        if (incarnation === firstIncarnation) oldExits++;
      });
      await fixture.client.kill("r");
      await waitFor(
        "the old session to die",
        async () => session(await fixture.client.list(), "r")?.alive === false,
      );
      const reopened = await fixture.client.open("r", {
        cwd: fixture.dir,
        command: ["/bin/sh"],
        cols: 80,
        rows: 24,
      });
      expect(reopened.opened).toBe(true);
      expect(reopened.incarnation).toBe(firstIncarnation + 1);
      await Bun.sleep(300);
      expect(oldExits).toBe(1);
      seen.length = 0;
      const attached = await fixture.client.attach("r", 0);
      expect(attached.incarnation).toBe(firstIncarnation + 1);
      await fixture.client.write("r", "echo NEW_$(( 0 + 1 ))_MARK\n");
      await waitFor("the new marker", async () => seen.join("").includes("NEW_1_MARK"));
      expect(seen.join("").includes("OLD_1_MARK")).toBe(false);
    } finally {
      await closeHost(fixture);
    }
  }, 30_000);

  test("reports truncation only once the output has settled", async () => {
    // Shrink the replay ring so the emitter outruns it without writing megabytes. The host reads the
    // override once, at startup, so it must be set before this test's host is spawned.
    const saved = process.env.CORVI_HOST_REPLAY_BYTES;
    process.env.CORVI_HOST_REPLAY_BYTES = "131072";
    const fixture = await openHost();
    try {
      const emitter = `for(let i=0;i<12000;i++)process.stdout.write("x".repeat(40)+"\\n");setTimeout(()=>{},6000)`;
      await fixture.client.open("big", {
        cwd: fixture.dir,
        command: ["node", "-e", emitter],
        cols: 100,
        rows: 30,
      });
      await waitFor(
        "the output to settle past the buffer",
        async () => {
          const before = session(await fixture.client.list(), "big")?.lastSeq ?? 0;
          await Bun.sleep(150);
          const after = session(await fixture.client.list(), "big")?.lastSeq ?? 0;
          return before === after && before > 300_000;
        },
        20_000,
      );
      const fromStart = await fixture.client.attach("big", 0);
      expect(fromStart.truncated).toBe(true);
      expect(fromStart.oldestSeq).toBeGreaterThan(0);
      const resume = await fixture.client.attach("big", fromStart.oldestSeq + 10);
      expect(resume.truncated).toBe(false);
      const negative = await fixture.client.attach("big", -5);
      expect(negative.truncated).toBe(true);
      await expect(fixture.client.attach("missing")).rejects.toThrow();
    } finally {
      await closeHost(fixture);
      if (saved === undefined) delete process.env.CORVI_HOST_REPLAY_BYTES;
      else process.env.CORVI_HOST_REPLAY_BYTES = saved;
    }
  }, 40_000);

  test("parses and strips OSC status and clears it when the session ends", async () => {
    const fixture = await openHost();
    try {
      const script = `const p=Buffer.from(JSON.stringify({status:"working",name:"pi",sessionName:"Fix login"}),"utf8").toString("base64");process.stdout.write("\\x1b]1337;corvi="+p+"\\x07");setTimeout(()=>{},3000)`;
      const seen: string[] = [];
      fixture.client.onData("osc", (data) => seen.push(data.toString("utf8")));
      await fixture.client.open("osc", {
        cwd: fixture.dir,
        command: ["node", "-e", script],
        cols: 100,
        rows: 30,
      });
      await waitFor(
        "the status to be recorded",
        async () => session(await fixture.client.list(), "osc")?.status?.state === "working",
      );
      const status = session(await fixture.client.list(), "osc")?.status;
      expect(status?.name).toBe("pi");
      expect(status?.sessionName).toBe("Fix login");
      await fixture.client.attach("osc", 0);
      expect(seen.join("").includes("\x1b]1337;corvi=")).toBe(false);
      await fixture.client.kill("osc");
      await waitFor(
        "the status to clear on exit",
        async () =>
          session(await fixture.client.list(), "osc")?.alive === false &&
          session(await fixture.client.list(), "osc")?.status === undefined,
      );
    } finally {
      await closeHost(fixture);
    }
  }, 30_000);

  test("records the terminal's own title without taking it out of the output", async () => {
    const fixture = await openHost();
    try {
      // A title is not a private channel like the reporter's: the display is entitled to it too.
      const script = `process.stdout.write("\\x1b]1;Window name\\x07");setTimeout(()=>{},3000)`;
      const seen: string[] = [];
      fixture.client.onData("title", (data) => seen.push(data.toString("utf8")));
      await fixture.client.open("title", {
        cwd: fixture.dir,
        command: ["node", "-e", script],
        cols: 100,
        rows: 30,
      });
      await waitFor(
        "the title to be recorded",
        async () => session(await fixture.client.list(), "title")?.title === "Window name",
      );
      // A client attaching afterwards is replayed the same bytes, title included.
      await fixture.client.attach("title", 0);
      expect(seen.join("").includes("\x1b]1;Window name\x07")).toBe(true);
      await fixture.client.kill("title");
    } finally {
      await closeHost(fixture);
    }
  }, 30_000);

  test("reports the directory the shell announces, and keeps the one it was opened in", async () => {
    const fixture = await openHost();
    try {
      // A prompt announces its cwd with OSC 7; the opening directory stays the session's own.
      const script = `process.stdout.write("\\x1b]7;file://host/tmp\\x07");setTimeout(()=>{},3000)`;
      await fixture.client.open("cwd", {
        cwd: fixture.dir,
        command: ["node", "-e", script],
        cols: 80,
        rows: 24,
      });
      await waitFor(
        "the announced directory",
        async () => session(await fixture.client.list(), "cwd")?.workingDirectory === "/tmp",
      );
      expect(session(await fixture.client.list(), "cwd")?.cwd).toBe(fixture.dir);
      await fixture.client.kill("cwd");
    } finally {
      await closeHost(fixture);
    }
  }, 30_000);

  test("reports the process in the foreground of a session", async () => {
    const fixture = await openHost();
    try {
      // The pty's child becomes the job itself, so no job control is needed to put one in front.
      await fixture.client.open("job", {
        cwd: fixture.dir,
        command: ["/bin/sh", "-c", "exec sleep 30"],
        cols: 80,
        rows: 24,
      });
      await waitFor(
        "the foreground job to be reported",
        async () => session(await fixture.client.list(), "job")?.job === "sleep",
      );
      // A dead session has no job: its pid may already belong to somebody else.
      await fixture.client.kill("job");
      await waitFor("the job to go with the session", async () => {
        const dead = session(await fixture.client.list(), "job");
        return dead?.alive === false && dead.job === undefined;
      });
    } finally {
      await closeHost(fixture);
    }
  }, 30_000);

  test("write and resize are not applied after exit, and a data-less write is not applied", async () => {
    const fixture = await openHost();
    try {
      await fixture.client.open("live", {
        cwd: fixture.dir,
        command: ["/bin/sh", "-c", "sleep 30"],
        cols: 80,
        rows: 24,
      });
      await fixture.client.kill("live");
      await waitFor(
        "the session to die",
        async () => session(await fixture.client.list(), "live")?.alive === false,
      );
      expect(await fixture.client.write("live", "echo hi\n")).toBe(false);
      expect(await fixture.client.resize("live", 80, 24)).toBe(false);

      await fixture.client.open("alive", {
        cwd: fixture.dir,
        command: ["/bin/sh", "-c", "sleep 30"],
        cols: 80,
        rows: 24,
      });
      const replies = await rawExchange(fixture.options.socket, [
        JSON.stringify({ type: "session.write", id: "alive", requestId: 42 }),
      ]);
      expect(replies.find((reply) => reply.requestId === 42)?.applied).toBe(false);
    } finally {
      await closeHost(fixture);
    }
  }, 30_000);

  test("error replies echo requestId, and the client surfaces id-less protocol errors", async () => {
    const fixture = await openHost();
    try {
      const replies = await rawExchange(fixture.options.socket, [
        JSON.stringify({ type: "bogus", requestId: 5 }),
        "this is not json",
      ]);
      const unknown = replies.find((reply) => reply.requestId === 5);
      expect(unknown?.type).toBe("error");
      expect(unknown?.request).toBe("bogus");
      expect(replies.some((reply) => reply.type === "error" && reply.requestId === undefined)).toBe(true);
    } finally {
      await closeHost(fixture);
    }

    // A requestId-less error pushed by a host reaches the client's error listener.
    const dir = await testTempDir("host");
    const socketPath = join(dir, "fake.sock");
    writeFileSync(`${socketPath}.token`, "token", { mode: 0o600 });
    const owner = {
      pid: 1,
      socket: socketPath,
      checkout: dir,
      buildId: "x",
      protocol: PROTOCOL,
      startedAt: new Date().toISOString(),
    };
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline === -1) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim() === "") continue;
          const request = JSON.parse(line) as { type: string; requestId?: number };
          if (request.type === "hello")
            socket.write(`${JSON.stringify({ type: "welcome", requestId: request.requestId, owner })}\n`);
        }
      });
      setTimeout(
        () => socket.write(`${JSON.stringify({ type: "error", request: "parse", message: "boom" })}\n`),
        30,
      );
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const client = await HostClient.connect(socketPath);
      const errors: { request: string; message: string }[] = [];
      client.onError((error) => errors.push(error));
      await waitFor("the id-less error", async () => errors.length > 0);
      expect(errors[0]).toEqual({ request: "parse", message: "boom" });
      client.close();
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("recovers from a host SIGKILL and evicts dead sessions at the cap", async () => {
    const fixture = await openHost();
    try {
      await fixture.client.open("s", {
        cwd: fixture.dir,
        command: ["/bin/sh", "-c", "sleep 30"],
        cols: 80,
        rows: 24,
      });
      process.kill(fixture.pid, "SIGKILL");
      await waitFor("the killed host to be gone", async () => !alive(fixture.pid));
      const recovered = await ensureHost(fixture.options);
      try {
        expect(recovered.adopted).toBe(false);
        expect((await recovered.client.info()).pid).not.toBe(fixture.pid);
        expect(await recovered.client.list()).toHaveLength(0);
      } finally {
        await recovered.client.shutdown().catch(() => undefined);
        recovered.client.close();
      }
    } finally {
      await closeHost(fixture);
    }

    const cap = await openHost();
    try {
      // One at a time, each watched to its exit: eviction is oldest-exit-first, and 66 shells that
      // all start together exit in whatever order the machine gives them. Waiting for each turns
      // "the oldest two went" from a claim about scheduling into a claim about the rule.
      for (let i = 0; i < 66; i++) {
        const id = `d${String(i).padStart(2, "0")}`;
        await cap.client.open(id, {
          cwd: cap.dir,
          command: ["/bin/sh", "-c", "exit 0"],
          cols: 40,
          rows: 10,
        });
        const exited = await until(
          async () => session(await cap.client.list(), id)?.alive === false,
          true,
          15_000,
          10,
        );
        expect(exited).toBe(true);
      }
      const retained = await cap.client.list();
      expect(retained.length).toBe(64);
      expect(session(retained, "d00")).toBeUndefined();
      expect(session(retained, "d01")).toBeUndefined();
      expect(session(retained, "d02")).toBeDefined();
      expect(session(retained, "d65")).toBeDefined();
    } finally {
      await closeHost(cap);
    }
  }, 60_000);

  test("shuts down when idle and keeps a live session up", async () => {
    const live = await openHost(500);
    try {
      await live.client.open("keep", {
        cwd: live.dir,
        command: ["/bin/sh", "-c", "sleep 30"],
        cols: 80,
        rows: 24,
      });
      await Bun.sleep(1200);
      expect(alive(live.pid)).toBe(true);
      await live.client.kill("keep");
      await waitFor(
        "the session to die",
        async () => session(await live.client.list(), "keep")?.alive === false,
      );
      live.client.close();
      await waitFor("the idle host to exit", async () => !alive(live.pid), 5000);
    } finally {
      await closeHost(live);
    }
  }, 30_000);

  test("cannot start a host without an explicit Node runtime under Bun", async () => {
    const dir = await testTempDir("host");
    try {
      await expect(
        ensureHost({ socket: join(dir, "host.sock"), checkout: dir, buildId: "test" }),
      ).rejects.toThrow(/needs Node/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
