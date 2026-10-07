import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit, type Browser } from "playwright";

import { serve, type Serving } from "../apps/server/src/capabilities/serve.ts";
import { guard, json } from "../apps/server/src/capabilities/web.ts";
import { budget, checkoutsOf, closePages, requireFreshWebBundle, runSh, serverEnv, stopRunHost, testRun, testTempDir, until, waitFor, waitForUrl } from "./helpers.ts";

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
/** The workspace ids the remote's change-create route was asked for, and what it created. */
let remoteCreates: string[];
let createdChange: typeof REMOTE_CHANGE | undefined;
/** How long the remote's terminal URL answer is held, for the obsolete-answer test. */
let remoteTerminalDelayMs = 0;

beforeAll(async () => {
  if (!usable) return;
  tmp = await testTempDir("sources-page");
  remotePaths = [];
  remoteServices = [];
  remoteDeploys = [];
  remoteLeftovers = [];
  remoteCreates = [];

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
          return json(createdChange ? [REMOTE_CHANGE, createdChange] : [REMOTE_CHANGE]);
        },
        // The wizard's create. The workspace in the body is the one the request names on the
        // wire: a remote context must send ITS id, and the create must arrive here at all
        // (the gateway prefix is what made it reachable).
        POST: async (req) => {
          const body = (await req.json()) as {
            id: string;
            title?: string;
            branch?: string;
            workspace?: string;
            state?: string;
          };
          remoteCreates.push(body.workspace ?? "");
          createdChange = {
            ...REMOTE_CHANGE,
            id: body.id,
            branch: body.branch ?? body.id,
            title: body.title ?? body.id,
            workspace: body.workspace ?? REMOTE_CHANGE.workspace,
            state: body.state ?? "Ideation",
          };
          return json({ change: createdChange, provision: [], refresh: [] }, 201);
        },
      },
      "/api/changes/:id": {
        GET: (req) => {
          record(req);
          if (createdChange && req.params.id === createdChange.id) return json(createdChange);
          return json(REMOTE_CHANGE);
        },
      },
      // The wizard asks its own server which steps this context has; the remote's answer is the
      // one that applies to a change made there.
      "/api/wizard": {
        GET: () => json({ steps: [], planTemplate: "" }),
      },
      "/api/changes/:id/terminal": {
        GET: async (req) => {
          record(req);
          if (remoteTerminalDelayMs > 0) await Bun.sleep(remoteTerminalDelayMs);
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
  // to keep straight. It has a checkout so its terminal can actually attach.
  const repo = join(tmp, "repo");
  await runSh(["git", "init", "-b", "main", repo]);
  await fetch(`${url}/api/changes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: REMOTE_CHANGE.id,
      title: "Local idea",
      state: "Ideation",
      checkouts: checkoutsOf([repo]),
    }),
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
  "switching the workspace keeps the open remote change and its source",
  async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    // The one read that says the page settled on the wrong server: the local twin shares the
    // remote change's id, so a source dropped by the page list arriving reads it instead.
    let localReads = 0;
    let remoteReads = 0;
    page.on("request", (request) => {
      if (request.method() !== "GET") return;
      // Both the local read and the gateway read end at this path; the gateway prefix is what
      // tells them apart.
      if (!new URL(request.url()).pathname.endsWith(`/api/changes/${REMOTE_CHANGE.id}`)) return;
      if (request.url().includes("/remote/")) remoteReads += 1;
      else localReads += 1;
    });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Remote idea" }).waitFor();

    // Open the remote change; the local one shares its id, which is what makes the source the
    // thing that decides who owns it.
    await page.getByRole("button", { name: "Remote idea" }).click();
    // A gate, not a loose poll: if the remote read never happens the test fails here, so the
    // `localReads === 0` below means "read from the remote, not the local twin".
    await waitFor("the remote change to be read", async () => remoteReads > 0, 10_000);
    expect(await page.title()).toBe("Remote idea");

    // A workspace switch refetches the page list. Wait for that fetch, because the page list's
    // arrival is the effect that used to re-resolve the view and drop the source.
    const chooseWorkspace = async (name: string): Promise<void> => {
      await page.locator("button.workspace").click();
      const pages = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/pages",
      );
      await page.getByText(name, { exact: true }).click();
      await pages;
    };
    await chooseWorkspace("Local");
    await chooseWorkspace("All work");

    // Still the remote change on screen, still read from the remote, and no missing-change
    // error from having re-read the local twin.
    expect(await page.title()).toBe("Remote idea");
    expect(localReads).toBe(0);
    const banners = await page.locator(".error-banner").allTextContents();
    expect(banners.some((text) => text.includes("no such change"))).toBe(false);
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

test.skipIf(!usable)(
  "creating a change in a remote workspace posts to the remote and lands on it there",
  async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const posts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST") posts.push(request.url());
    });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    // The switcher on the remote workspace: the wizard runs against its source.
    await page.locator("button.workspace").click();
    await page.getByText("Remote client", { exact: true }).click();

    await page.goto(`${url}/new`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Change id").fill("remote-created");
    await page.getByRole("button", { name: "Create idea" }).click();

    // The create went through the gateway to the remote, named by the remote's own workspace id.
    await until(async () => remoteCreates.includes("client"), true, 10_000);
    expect(remoteCreates).not.toContain("remote-client");
    expect(posts.some((u) => u.includes("/remote/remote-client/api/changes"))).toBe(true);

    // It landed on the created change, which the change page reads back from the remote.
    await until(async () => page.url().includes("/changes/remote-created"), true, 10_000);
    expect(page.url()).toContain("source=remote-client");
    await until(
      async () => remotePaths.includes("GET /api/changes/remote-created"),
      true,
      10_000,
    );
    await page.close();
  },
  60_000,
);

test.skipIf(!usable)(
  "creating a change in a local workspace still posts locally and lands on it",
  async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const posts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST") posts.push(request.url());
    });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.locator("button.workspace").click();
    await page.getByText("Local", { exact: true }).click();

    await page.goto(`${url}/new`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Change id").fill("local-created");
    await page.getByRole("button", { name: "Create idea" }).click();

    // The create stayed on the local origin, and the remote never saw it.
    await until(async () => page.url().includes("/changes/local-created"), true, 10_000);
    expect(posts.some((u) => u.includes("/api/changes") && !u.includes("/remote/"))).toBe(true);
    expect(remoteCreates).not.toContain("local");
    const changes = (await (await fetch(`${url}/api/changes`)).json()) as { id: string }[];
    expect(changes.some((change) => change.id === "local-created")).toBe(true);
    await page.close();
  },
  60_000,
);

test.skipIf(!usable)(
  "a late terminal URL from a change you left cannot take over the current one",
  async () => {
    remoteTerminalDelayMs = 4000;
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const sockets: string[] = [];
    page.on("websocket", (socket) => sockets.push(socket.url()));
    try {
      // Open the local twin's terminal once so it has a window entry in the column.
      await page.goto(`${url}/changes/${REMOTE_CHANGE.id}/terminals`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".terminal-screen[data-attached]", { timeout: budget(30_000) });

      // The remote change's terminal URL answer is held on its own page load...
      await page.goto(`${url}/changes/${REMOTE_CHANGE.id}/terminals?source=remote-client`, {
        waitUntil: "domcontentloaded",
      });
      // Only the local twin has a window (the fake remote serves none), so it is the one entry.
      const localWindow = page.locator(".sidebar .entry.window").first();
      await localWindow.waitFor({ timeout: budget(20_000) });
      // ...and the page leaves for the local twin's terminal (client-side) before it arrives.
      await localWindow.click();
      await page.waitForSelector(".terminal-screen[data-attached]", { timeout: budget(30_000) });

      // The held answer belongs to the source/change the page left; it must not attach its
      // socket or blank the terminal that is now showing.
      await Bun.sleep(4500);
      expect(sockets.some((socket) => socket.includes("/remote/remote-client/"))).toBe(false);
      expect(await page.locator(".terminal-gone").count()).toBe(0);
      expect(await page.locator(".error-banner").count()).toBe(0);
    } finally {
      remoteTerminalDelayMs = 0;
      await page.close();
    }
  },
  budget(90_000),
);
