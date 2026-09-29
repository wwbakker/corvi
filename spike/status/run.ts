/**
 * The Phase 2 runner: exercises the two status transports end to end against the real presenter
 * and the real attention-edge rule, and prints one `READY {json}` line with the checks and
 * latencies. `run.sh` turns those checks into shell assertions.
 *
 * Transport (a) is a reporter shelling out to a `corvi`-like CLI that POSTs to a stub endpoint;
 * transport (b) is a reporter emitting an OSC sequence the host parses and strips. Identity in
 * both cases is `CORVI_SESSION_ID` + `CORVI_SESSION_INCARNATION`, seeded by the host into the pty.
 * The HTTP store is keyed by `sessionId#incarnation`, so a dead or reopened id cannot present a
 * previous incarnation's status.
 */
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { ensureHost } from "../terminal-host/client.ts";
import { attentionEdges, median, presentedFromStatus, presentedWindows, type ChangedWindow, type StatusRecord } from "./status.ts";

const argOf = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const cliPath = fileURLToPath(new URL("./corvi-status.ts", import.meta.url));
const oscPath = fileURLToPath(new URL("./osc-reporter.ts", import.meta.url));
const SOUND = "spike-ping";

const socket = argOf("--socket");
const checkout = argOf("--checkout") ?? process.cwd();
if (socket === undefined) {
  console.error("usage: run.ts --socket <path> [--checkout <path>]");
  process.exit(2);
}

const checks: Record<string, boolean> = {};
const set = (name: string, value: boolean): void => {
  checks[name] = value;
};
const latencies: Record<string, { samples: number; medianMs: number; maxMs: number }> = {};
const changeOf = (sessionId: string): string => (sessionId === "s2" ? "C2" : "C1");

// --- (a) the stub endpoint the CLI posts to -----------------------------------------------------
type Stored = StatusRecord & { readonly incarnation: number };
const store = new Map<string, Stored>();
const cap = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
const parsePayload = (body: unknown):
  | { sessionId: string; incarnation: number; status: "working" | "waiting" | "clear"; name?: string; sessionName?: string; message?: string }
  | undefined => {
  if (typeof body !== "object" || body === null) return undefined;
  const value = body as Record<string, unknown>;
  if (typeof value.sessionId !== "string" || value.sessionId.length === 0) return undefined;
  if (typeof value.incarnation !== "number" || !Number.isInteger(value.incarnation) || value.incarnation < 0) return undefined;
  if (value.status !== "working" && value.status !== "waiting" && value.status !== "clear") return undefined;
  const name = cap(value.name, 120);
  const sessionName = cap(value.sessionName, 120);
  const message = cap(value.message, 400);
  return {
    sessionId: value.sessionId,
    incarnation: value.incarnation,
    status: value.status,
    ...(name ? { name } : {}),
    ...(sessionName ? { sessionName } : {}),
    ...(message ? { message } : {}),
  };
};

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/status") {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.statusCode = 400;
        res.end();
        return;
      }
      const payload = parsePayload(parsed);
      if (payload === undefined) {
        res.statusCode = 400;
        res.end();
        return;
      }
      const key = `${payload.sessionId}#${payload.incarnation}`;
      if (payload.status === "clear") store.delete(key);
      else {
        store.set(key, {
          incarnation: payload.incarnation,
          state: payload.status,
          ...(payload.name ? { name: payload.name } : {}),
          ...(payload.sessionName ? { sessionName: payload.sessionName } : {}),
          ...(payload.message ? { message: payload.message } : {}),
          at: new Date().toISOString(),
        });
      }
      res.end("ok");
    });
    return;
  }
  if (req.method === "GET" && req.url === "/api/status") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(Object.fromEntries(store)));
    return;
  }
  res.statusCode = 404;
  res.end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const statusUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.CORVI_STATUS_URL = statusUrl;

const { client, adopted } = await ensureHost({ socket, checkout, buildId: "phase2" });
checks["host.startedFresh"] = adopted === false;

const waitTrue = async (predicate: () => Promise<boolean> | boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(10);
  }
  return false;
};
const incarnationOf = async (id: string): Promise<number | undefined> =>
  (await client.list()).find((session) => session.id === id)?.incarnation;
const waitDead = (id: string): Promise<boolean> =>
  waitTrue(async () => (await client.list()).find((session) => session.id === id)?.alive === false, 5000);

