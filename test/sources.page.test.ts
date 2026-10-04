import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit, type Browser } from "playwright";

import { serve, type Serving } from "../apps/server/src/capabilities/serve.ts";
import { guard, json } from "../apps/server/src/capabilities/web.ts";
import { closePages, requireFreshWebBundle, serverEnv, stopRunHost, testRun, testTempDir, until, waitForUrl } from "./helpers.ts";

/**
 * A remote workspace in the one client: its change appears in the sidebar and the workspace
 * switcher filters it, opening it reads through the gateway, and its terminal socket is a gateway
 * path. The local server is the single origin; the fake remote is reached only through
 * `/remote/<source>/…`.
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

const REMOTE_CHANGE = {
  id: "REMOTE-1",
  branch: "remote-1",
  workspace: "client",
  title: "Remote idea",
  state: "Implementation",
  createdAt: new Date().toISOString(),
};

let tmp: string;
let url: string;
let server: ReturnType<typeof Bun.spawn>;
let remote: Serving;
let remotePaths: string[];

beforeAll(async () => {
  if (!usable) return;
  tmp = await testTempDir("sources-page");
  remotePaths = [];

  // A fake remote server, reached only through the gateway. Its change names the remote's
  // `client` workspace, which is what the local config's remote workspace points at.
  const record = (req: Request): void => {
    remotePaths.push(`${req.method} ${new URL(req.url).pathname}`);
  };
  remote = await serve<unknown>({
    port: 0,
    routes: guard({
      "/api/changes": {
        GET: (req) => {
          record(req);
          return json([REMOTE_CHANGE]);
        },
      },
      "/api/changes/:id": {
        GET: (req) => {
          record(req);
          return json(REMOTE_CHANGE);
        },
      },
      "/api/changes/:id/terminal": {
        GET: (req) => {
          record(req);
          return json({ url: `/api/changes/${REMOTE_CHANGE.id}/terminal/socket` });
        },
      },
      "/api/changes/:id/terminal/socket": (req, srv) =>
        srv.upgrade(req, { data: {} as never })
          ? undefined
          : new Response("no upgrade", { status: 400 }),
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
          remote: { url: `http://127.0.0.1:${remote.port}`, workspace: "client", token: "remote-token" },
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

  // A local change with the SAME id as the remote one: the collision the source dimension exists
  // to keep straight.
  await fetch(`${url}/api/changes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: REMOTE_CHANGE.id, title: "Local idea", state: "Ideation" }),
  });
});

afterAll(async () => {
  if (!usable) return;
  await closePages(browser, "sources");
  await browser?.close();
  server?.kill();
  remote?.stop();
  await stopRunHost(tmp);
  await rm(tmp, { recursive: true, force: true });
});

test.skipIf(!usable)(
  "a remote change is listed, filtered, opened and routed through the gateway",
  async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const sockets: string[] = [];
    page.on("websocket", (socket) => sockets.push(socket.url()));
    await page.goto(url, { waitUntil: "domcontentloaded" });

    // The remote change is in the sidebar, beside the local one that shares its id.
    const entry = page.getByRole("button", { name: "Remote idea" });
    await entry.waitFor();
    await page.getByRole("button", { name: "Local idea" }).waitFor();

    // Filtering by its workspace keeps it; filtering to the local one hides it.
    const chooseWorkspace = async (name: string): Promise<void> => {
      await page.locator("button.workspace").click();
      await page.getByText(name, { exact: true }).click();
    };
    await chooseWorkspace("Remote client");
    await entry.waitFor();
    await chooseWorkspace("Local");
    await entry.waitFor({ state: "detached" });
    await chooseWorkspace("Remote client");
    await entry.waitFor();

    // Opening it reads the change from the remote, through the gateway.
    await entry.click();
    await until(
      async () => remotePaths.includes(`GET /api/changes/${REMOTE_CHANGE.id}`),
      true,
      10_000,
    );

    // A deep link carries the source too, and the terminal URL is asked of the remote; the
    // socket goes to the gateway prefix.
    await page.goto(`${url}/changes/${REMOTE_CHANGE.id}/terminals?source=remote-client`, {
      waitUntil: "domcontentloaded",
    });
    await until(
      async () => remotePaths.some((path) => path === `GET /api/changes/${REMOTE_CHANGE.id}/terminal`),
      true,
      10_000,
    );
    await until(
      async () => sockets.some((socket) => socket.includes(`/remote/remote-client/api/changes/${REMOTE_CHANGE.id}/terminal/socket`)),
      true,
      15_000,
    );
    await page.close();
  },
  90_000,
);

test.skipIf(!usable)(
  "a remote workspace's wizard refuses local creation",
  async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.locator("button.workspace").click();
    await page.getByText("Remote client", { exact: true }).click();

    await page.goto(`${url}/new`, { waitUntil: "domcontentloaded" });
    await page.getByText("remote creation is not supported yet").waitFor();
    expect(await page.getByRole("button", { name: "Create idea" }).isDisabled()).toBe(true);
    // Nothing was created for the remote workspace locally.
    const created = (await (await fetch(`${url}/api/changes`)).json()) as { id: string }[];
    expect(created.every((change) => change.id === REMOTE_CHANGE.id)).toBe(true);
    await page.close();
  },
  60_000,
);
