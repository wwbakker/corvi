/**
 * The Phase 2 runner: exercises the two status transports end to end against the real presenter
 * and the real attention-edge rule, and prints one `READY {json}` line with the checks and
 * latencies. `run.sh` turns those checks into shell assertions.
 *
 * Transport (a) is a reporter shelling out to a `corvi`-like CLI that POSTs to a stub endpoint;
 * transport (b) is a reporter emitting an OSC sequence the host parses and strips. Identity in
 * both cases is `CORVI_SESSION_ID`, seeded by the host into the pty.
 */
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { ensureHost, type HostClient, type SessionInfo } from "../terminal-host/client.ts";
import { attentionEdges, median, presentedWindows, type StatusRecord } from "./status.ts";

const argOf = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const cliPath = fileURLToPath(new URL("./corvi-status.ts", import.meta.url));
const oscPath = fileURLToPath(new URL("./osc-reporter.ts", import.meta.url));

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

// --- (a) the stub endpoint the CLI posts to -----------------------------------------------------
const store = new Map<string, StatusRecord>();
const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/status") {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body) as { sessionId?: string; status?: string; name?: string; message?: string };
        if (typeof parsed.sessionId !== "string" || typeof parsed.status !== "string") throw new Error("bad body");
        if (parsed.status === "clear") store.delete(parsed.sessionId);
        else {
          store.set(parsed.sessionId, {
            state: parsed.status === "working" ? "working" : "waiting",
            ...(parsed.name ? { name: parsed.name } : {}),
            ...(parsed.message ? { message: parsed.message } : {}),
            at: new Date().toISOString(),
          });
        }
        res.end("ok");
      } catch {
        res.statusCode = 400;
        res.end();
      }
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
process.env.CORVI_STATUS_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const setStatus = (sessionId: string, status: string, name?: string, message?: string): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cliPath, status, ...(name ? ["--name", name] : []), ...(message ? ["--message", message] : [])],
      { env: { ...process.env, CORVI_SESSION_ID: sessionId } },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(`status CLI failed: ${stderr || error.message}`));
        if (stdout.length > 0) return reject(new Error(`the status CLI wrote to stdout: ${JSON.stringify(stdout)}`));
        resolve();
      },
    );
  });

const { client, adopted } = await ensureHost({ socket, checkout, buildId: "phase2" });
checks["host.adopted"] = adopted === false;

const live = async (): Promise<SessionInfo[]> => (await client.list()).filter((session) => session.alive);
const presentHttp = async () => presentedWindows(await live(), (id) => store.get(id));
const presentOsc = async () => {
  const sessions = await client.list();
  const statuses = new Map(sessions.map((session) => [session.id, session.status]));
  return presentedWindows(sessions.filter((session) => session.alive), (id) => statuses.get(id));
};

const waitTrue = async (predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(10);
  }
  return false;
};
const waitOscState = (id: string, state: string): Promise<boolean> =>
  waitTrue(async () => (await client.list()).find((session) => session.id === id)?.status?.state === state, 5000);
const waitDead = (id: string): Promise<boolean> =>
  waitTrue(async () => (await client.list()).find((session) => session.id === id)?.alive === false, 5000);

// --- identity: the host seeds CORVI_SESSION_ID / _INCARNATION ------------------------------------
{
  const seen: string[] = [];
  client.onData("sId", (data) => seen.push(data.toString("utf8")));
  await client.open("sId", {
    cwd: checkout,
    command: ["/bin/sh", "-c", 'printf "ID=%s INC=%s\\n" "$CORVI_SESSION_ID" "$CORVI_SESSION_INCARNATION"; sleep 4'],
  });
  await client.attach("sId");
  await waitTrue(async () => seen.join("").includes("INC=1"), 4000);
  set("identity.hostSeedsEnv", seen.join("").includes("ID=sId INC=1"));
}

// --- (a) a reporter inside the pty reaches the endpoint via its seeded id -------------------------
{
  await client.open("sRep", {
    cwd: checkout,
    command: ["/bin/sh", "-c", `${process.execPath} ${cliPath} working --name pi; sleep 4`],
  });
  set("http.reporterInsidePtyUsesHostEnv", await waitTrue(async () => store.get("sRep")?.state === "working", 4000));
}

// --- long-lived sessions for the controlled flows -------------------------------------------------
for (const id of ["s1", "s2", "sPlain"]) {
  await client.open(id, { cwd: checkout, command: ["/bin/sh", "-c", "sleep 60"] });
}