const setStatus = async (
  sessionId: string,
  status: string,
  options: { name?: string; sessionName?: string; message?: string } = {},
): Promise<void> => {
  const incarnation = await incarnationOf(sessionId);
  if (incarnation === undefined) throw new Error(`no session ${sessionId} to report for`);
  await new Promise<void>((resolve, reject) => {
    execFile(
      process.execPath,
      [
        cliPath,
        status,
        ...(options.name ? ["--name", options.name] : []),
        ...(options.sessionName ? ["--session-name", options.sessionName] : []),
        ...(options.message ? ["--message", options.message] : []),
      ],
      { env: { ...process.env, CORVI_SESSION_ID: sessionId, CORVI_SESSION_INCARNATION: String(incarnation) } },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(`status CLI failed: ${stderr || error.message}`));
        if (stdout.length > 0) return reject(new Error(`the status CLI wrote to stdout: ${JSON.stringify(stdout)}`));
        resolve();
      },
    );
  });
};

/** Present the live sessions, joining the HTTP store by `(id, incarnation)` and reaping entries
 * for dead incarnations as they are observed. */
const presentHttp = async (): Promise<ChangedWindow[]> => {
  const sessions = await client.list();
  for (const session of sessions) if (!session.alive) store.delete(`${session.id}#${session.incarnation}`);
  const liveSessions = sessions.filter((session) => session.alive);
  const statuses = new Map(liveSessions.map((session) => [session.id, store.get(`${session.id}#${session.incarnation}`)]));
  return presentedWindows(liveSessions, (id) => statuses.get(id)).map((window) => ({ change: changeOf(window.id), window }));
};
const presentOsc = async (): Promise<ChangedWindow[]> => {
  const sessions = await client.list();
  const statuses = new Map(sessions.map((session) => [session.id, session.status]));
  return presentedWindows(sessions.filter((session) => session.alive), (id) => statuses.get(id)).map((window) => ({
    change: changeOf(window.id),
    window,
  }));
};

// --- identity: the host seeds CORVI_SESSION_ID / _INCARNATION and wins over a caller env ----------
{
  const seen: string[] = [];
  client.onData("sId", (data) => seen.push(data.toString("utf8")));
  await client.open("sId", {
    cwd: checkout,
    command: ["/bin/sh", "-c", 'printf "ID=%s INC=%s\\n" "$CORVI_SESSION_ID" "$CORVI_SESSION_INCARNATION"; sleep 4'],
  });
  await client.attach("sId");
  await waitTrue(() => seen.join("").includes("INC=1"), 4000);
  set("identity.hostSeedsEnv", seen.join("").includes("ID=sId INC=1"));

  const overridden: string[] = [];
  client.onData("sEnv", (data) => overridden.push(data.toString("utf8")));
  await client.open("sEnv", {
    cwd: checkout,
    command: ["/bin/sh", "-c", 'printf "ID=%s INC=%s\\n" "$CORVI_SESSION_ID" "$CORVI_SESSION_INCARNATION"; sleep 4'],
    env: { CORVI_SESSION_ID: "spoofed", CORVI_SESSION_INCARNATION: "99" },
  });
  await client.attach("sEnv");
  await waitTrue(() => overridden.join("").includes("INC=1"), 4000);
  set("identity.hostWinsOverCallerEnv", overridden.join("").includes("ID=sEnv INC=1"));
}

// --- (a) a reporter inside the pty posts via its seeded id, writing nothing to the pty -----------
{
  const seen: string[] = [];
  client.onData("sRep", (data) => seen.push(data.toString("utf8")));
  const script = `const{execFileSync}=require("node:child_process");const out=execFileSync(process.execPath,[${JSON.stringify(cliPath)},"working","--name","pi"],{encoding:"utf8"});process.stdout.write("CLI_BYTES="+out.length+"\\n")`;
  await client.open("sRep", { cwd: checkout, command: [process.execPath, "-e", script] });
  await client.attach("sRep");
  await waitTrue(() => seen.join("").includes("CLI_BYTES="), 5000);
  set("http.reporterInsidePtyUsesHostEnv", await waitTrue(async () => store.get(`sRep#${await incarnationOf("sRep")}`)?.state === "working", 4000));
  set("http.cliWritesNothingToPty", seen.join("").includes("CLI_BYTES=0"));
}

// --- long-lived sessions for the controlled flows -------------------------------------------------
for (const id of ["s1", "s1b", "s2", "sPlain"]) {
  await client.open(id, { cwd: checkout, command: ["/bin/sh", "-c", "sleep 60"] });
}

