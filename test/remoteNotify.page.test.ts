import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit, type Browser } from "playwright";

import { serve, type Serving } from "../apps/server/src/capabilities/serve.ts";
import { guard, json } from "../apps/server/src/capabilities/web.ts";
import {
  closePages,
  requireFreshWebBundle,
  serverEnv,
  stopRunHost,
  testRun,
  testTempDir,
  until,
  waitForUrl,
} from "./helpers.ts";

/**
 * A remote workspace's notification, end to end: the fake remote's `notify` event is fanned in on
 * the local stream as a `source` envelope, the page's Notifier shows it with its source, and a
 * click opens the remote change — not a local one, and not the local origin.
 */
let browser: Browser;
const engineName = process.env.CORVI_ENGINE === "webkit" ? "webkit" : "chromium";
const usable = await (async (): Promise<boolean> => {
  try {
    const engine = engineName === "webkit" ? webkit : chromium;
    if (!(await Bun.file(engine.executablePath()).exists())) return false;
    browser = await engine.launch();
    return true;
  } catch {
    return false;
  }
})();

if (usable) requireFreshWebBundle();

const CHANGE = {
  id: "NOTIF-1",
  branch: "notif-1",
  workspace: "client",
  title: "Remote notice",
  state: "Implementation",
  createdAt: new Date().toISOString(),
};

let tmp: string;
let url: string;
let server: ReturnType<typeof Bun.spawn>;
let remote: Serving;
/** Push one SSE frame onto the fan-in's subscription; set when it connects. */
let pushRemote: ((frame: string) => void) | undefined;

beforeAll(async () => {
  if (!usable) return;
  tmp = await testTempDir("remote-notify");
  remote = await serve<unknown>({
    port: 0,
    routes: guard({
      "/api/changes": { GET: () => json([CHANGE]) },
      "/api/changes/:id": { GET: () => json(CHANGE) },
      // The remote's event stream: the fan-in subscribes to it, and the test writes the notify
      // frame once the page is listening on the local one.
      "/api/events": {
        GET: () =>
          new Response(
            new ReadableStream({
              start(controller) {
                const encoder = new TextEncoder();
                // A health byte at once: the availability owner treats a stream that says nothing
                // as unreachable, and the page would then gate the remote it is about to notify for.
                controller.enqueue(encoder.encode(": open\n\n"));
                pushRemote = (frame) => controller.enqueue(encoder.encode(frame));
              },
            }),
            { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
          ),
      },
    }),
  });

  writeFileSync(
    join(tmp, "config.json"),
    JSON.stringify({
      workspaces: [
        { id: "local", name: "Local" },
        {
          id: "remote-client",
          name: "Remote client",
          remote: {
            url: `http://127.0.0.1:${remote.port}`,
            workspace: "client",
            token: "remote-token",
          },
        },
      ],
    }),
  );
  server = Bun.spawn(["node", "apps/server/src/server.ts", `--corvi-test-run=${testRun()}`], {
    env: serverEnv(tmp),
    stdout: "pipe",
    stderr: process.env.CORVI_TEST_LOUD ? "inherit" : "ignore",
  });
  url = await waitForUrl(server);

  // A local change with the SAME id as the remote one: an id-only click would open this one, so
  // the test only passes if the notification's source is what resolves the change.
  await fetch(`${url}/api/changes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: CHANGE.id, title: "Local notice", state: "Ideation" }),
  });
});

afterAll(async () => {
  if (!usable) return;
  await closePages(browser, "remote-notify");
  await browser?.close();
  server?.kill();
  remote?.stop();
  await stopRunHost(tmp);
  await rm(tmp, { recursive: true, force: true });
});

test.skipIf(!usable)(
  "a remote notify shows a notification and its click opens the remote change",
  async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    // The page is up: the remote change, read through the gateway, is in the sidebar.
    await page.getByRole("button", { name: "Remote notice" }).waitFor();
    // The fan-in has subscribed to the fake remote's stream.
    await until(async () => pushRemote !== undefined, true, 10_000);

    const notice = {
      change: CHANGE.id,
      window: "w-1",
      label: "Agent wants you",
      note: "what it just said",
      sound: false,
    };
    const frame = `event: notify\ndata: ${JSON.stringify(notice)}\n\n`;
    // The page's own EventSource may connect a moment after the sidebar first paints, and a
    // broadcast reaches only listeners already attached: push until the toast is seen rather
    // than assume one delivery.
    for (let i = 0; i < 25; i++) {
      pushRemote?.(frame);
      if ((await page.locator(".toast").count()) > 0) break;
      await Bun.sleep(300);
    }
    const toast = page.locator(".toast");
    await toast.waitFor();
    // It says what the window is called, and names the server it came from.
    expect(await toast.textContent()).toContain("Agent wants you");
    expect(await toast.locator(".toast-where").textContent()).toContain("remote-client · NOTIF-1");

    // Clicking carries the source, so it opens the remote change's terminals page — not the
    // local change that shares this id.
    await toast.click();
    await until(async () => page.url().includes("/changes/NOTIF-1"), true, 10_000);
    expect(page.url()).toContain("source=remote-client");
    await page.close();
  },
  60_000,
);
