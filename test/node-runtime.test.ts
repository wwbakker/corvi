import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { electronBinary } from "@corvi/desktop/binary";
import { testRun, testTempDir, waitForUrl } from "./helpers.ts";

/**
 * The server, on the runtime the app uses.
 *
 * The suite runs the server on Node, but the app runs it under Electron's own Node
 * (docs/manual/install.md). This is the one test that proves the app's binary can do it
 * for real: the same `apps/server/src/server.ts`, booted with
 * `ELECTRON_RUN_AS_NODE=1` (Node's type stripping runs the TypeScript), serving its page — which
 * means esbuild built it inside that process — and answering an API call.
 *
 * The port is the operating system's (`CORVI_PORT=0`) and readiness is the server's own line
 * (`corvi on <url>`) rather than a guess: a random port picked here once landed on a busy one, and
 * then the test said only "connection refused".
 *
 * The binary is found the way the app finds it (apps/desktop/src/electron/binary.ts), not at a
 * hardcoded `dist/electron`: that path is Linux's alone, so on macOS this test — the only one
 * that runs the server on the runtime the app uses — skipped itself instead of failing.
 */
const electron = electronBinary(process.cwd());
const usable = existsSync(electron);

let tmp: string;
let url: string;
let server: ReturnType<typeof Bun.spawn> | undefined;

beforeAll(async () => {
  if (!usable) return;
  tmp = await testTempDir("node-runtime");
  const env = {
    ...process.env,
    CORVI_ROOT: join(tmp, "changes"),
    CORVI_CONFIG: join(tmp, "config.json"),
    CORVI_CACHE: join(tmp, "state.json"),
    // The built page and chunks go here, not into the running app's state directory: a test run
    // beside the real app must not rebuild the files it is serving.
    XDG_STATE_HOME: join(tmp, "state"),
    // The OS picks; the readiness line reports what it picked.
    CORVI_PORT: "0",
    // The one variable that turns Electron's binary into the Node that runs the server, which
    // is what the app's window does (apps/desktop/src/electron/main.ts).
    ELECTRON_RUN_AS_NODE: "1",
  };
  server = Bun.spawn([electron, "apps/server/src/server.ts", `--corvi-test-run=${testRun()}`], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    // Shared with the other server-spawning tests (test/helpers.ts). The trailing slash the
    // server reports is dropped there, so it is restored for the page assertions below.
    url = `${await waitForUrl(server)}/`;
  } catch (e) {
    const errors = await new Response(server.stderr as ReadableStream).text().catch(() => "");
    throw new Error(`${e instanceof Error ? e.message : String(e)}\n${errors}`);
  }
});

afterAll(async () => {
  server?.kill();
  if (tmp !== undefined) await rm(tmp, { recursive: true, force: true });
});

test.skipIf(!usable)(
  "the server runs on Electron's Node, page and all",
  async () => {
    const page = await fetch(url).then((r) => r.text());
    expect(page).toContain("<!doctype html>");
    expect(page).toContain('id="root"');
    // The page's script is the esbuild bundle the server made on its first page request.
    expect(page).toContain('src="./app.js"');
    const script = await fetch(`${url}app.js`).then((r) => r.text());
    expect(script.length).toBeGreaterThan(10_000);

    const workspaces = (await fetch(`${url}api/workspaces`).then((r) => r.json())) as {
      workspaces: unknown[];
    };
    expect(workspaces.workspaces.length).toBeGreaterThan(0);
  },
  30_000,
);