// --- (a) merge, label, the edge, two windows one change, clear, kill, reopen, plain shell ---------
{
  await setStatus("s1", "working", { name: "pi", sessionName: "Fix login" });
  let previous = new Map<string, boolean>();
  let seeded = false;
  let windows = await presentHttp();
  ({ seeded } = attentionEdges(previous, seeded, windows, SOUND));
  const working = windows.find((entry) => entry.window.id === "s1")?.window;
  set("http.presentWorking", working?.icon === "agent" && working?.state === "ok" && working?.busy === true && working?.attention === false);
  set("http.labelFromSessionName", working?.label === "Fix login");

  await setStatus("s1", "waiting", { name: "pi", sessionName: "Fix login", message: "needs you" });
  windows = await presentHttp();
  let edges = attentionEdges(previous, seeded, windows, SOUND);
  seeded = edges.seeded;
  const first = edges.notify;
  windows = await presentHttp();
  edges = attentionEdges(previous, seeded, windows, SOUND);
  await setStatus("s1", "waiting", { name: "pi", sessionName: "Fix login", message: "needs you" });
  windows = await presentHttp();
  edges = attentionEdges(previous, seeded, windows, SOUND);
  set(
    "http.notifyExactlyOnce",
    first.length === 1 &&
      first[0]?.change === "C1" &&
      first[0]?.window === "s1" &&
      first[0]?.sound === SOUND &&
      edges.notify.length === 0,
  );

  // Two windows of one change: both may notify, keyed apart; and the same window id in two
  // changes is tracked separately.
  await setStatus("s1", "clear");
  await setStatus("s1b", "clear");
  const twoPrev = new Map<string, boolean>();
  const seededRead = attentionEdges(twoPrev, false, await presentHttp(), SOUND);
  await setStatus("s1b", "waiting", { name: "pi", sessionName: "Other", message: "also" });
  await setStatus("s1", "waiting", { name: "pi", sessionName: "Fix login", message: "one" });
  const twoEdges = attentionEdges(twoPrev, seededRead.seeded, await presentHttp(), SOUND);
  set(
    "http.twoWindowsOneChange",
    twoEdges.notify.length === 2 &&
      twoEdges.notify.every((notify) => notify.change === "C1") &&
      new Set(twoEdges.notify.map((notify) => notify.window)).size === 2,
  );

  // The same window id in two changes is two edges, not one.
  const crossPrev = new Map<string, boolean>();
  const calm = presentedFromStatus("w", undefined);
  const attentive = presentedFromStatus("w", { state: "waiting", name: "pi", at: new Date().toISOString() });
  attentionEdges(crossPrev, false, [
    { change: "C1", window: calm },
    { change: "C2", window: calm },
  ], SOUND);
  const crossEdges = attentionEdges(crossPrev, true, [
    { change: "C1", window: attentive },
    { change: "C2", window: attentive },
  ], SOUND);
  set(
    "edge.crossChangeKeying",
    crossEdges.notify.length === 2 &&
      crossEdges.notify.every((notify) => notify.window === "w") &&
      crossPrev.has("C1:w") &&
      crossPrev.has("C2:w"),
  );

  await setStatus("s2", "waiting", { name: "opencode", message: "choose one" });
  windows = await presentHttp();
  const s1 = windows.find((entry) => entry.window.id === "s1")?.window;
  const s2 = windows.find((entry) => entry.window.id === "s2")?.window;
  set(
    "http.twoSessionsIndependent",
    s1?.icon === "agent" && s1?.attention === true && s2?.icon === "agent" && s2?.state === "idle" && s2?.attention === true,
  );

  await setStatus("s1b", "clear");
  await setStatus("s1", "clear");
  windows = await presentHttp();
  set("http.explicitClear", windows.find((entry) => entry.window.id === "s1")?.window.icon === "terminal");

  // Real lifecycle: a session that reported waiting is killed; its status must not survive, and
  // reopening the id with a new incarnation must not present stale agent state.
  await setStatus("s2", "waiting", { name: "opencode", message: "still waiting" });
  await client.kill("s2");
  await waitDead("s2");
  windows = await presentHttp();
  set("http.statusGoneOnKill", !windows.some((entry) => entry.window.id === "s2") && !store.has("s2#1"));
  await client.open("s2", { cwd: checkout, command: ["/bin/sh", "-c", "sleep 60"] });
  windows = await presentHttp();
  const reopened = windows.find((entry) => entry.window.id === "s2")?.window;
  set("http.reopenNoStale", reopened?.icon === "terminal" && reopened?.attention === false && !store.has("s2#2"));

  const plain = windows.find((entry) => entry.window.id === "sPlain")?.window;
  set("http.plainShellIsTerminal", plain?.icon === "terminal" && plain?.attention === false && plain?.busy === false);
}

