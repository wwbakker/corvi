import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ensureHost, type HostClient, type SessionInfo } from "../apps/server/src/terminals/host/client.ts";
import { OSC_INTRO, MAX_OSC_CARRY, parseOsc, sanitizeStatus } from "../apps/server/src/terminals/host/osc.ts";
import { PROTOCOL, parseRequest, requestTypeOf } from "../apps/server/src/terminals/host/protocol.ts";
import { runSh, testTempDir, waitFor } from "./helpers.ts";

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

  test("parses session.open and drops a non-string env rather than the request", () => {
    const parsed = parseRequest({ type: "session.open", id: "s1", command: ["sh", "-i"], cols: 80, env: { A: "1", B: 2 } });
    expect(parsed).toEqual({ type: "session.open", id: "s1", command: ["sh", "-i"], cols: 80 });
    const valid = parseRequest({ type: "session.open", id: "s1", env: { A: "1" } });
    expect(valid).toEqual({ type: "session.open", id: "s1", env: { A: "1" } });
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

  test("names the raw request type for an error reply", () => {
    expect(requestTypeOf({ type: "session.list" })).toBe("session.list");
    expect(requestTypeOf({ type: 5 })).toBe("unknown");
    expect(requestTypeOf(undefined)).toBe("unknown");
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

  test("a malformed introducer does not swallow a following valid sequence", () => {
    const result = parseOsc(Buffer.concat([OSC_INTRO, Buffer.from("AAAA"), valid("working")]), empty);
    expect(result.clean.toString("utf8")).toBe("AAAA");
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

  test("an oversized unterminated introducer still lets a later valid sequence through", () => {
    const result = parseOsc(
      Buffer.concat([OSC_INTRO, Buffer.from("A".repeat(MAX_OSC_CARRY + 1)), valid("waiting")]),
      empty,
    );
    expect(result.clean.toString("utf8").startsWith("A".repeat(64))).toBe(true);
    expect(result.statuses.map((status) => status.status)).toEqual(["waiting"]);
  });

  test("validation caps strings and rejects unknown statuses", () => {
    expect(sanitizeStatus({ status: "exploded" })).toBeUndefined();
    expect(sanitizeStatus(null)).toBeUndefined();
    const long = sanitizeStatus({ status: "working", name: "x".repeat(999) });
    expect(long?.name?.length).toBe(120);
  });
});

// --- integration under Node ------------------------------------------------------------------------

const usable = (await runSh(["which", "node"])).code === 0;

type HostFixture = { readonly dir: string; readonly socket: string; readonly client: HostClient; readonly pid: number };

/** Spawn a host for one test and hand back the connected client. `runtime: "node"` is the point:
 * the pty path must run under Node, whatever runtime the suite itself is on. */
const openHost = async (idleMs?: number): Promise<HostFixture> => {
  const dir = await testTempDir("host");
  const socket = join(dir, "host.sock");
  const { client } = await ensureHost({
    socket,
    checkout: dir,
    buildId: "test",
    runtime: "node",
    ...(idleMs !== undefined ? { idleMs } : {}),
  });
  return { dir, socket, client, pid: (await client.info()).pid };
};

/** Shut the host down and remove its directory. Ownership is ours (we spawned it), so a stuck
 * host is killed by its recorded pid, never by name. */
const closeHost = async (fixture: HostFixture): Promise<void> => {
  await fixture.client.shutdown().catch(() => undefined);
  fixture.client.close();
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(fixture.pid, 0);
      await Bun.sleep(20);
    } catch {
      break;
    }
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

describe.skipIf(!usable)("terminal host under Node", () => {
  test("opens a shell, attaches, and runs a command in it", async () => {
    const fixture = await openHost();
    try {
      const seen: string[] = [];
      fixture.client.onData("s1", (data) => seen.push(data.toString("utf8")));
      await fixture.client.open("s1", { cwd: fixture.dir, command: ["/bin/sh"], cols: 80, rows: 24 });
      await fixture.client.attach("s1");
      await Bun.sleep(200);
      await fixture.client.write("s1", "echo MARK_$(( 0 + 1 ))_HERE\n");
      await waitFor("the marker to arrive", async () => seen.join("").includes("MARK_1_HERE"));
      expect((await fixture.client.list()).find((entry) => entry.id === "s1")?.alive).toBe(true);
      // The host seeds the reporter identity into the pty.
      const identity: string[] = [];
      fixture.client.onData("s2", (data) => identity.push(data.toString("utf8")));
      await fixture.client.open("s2", {
        cwd: fixture.dir,
        command: ["/bin/sh", "-c", 'printf "ID=%s INC=%s\\n" "$CORVI_SESSION_ID" "$CORVI_SESSION_INCARNATION"; sleep 3'],
      });
      await fixture.client.attach("s2");
      await waitFor("the identity to print", async () => identity.join("").includes("ID=s2 INC=1"));
    } finally {
      await closeHost(fixture);
    }
  }, 30_000);

  test("adopts a host after the client detaches", async () => {
    const fixture = await openHost();
    const socket = fixture.socket;
    const checkout = fixture.dir;
    try {
      fixture.client.close();
      const second = await ensureHost({ socket, checkout, buildId: "test", runtime: "node" });
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
      await waitFor("the session to be retained dead", async () => session(await fixture.client.list(), "s")?.alive === false);
      const retained = session(await fixture.client.list(), "s");
      expect(retained?.signal).toBeGreaterThan(0);
      expect(exitSignal).toBeGreaterThan(0);
      // Attaching to the retained session replays its snapshot and then delivers the exit.
      const attached = await fixture.client.attach("s", 0);
      expect(attached.alive).toBe(false);
      expect(attached.signal).toBeGreaterThan(0);
    } finally {
      await closeHost(fixture);
    }
  }, 30_000);

  test("reports truncation when a resume predates the replay buffer", async () => {
    const fixture = await openHost();
    try {
      const emitter = `for(let i=0;i<12000;i++)process.stdout.write("x".repeat(40)+"\\n");setTimeout(()=>{},4000)`;
      await fixture.client.open("big", { cwd: fixture.dir, command: ["node", "-e", emitter], cols: 100, rows: 30 });
      await waitFor("the session to produce more than the buffer", async () => (session(await fixture.client.list(), "big")?.lastSeq ?? 0) > 300_000, 20_000);
      const fromStart = await fixture.client.attach("big", 0);
      expect(fromStart.truncated).toBe(true);
      expect(fromStart.oldestSeq).toBeGreaterThan(0);
      const resume = await fixture.client.attach("big", fromStart.oldestSeq + 10);
      expect(resume.truncated).toBe(false);
      await expect(fixture.client.attach("missing")).rejects.toThrow();
    } finally {
      await closeHost(fixture);
    }
  }, 40_000);

  test("parses and strips OSC status from the pty stream", async () => {
    const fixture = await openHost();
    try {
      const script = `const p=Buffer.from(JSON.stringify({status:"working",name:"pi",sessionName:"Fix login"}),"utf8").toString("base64");process.stdout.write("\\x1b]1337;corvi="+p+"\\x07");setTimeout(()=>{},3000)`;
      const seen: string[] = [];
      fixture.client.onData("osc", (data) => seen.push(data.toString("utf8")));
      await fixture.client.open("osc", { cwd: fixture.dir, command: ["node", "-e", script], cols: 100, rows: 30 });
      await waitFor("the status to be recorded", async () => session(await fixture.client.list(), "osc")?.status?.state === "working");
      const status = session(await fixture.client.list(), "osc")?.status;
      expect(status?.name).toBe("pi");
      expect(status?.sessionName).toBe("Fix login");
      await fixture.client.attach("osc", 0);
      expect(seen.join("").includes("\x1b]1337;corvi=")).toBe(false);
    } finally {
      await closeHost(fixture);
    }
  }, 30_000);

  test("shuts down when idle and keeps a live session up", async () => {
    const live = await openHost(500);
    try {
      await live.client.open("keep", { cwd: live.dir, command: ["/bin/sh", "-c", "sleep 30"], cols: 80, rows: 24 });
      await Bun.sleep(1200);
      expect(alive(live.pid)).toBe(true);
      await live.client.kill("keep");
      await waitFor("the session to die", async () => session(await live.client.list(), "keep")?.alive === false);
      live.client.close();
      await waitFor("the idle host to exit", async () => !alive(live.pid), 5000);
    } finally {
      await closeHost(live);
    }
  }, 30_000);
});
