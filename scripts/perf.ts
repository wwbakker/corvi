/**
 * Times how expensive it is to render the app's window, in the engine the app actually uses.
 *
 *   bun run perf                       # what the Linux app does: DOM renderer, compositing off
 *   bun run perf --compare             # DOM against canvas, the regression that was fixed
 *   bun run perf --renderer=canvas
 *   bun run perf --seconds=10 --size=1200x800
 *
 * Why this exists
 * ---------------
 * WebKitGTK on this machine (NVIDIA/Wayland) can only take the software-composited path: with
 * accelerated compositing on, canvas updates are presented a frame late, so the Linux window
 * turns it off (`scripts/app/linux-window/iwe-window.py`). In that path the xterm renderer is
 * decisive. A full-size terminal whose status line repaints about twelve times a second held the
 * WebProcess main thread at ~70% of a core (plus ~20% in the UI process) with ttyd's canvas
 * renderers, and the whole app felt it as roughly half a second between a keystroke — or a menu
 * hover — and the screen. xterm's DOM renderer puts the same workload at ~6% and the app stays
 * responsive; that is why `terminalPath` asks for `rendererType=dom` on Linux.
 *
 * What it does
 * ------------
 * Starts a private ttyd running `scripts/perf/workload.sh` (a TUI-like animation), loads it in a
 * bare WebKitGTK window with the app's environment, and samples the CPU of the window's UI
 * process and its Web process. A responsive terminal is a few percent of one core; anything near
 * a full core is the regression. It measures the engine, not the app: the URL is ttyd's directly,
 * because the renderer and the compositing workarounds are engine-level, and IWE's proxy would
 * only add a variable.
 *
 * The window goes to workspace 6 without stealing focus (the launch-workspace convention), which
 * needs a compositor that can place it. On Hyprland 0.56 `hyprctl dispatch` is Lua, hence the
 * `hl.dsp.exec_cmd` call; everywhere else the window is launched directly.
 */

import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);

/** `--name=value`, or the fallback. */
function option(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit === undefined ? fallback : hit.slice(prefix.length);
}

/** A bare `--name`. */
const flag = (name: string): boolean => args.includes(`--${name}`);

/** `1600x1000`, or the fallback. */
function size(value: string, fallback: { width: number; height: number }): { width: number; height: number } {
  const [w, h] = value.split("x");
  const width = Number(w);
  const height = Number(h);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    console.error(`--size must look like 1600x1000, got ${JSON.stringify(value)}`);
    process.exit(1);
  }
  return { width, height };
}

const root = resolve(import.meta.dir, "..");
const windowPy = join(root, "scripts", "perf", "window.py");
const workload = join(root, "scripts", "perf", "workload.sh");
const hyprland = Bun.which("hyprctl") !== null && process.env.HYPRLAND_INSTANCE_SIGNATURE !== undefined;

type Result = { renderer: string; loaded?: string; ui: number; web: number };

/** A free loopback port: bind to 0, read it, close. The race with another process taking it is
 * the same one scripts/app/linux.ts accepts, and it is visible rather than silent. */
async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.on("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

/** `utime + stime` in clock ticks, or undefined when the process is already gone. */
function cpuTicks(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm can contain spaces and parentheses, so the fields are counted from the last ")".
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const utime = Number(fields[11]);
    const stime = Number(fields[12]);
    return Number.isFinite(utime) && Number.isFinite(stime) ? utime + stime : undefined;
  } catch {
    return undefined;
  }
}