// --- (b) OSC: the host parses and strips it ------------------------------------------------------
{
  const seen: string[] = [];
  client.onData("s3", (data) => seen.push(data.toString("utf8")));
  await client.open("s3", {
    cwd: checkout,
    command: [process.execPath, oscPath, "working", "pi", "--session-name", "Osc session", "--sequence"],
  });
  await client.attach("s3");
  await waitTrue(async () => (await client.list()).find((s) => s.id === "s3")?.status?.state === "working", 5000);
  let previous = new Map<string, boolean>();
  let seeded = false;
  let windows = await presentOsc();
  ({ seeded } = attentionEdges(previous, seeded, windows, SOUND));
  await waitTrue(async () => (await client.list()).find((s) => s.id === "s3")?.status?.state === "waiting", 5000);
  windows = await presentOsc();
  let edges = attentionEdges(previous, seeded, windows, SOUND);
  seeded = edges.seeded;
  const first = edges.notify;
  windows = await presentOsc();
  edges = attentionEdges(previous, seeded, windows, SOUND);
  const oscWindow = windows.find((entry) => entry.window.id === "s3")?.window;
  set("osc.present", oscWindow?.state === "idle" && oscWindow?.icon === "agent");
  set("osc.labelFromSessionName", oscWindow?.label === "Osc session");
  set("osc.notifyExactlyOnce", first.length === 1 && first[0]?.window === "s3" && edges.notify.length === 0);

  const joined = seen.join("");
  set("osc.stripped", joined.includes("reporter wrote osc") && !joined.includes("\x1b]1337;corvi="));
  await client.kill("s3");
  await waitDead("s3");
  windows = await presentOsc();
  set("osc.clearedOnSessionEnd", !windows.some((entry) => entry.window.id === "s3"));
}

// --- the held carry is flushed on exit, so a partial introducer is not swallowed -----------------
{
  const seen: string[] = [];
  client.onData("sFlush", (data) => seen.push(data.toString("utf8")));
  await client.open("sFlush", { cwd: checkout, command: ["/bin/sh", "-c", "printf '\\033]1337;cor'; exit"] });
  await client.attach("sFlush");
  await waitDead("sFlush");
  await sleep(100);
  set("osc.carryFlushedOnExit", seen.join("").includes("\x1b]1337;cor"));
}

// --- latency -------------------------------------------------------------------------------------
{
  await client.open("sLat", { cwd: checkout, command: ["/bin/sh", "-c", "sleep 60"] });
  const cli: number[] = [];
  for (let i = 0; i < 20; i++) {
    const state = i % 2 === 0 ? "working" : "waiting";
    const start = performance.now();
    await setStatus("sLat", state, { name: "pi" });
    const incarnation = await incarnationOf("sLat");
    while (store.get(`sLat#${incarnation}`)?.state !== state) await sleep(1);
    cli.push(performance.now() - start);
  }
  latencies["httpCliMs"] = { samples: cli.length, medianMs: Number(median(cli).toFixed(2)), maxMs: Number(Math.max(...cli).toFixed(2)) };

  const direct: number[] = [];
  for (let i = 0; i < 20; i++) {
    const state = i % 2 === 0 ? "working" : "waiting";
    const incarnation = await incarnationOf("sLat");
    const start = performance.now();
    await fetch(`${process.env.CORVI_STATUS_URL}/api/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "sLat", incarnation, status: state, name: "pi" }),
    });
    while (store.get(`sLat#${incarnation}`)?.state !== state) await sleep(1);
    direct.push(performance.now() - start);
  }
  latencies["httpDirectMs"] = { samples: direct.length, medianMs: Number(median(direct).toFixed(2)), maxMs: Number(Math.max(...direct).toFixed(2)) };
}
{
  await client.open("sLat2", { cwd: checkout, command: ["/bin/sh"] });
  await client.attach("sLat2");
  const osc: number[] = [];
  for (let i = 0; i < 10; i++) {
    const state = i % 2 === 0 ? "working" : "waiting";
    const payload = Buffer.from(JSON.stringify({ status: state, name: "pi" }), "utf8").toString("base64");
    const start = performance.now();
    await client.write("sLat2", `printf '\\033]1337;corvi=${payload}\\007'\n`);
    while ((await client.list()).find((session) => session.id === "sLat2")?.status?.state !== state) await sleep(1);
    osc.push(performance.now() - start);
  }
  latencies["oscMs"] = { samples: osc.length, medianMs: Number(median(osc).toFixed(2)), maxMs: Number(Math.max(...osc).toFixed(2)) };
}

server.close();
await client.shutdown().catch(() => undefined);
console.log(`READY ${JSON.stringify({ checks, latencies })}`);
await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
process.exit(0);
