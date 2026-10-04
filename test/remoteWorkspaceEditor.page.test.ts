import { test, expect, beforeAll, afterAll } from "bun:test";
import { rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit, type Browser } from "playwright";
import { MASK } from "../apps/server/src/settings/server/secrets.ts";
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
 * The settings page's remote-workspace editor, in the engine the app renders in: add a context,
 * mark it remote, pair against a stubbed remote to fill its token, save, reload and see the token
 * masked, then edit and remove it. No hand-editing `config.json`.
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

let tmp: string;
let url: string;
let server: ReturnType<typeof Bun.spawn>;
let remote: { url: string; stop: () => void };

beforeAll(async () => {
  if (!usable) return;
  tmp = await testTempDir("remote-workspace-page");
  await writeFile(join(tmp, "config.json"), JSON.stringify({}));

  // The stand-in remote: it redeems the code, lists its workspaces, and holds an event stream
  // open so the local server's fan-in does not reconnect in a loop after the save.
  const stub = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/api/devices/pairing-codes/redeem")
        return Response.json(
          {
            device: { id: "dev-1", name: "laptop", createdAt: "2026-01-01T00:00:00.000Z" },
            token: "raw-token",
          },
          { status: 201 },
        );
      if (path === "/api/workspaces")
        return Response.json({
          workspaces: [
            { id: "client", name: "Client" },
            { id: "personal", name: "Personal" },
          ],
          platform: "linux",
        });
      if (path === "/api/events")
        return new Response(new ReadableStream({ start() {} }), {
          headers: { "content-type": "text/event-stream" },
        });
      return new Response("no such route", { status: 404 });
    },
  });
  remote = { url: `http://127.0.0.1:${stub.port}`, stop: () => void stub.stop(true) };

  server = Bun.spawn(["node", "apps/server/src/server.ts", `--corvi-test-run=${testRun()}`], {
    env: serverEnv(tmp),
    stdout: "pipe",
    stderr: process.env.CORVI_TEST_LOUD ? "inherit" : "ignore",
  });
  url = await waitForUrl(server);
});

afterAll(async () => {
  if (!usable) return;
  await closePages(browser, "remote-workspace");
  await browser?.close();
  server?.kill();
  remote?.stop();
  await stopRunHost(tmp);
  await rm(tmp, { recursive: true, force: true });
});

/** The remote workspace as the server stored it, from the settings read. */
const storedRemote = async (): Promise<
  { url: string; workspace: string; token?: string } | undefined
> => {
  const view = (await (await fetch(`${url}/api/settings`)).json()) as {
    file: { workspaces?: { id: string; remote?: { url: string; workspace: string; token?: string } }[] };
  };
  return view.file.workspaces?.find((workspace) => workspace.id === "remote-client")?.remote;
};

/** The raw token as the config file itself holds it (the 2.1 unit tests read this; here it
 * pins that the settings page really wrote the token, not just something the read masks). */
const storedTokenInFile = async (): Promise<string | undefined> => {
  const file = JSON.parse(await readFile(join(tmp, "config.json"), "utf8")) as {
    workspaces?: { id: string; remote?: { token?: string } }[];
  };
  return file.workspaces?.find((workspace) => workspace.id === "remote-client")?.remote?.token;
};

test.skipIf(!usable)(
  "a remote workspace is added, paired, saved masked, edited and removed",
  async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${url}/settings`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("nav.tabs");

    // Add a context and make it remote. Anchored label regexes: a wrapping label's name includes
    // its hint, and "Name" would otherwise also match "This device's name".
    await page.getByRole("button", { name: "+ add a context" }).click();
    await page.getByLabel(/^Name/).fill("Remote client");
    await page.getByLabel(/^Id/).fill("remote-client");
    await page.getByLabel(/^Hosted on another server/).check();

    // A remote workspace has no settings of its own here, so those sections are gone.
    expect(await page.getByRole("button", { name: "Locations" }).count()).toBe(0);

    await page.getByLabel(/^Remote address/).fill(remote.url);
    await page.getByLabel(/^Remote workspace/).fill("client");

    // Pair: the helper redeems the code on the stub, fills the token, and offers the picker.
    await page.getByLabel(/^Pairing code/).fill("abcd");
    await page.getByLabel(/^This device's name/).fill("laptop");
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    const token = page.getByLabel(/^Device token/);
    await until(async () => (await token.inputValue()) === "raw-token", true, 10_000);
    const picker = page.getByRole("combobox");
    await picker.waitFor();
    await picker.selectOption("client");

    await page.getByRole("button", { name: "Save" }).click();
    await page.locator(".hint.saved").waitFor();

    // The token is stored, and the settings read masks it — the page never receives it.
    expect(await storedRemote()).toEqual({
      url: remote.url,
      workspace: "client",
      token: MASK,
    });
    // The file itself holds the raw token: the page flow is pinned end to end, not just at the
    // masked view.
    expect(await storedTokenInFile()).toBe("raw-token");

    // A reload shows the stored workspace with its token masked, not the raw token.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Remote client" }).click();
    const reloaded = page.getByLabel(/^Device token/);
    await reloaded.waitFor();
    expect(await reloaded.inputValue()).toBe(MASK);

    // A benign edit — the name — keeps the stored token: the target is unchanged.
    await page.getByLabel(/^Name/).fill("Remote client two");
    await page.getByRole("button", { name: "Save" }).click();
    await page.locator(".hint.saved").waitFor();
    expect(await storedRemote()).toEqual({ url: remote.url, workspace: "client", token: MASK });
    expect(await storedTokenInFile()).toBe("raw-token");

    // Changing the target drops the stored token — the old host's credential must not travel to
    // a different server or workspace — and the editor says so before Save.
    await page.getByLabel(/^Remote workspace/).fill("personal");
    await page.getByText("no longer applies").waitFor();
    await page.getByRole("button", { name: "Save" }).click();
    await page.locator(".hint.saved").waitFor();
    expect(await storedRemote()).toEqual({ url: remote.url, workspace: "personal" });
    expect(await storedTokenInFile()).toBeUndefined();

    // Removing the context drops it from the file.
    await page.getByRole("button", { name: "Remove this context" }).click();
    await page.getByRole("button", { name: "Save" }).click();
    await page.locator(".hint.saved").waitFor();
    expect(await storedRemote()).toBeUndefined();

    await page.close();
  },
  90_000,
);