/** The direct children of a process, as Linux itself reports them. */
function childrenOf(pid: number): number[] {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

/** The WebKitWebProcess among a UI process's children: the one that paints the page. */
function webProcessOf(uiPid: number): number | undefined {
  return childrenOf(uiPid).find((child) => {
    try {
      return readFileSync(`/proc/${child}/cmdline`, "utf8").includes("WebKitWebProcess");
    } catch {
      return false;
    }
  });
}

/** The renderer ttyd said it loaded, read from the page's console in the window's log. */
function rendererIn(log: string): string | undefined {
  if (!existsSync(log)) return undefined;
  for (const line of readFileSync(log, "utf8").split("\n")) {
    const hit = /\[ttyd\] (\S+) renderer loaded/.exec(line);
    if (hit?.[1] !== undefined) return hit[1];
  }
  return undefined;
}

/** Clock ticks per second, the unit `cpuTicks` counts in. */
function clockTicks(): number {
  const out = Bun.spawnSync(["getconf", "CLK_TCK"]).stdout.toString().trim();
  const hz = Number(out);
  return Number.isFinite(hz) && hz > 0 ? hz : 100;
}

/** Wait for a file to hold a pid: the window writes it as its first act. */
async function waitForPid(file: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const pid = Number(readFileSync(file, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    await Bun.sleep(100);
  }
  throw new Error(`the window never wrote its pid to ${file}`);
}

/** Wait for ttyd to answer, so the window does not load a refused connection. */
async function waitForTtyd(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(100);
  }
  throw new Error(`ttyd did not come up on 127.0.0.1:${port}`);
}

/** Single-quote a value for the `sh -c` Hyprland's exec_cmd runs. */
const quoted = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

type Window = { width: number; height: number; url: string; log: string; pidFile: string };

/** Start the WebKitGTK window, on workspace 6 when a compositor can put it there. */
async function launchWindow(o: Window): Promise<number> {
  const perfEnv: Record<string, string> = {
    PERF_W: String(o.width),
    PERF_H: String(o.height),
    PERF_PID_FILE: o.pidFile,
    // The same workarounds the app's Linux window sets; export one to test another value.
    WEBKIT_DISABLE_DMABUF_RENDERER: process.env.WEBKIT_DISABLE_DMABUF_RENDERER ?? "1",
    WEBKIT_DISABLE_COMPOSITING_MODE: process.env.WEBKIT_DISABLE_COMPOSITING_MODE ?? "1",
  };

  if (hyprland) {
    const env = Object.entries(perfEnv)
      .map(([name, value]) => `${name}=${quoted(value)}`)
      .join(" ");
    const inner = `env ${env} python3 ${quoted(windowPy)} ${quoted(o.url)} > ${quoted(o.log)} 2>&1`;
    const dispatched = Bun.spawnSync(
      ["hyprctl", "dispatch", `hl.dsp.exec_cmd(${JSON.stringify(inner)}, { workspace = "6 silent", suppress_event = "activate" })`],
      { stderr: "pipe" },
    );
    if (dispatched.exitCode === 0) {
      try {
        return await waitForPid(o.pidFile, 6000);
      } catch {
        // Older Hyprland: fall back to launching it here.
      }
    }
  }

  const fd = openSync(o.log, "w");
  const proc = Bun.spawn(["python3", windowPy, o.url], {
    env: { ...process.env, ...perfEnv },
    stdout: fd,
    stderr: fd,
  });
  closeSync(fd);
  return proc.pid;
}

/** Kill without caring whether it is already gone. */
function end(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** The main event: one renderer, one workload, one number. */
async function measure(
  renderer: string,
  o: { width: number; height: number; warmup: number; seconds: number },
): Promise<Result> {
  const dir = mkdtempSync(join(tmpdir(), "iwe-perf-"));
  const log = join(dir, "window.log");
  const pidFile = join(dir, "window.pid");
  const port = await freePort();
  const ttyd = Bun.spawn(["ttyd", "-p", String(port), "-i", "lo", "-t", "fontSize=13", workload], {
    stdout: "ignore",
    stderr: "ignore",
  });
  let uiPid: number | undefined;
  let webPid: number | undefined;

  try {
    await waitForTtyd(port, 5000);
    uiPid = await launchWindow({
      ...o,
      url: `http://127.0.0.1:${port}/?rendererType=${renderer}`,
      log,
      pidFile,
    });

    const deadline = Date.now() + 8000;
    while (webPid === undefined && Date.now() < deadline) {
      webPid = webProcessOf(uiPid);
      if (webPid === undefined) await Bun.sleep(100);
    }
    if (webPid === undefined) throw new Error("the window has no WebKitWebProcess — did it start?");

    // Let the terminal finish loading and painting before the sample window opens.
    await Bun.sleep(o.warmup * 1000);
    const hz = clockTicks();
    const uiBefore = cpuTicks(uiPid);
    const webBefore = cpuTicks(webPid);
    await Bun.sleep(o.seconds * 1000);
    const uiAfter = cpuTicks(uiPid);
    const webAfter = cpuTicks(webPid);
    if (uiBefore === undefined || webBefore === undefined || uiAfter === undefined || webAfter === undefined) {
      throw new Error("a process went away while it was being measured");
    }

    const percent = (ticks: number): number => Math.round((ticks / hz / o.seconds) * 100);
    return {
      renderer,
      loaded: rendererIn(log),
      ui: percent(uiAfter - uiBefore),
      web: percent(webAfter - webBefore),
    };
  } finally {
    end(webPid);
    end(uiPid);
    ttyd.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Print one result the way the reader will compare it. */
function report(result: Result, o: { width: number; height: number; seconds: number }): void {
  const total = result.ui + result.web;
  console.log(`renderer ${result.renderer}${result.loaded === undefined ? "" : ` (loaded: ${result.loaded})`}`);
  console.log(`  UI process   ${String(result.ui).padStart(4)}% of one core`);
  console.log(`  Web process  ${String(result.web).padStart(4)}% of one core`);
  console.log(`  total        ${String(total).padStart(4)}% of one core`);
  if (total > 50) {
    console.log("  → a terminal this expensive starves the main thread; input latency follows");
  }
  console.log(`  window ${o.width}x${o.height}, ${o.seconds}s sample\n`);
}

async function main(): Promise<void> {
  for (const tool of ["ttyd", "python3"]) {
    if (Bun.which(tool) === null) {
      console.error(`${tool} is not installed — this probe needs it`);
      process.exit(1);
    }
  }

  const { width, height } = size(option("size", "1600x1000"), { width: 1600, height: 1000 });
  const seconds = Number(option("seconds", "6"));
  const warmup = Number(option("warmup", "3"));
  const renderers = flag("compare") ? ["dom", "canvas"] : [option("renderer", "dom")];
  const o = { width, height, seconds, warmup };

  console.log("IWE window rendering probe");
  console.log("  engine    WebKitGTK (python3 + webkit2gtk-4.1)");
  console.log(`  env       WEBKIT_DISABLE_DMABUF_RENDERER=${process.env.WEBKIT_DISABLE_DMABUF_RENDERER ?? "1"} WEBKIT_DISABLE_COMPOSITING_MODE=${process.env.WEBKIT_DISABLE_COMPOSITING_MODE ?? "1"}`);
  console.log(`  workload  a full-width status line, repainting ~12 times a second`);
  console.log(`  sample    ${seconds}s after ${warmup}s warmup\n`);

  for (const renderer of renderers) report(await measure(renderer, o), o);
}

await main();