// --- (a) merge, two sessions, the notification edge, clear, session end, plain shell --------------
{
  await setStatus("s1", "working", "pi");
  let previous = new Map<string, boolean>();
  let seeded = false;
  let windows = await presentHttp();
  ({ seeded } = attentionEdges(previous, seeded, windows));
  const working = windows.find((window) => window.id === "s1");
  set(
    "http.presentWorking",
    working?.icon === "agent" && working?.state === "ok" && working?.busy === true && working?.attention === false,
  );

  await setStatus("s1", "waiting", "pi", "needs you");
  windows = await presentHttp();
  let edges = attentionEdges(previous, seeded, windows);
  seeded = edges.seeded;
  const first = edges.notify;
  windows = await presentHttp();
  edges = attentionEdges(previous, seeded, windows);
  const second = edges.notify;
  await setStatus("s1", "waiting", "pi", "needs you");
  windows = await presentHttp();
  edges = attentionEdges(previous, seeded, windows);
  set(
    "http.notifyExactlyOnce",
    first.length === 1 && first[0]?.id === "s1" && first[0]?.note === "needs you" && second.length === 0 && edges.notify.length === 0,
  );

  await setStatus("s1", "working", "pi");
  await setStatus("s2", "waiting", "opencode", "choose one");
  windows = await presentHttp();
  const s1 = windows.find((window) => window.id === "s1");
  const s2 = windows.find((window) => window.id === "s2");
  set(
    "http.twoSessionsIndependent",
    s1?.icon === "agent" &&
      s1?.state === "ok" &&
      s1?.attention === false &&
      s2?.icon === "agent" &&
      s2?.state === "idle" &&
      s2?.attention === true &&
      s2?.note === "choose one",
  );

  await setStatus("s1", "clear");
  windows = await presentHttp();
  const cleared = windows.find((window) => window.id === "s1");
  set("http.clearOnSessionEnd", cleared?.icon === "terminal" && cleared?.attention === false && cleared?.busy === false);

  await client.kill("s2");
  await waitDead("s2");
  windows = await presentHttp();
  set("http.deadSessionGone", !windows.some((window) => window.id === "s2"));

  const plain = windows.find((window) => window.id === "sPlain");
  set("http.plainShellIsTerminal", plain?.icon === "terminal" && plain?.attention === false && plain?.busy === false);
}

// --- (b) OSC: the host parses and strips it ------------------------------------------------------
{
  const seen: string[] = [];
  client.onData("s3", (data) => seen.push(data.toString("utf8")));
  await client.open("s3", { cwd: checkout, command: [process.execPath, oscPath, "working", "pi", "--sequence"] });
  await client.attach("s3");
  await waitOscState("s3", "working");
  let previous = new Map<string, boolean>();
  let seeded = false;
  let windows = await presentOsc();
  ({ seeded } = attentionEdges(previous, seeded, windows));
  await waitOscState("s3", "waiting");
  windows = await presentOsc();
  let edges = attentionEdges(previous, seeded, windows);
  seeded = edges.seeded;
  const first = edges.notify;
  windows = await presentOsc();
  edges = attentionEdges(previous, seeded, windows);
  set("osc.present", windows.find((window) => window.id === "s3")?.state === "idle" && windows.find((window) => window.id === "s3")?.icon === "agent");
  set("osc.notifyExactlyOnce", first.length === 1 && first[0]?.id === "s3" && edges.notify.length === 0);

  const joined = seen.join("");
  set("osc.stripped", joined.includes("reporter wrote osc") && !joined.includes("\x1b]1337;corvi="));
  await client.kill("s3");
  await waitDead("s3");
  windows = await presentOsc();
  set("osc.clearedOnSessionEnd", !windows.some((window) => window.id === "s3"));
}

// --- latency -------------------------------------------------------------------------------------
{
  await client.open("sLat", { cwd: checkout, command: ["/bin/sh", "-c", "sleep 60"] });
  const http: number[] = [];
  for (let i = 0; i < 20; i++) {
    const state = i % 2 === 0 ? "working" : "waiting";
    const start = performance.now();
    await setStatus("sLat", state, "pi");
    while (store.get("sLat")?.state !== state) await sleep(1);
    http.push(performance.now() - start);
  }
  latencies["httpMs"] = { samples: http.length, medianMs: Number(median(http).toFixed(2)), maxMs: Number(Math.max(...http).toFixed(2)) };
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
