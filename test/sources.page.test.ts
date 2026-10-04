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
/** A reachable server that fails every request: a remote workspace whose pages cannot be read. */
let broken: Serving;
let remotePaths: string[];
/** The workspace ids the remote's azure-devops page route was asked for. */
let remoteServices: string[];
/** The workspace ids the remote's deploy and leftovers routes were asked for. */
let remoteDeploys: string[];
let remoteLeftovers: string[];

beforeAll(async () => {
  if (!usable) return;
  tmp = await testTempDir("sources-page");
  remotePaths = [];
  remoteServices = [];
  remoteDeploys = [];
  remoteLeftovers = [];

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

      // The remote's own page list, so a remote workspace's sidebar comes from the remote.
      "/api/pages": {
        GET: (req) => {
          record(req);
          return json({
            pages: [
              { id: "azure-devops", title: "Azure DevOps", extension: "azure-devops" },
              { id: "leftovers", title: "Leftovers", extension: "leftovers" },
            ],
          });
        },
      },
      // The remote's azure-devops page route. The workspace id it is asked for is the one the
      // request must carry: the remote's own (`client`), never the local workspace's id.
      "/api/ext/azure-devops/services": {
        GET: (req) => {
          remoteServices.push(new URL(req.url).searchParams.get("workspace") ?? "");
          return json({
            services: [
              {
                name: "remote-svc",
                pipeline: { id: 1, name: "remote-svc-pipeline" },
                environments: [
                  { environment: "acceptance", version: "20260101.1", state: "ok", detail: "deployed" },
                  { environment: "production", version: "20251201.1", state: "ok", detail: "deployed" },
                ],
              },
            ],
          });
        },
      },
      "/api/ext/azure-devops/services/:service/versions": {
        GET: () =>
          json([
            {
              runId: 7,
              buildNumber: "20260101.1",
              version: "20260101.1",
              branch: "main",
              deployedTo: [],
            },
          ]),
      },
      "/api/ext/azure-devops/services/:service/deploy": {
        POST: (req) => {
          remoteDeploys.push(new URL(req.url).searchParams.get("workspace") ?? "");
          return json({ runId: 99 });
        },
      },
      "/api/ext/leftovers/list": {
        GET: (req) => {
          remoteLeftovers.push(new URL(req.url).searchParams.get("workspace") ?? "");
          return json([]);
        },
      },
    }),
  });

  // A server that answers every request with a failure: the page list it would offer cannot be
  // read, which is the case a stale list used to leak into.
  broken = await serve<unknown>({
    port: 0,
    routes: guard({ "/*": () => new Response("that server is down", { status: 503 }) }),
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
        {
          id: "remote-down",
          name: "Remote down",
          remote: { url: `http://127.0.0.1:${broken.port}`, workspace: "client", token: "down-token" },
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
  broken?.stop();
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

test.skipIf(!usable)(
  "a remote workspace's extension page fetches through the gateway with the remote workspace id",
  async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(url, { waitUntil: "domcontentloaded" });

    // The switcher on the remote workspace: its page list comes from the remote too.
    await page.locator("button.workspace").click();
    await page.getByText("Remote client", { exact: true }).click();
    await page.getByRole("button", { name: "Azure DevOps" }).click();

    // The remote saw the page's services request, named by its own workspace id — not the local
    // workspace's id, which is the whole point of sending `remote.workspace`.
    await until(async () => remoteServices.includes("client"), true, 10_000);
    await page.getByText("remote-svc").waitFor();
    expect(remoteServices).toContain("client");
    expect(remoteServices).not.toContain("remote-client");
    await page.close();
  },
  60_000,
);

test.skipIf(!usable)(
  "a local workspace's extension page still fetches from the local origin",
  async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.locator("button.workspace").click();
    await page.getByText("Local", { exact: true }).click();

    const before = remoteServices.length;
    await page.getByRole("button", { name: "Azure DevOps" }).click();
    await page.getByRole("heading", { name: "Azure DevOps" }).waitFor();
    // The local origin has answered (the page has nothing configured here, so it settles to empty
    // or an error) and the remote's page route was never asked.
    await page.getByText("loading…").waitFor({ state: "detached" });
    expect(remoteServices.length).toBe(before);
    expect(await page.getByText("remote-svc").count()).toBe(0);
    await page.close();
  },
  60_000,
);

test.skipIf(!usable)(
  "the remote deploy and leftovers pages carry the remote workspace id",
  async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.locator("button.workspace").click();
    await page.getByText("Remote client", { exact: true }).click();

    // The leftovers page's list request names the remote's own workspace, through the gateway.
    await page.getByRole("button", { name: "Leftovers" }).click();
    await until(async () => remoteLeftovers.includes("client"), true, 10_000);
    expect(remoteLeftovers).not.toContain("remote-client");

    // So does the deploy POST from the Azure DevOps page.
    await page.getByRole("button", { name: "Azure DevOps" }).click();
    await page.getByText("remote-svc").waitFor();
    await page.getByRole("button", { name: "Deploy…" }).click();
    await page.getByRole("button", { name: /^Deploy 20260101\.1 to acceptance$/ }).click();
    await until(async () => remoteDeploys.includes("client"), true, 10_000);
    expect(remoteDeploys).not.toContain("remote-client");
    await page.close();
  },
  60_000,
);

test.skipIf(!usable)(
  "a workspace whose pages cannot be read shows none, not the previous workspace's",
  async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(url, { waitUntil: "domcontentloaded" });

    // A workspace whose remote offers pages: its links are in the sidebar.
    await page.locator("button.workspace").click();
    await page.getByText("Remote client", { exact: true }).click();
    await page.getByRole("button", { name: "Azure DevOps" }).waitFor();

    // A workspace whose remote cannot be read: the previous workspace's links must not linger.
    await page.locator("button.workspace").click();
    await page.getByText("Remote down", { exact: true }).click();
    await page.getByRole("button", { name: "Azure DevOps" }).waitFor({ state: "detached" });
    expect(await page.getByRole("button", { name: "Leftovers" }).count()).toBe(0);
    await page.close();
  },
  60_000,
);
