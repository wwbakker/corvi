import { test, expect, beforeAll, afterAll } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit, type Browser } from "playwright";
import { closePages, requireFreshWebBundle, serverEnv, testRun, testTempDir, waitForUrl, stopRunHost } from "./helpers.ts";

/**
 * The Remote access settings section in the engine the app renders in: the enable toggle and
 * port ride the draft and are written by Save; the Tailscale status is a separate read whose
 * failure the section shows. The Tailscale API is stubbed at the page, so the test does not
 * depend on whether this machine runs Tailscale.
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
let port: number;

beforeAll(async () => {
  if (!usable) return;
  tmp = await testTempDir("remote-access-page");
  // A real free port, so enabling remote access binds without a collision on this machine.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  await writeFile(join(tmp, "config.json"), JSON.stringify({}));

  server = Bun.spawn(["node", "apps/server/src/server.ts", `--corvi-test-run=${testRun()}`], {
    env: serverEnv(tmp),
    stdout: "pipe",
    stderr: process.env.CORVI_TEST_LOUD ? "inherit" : "ignore",
  });
  url = await waitForUrl(server);
});

afterAll(async () => {
  if (!usable) return;
  await closePages(browser, "remote-access");
  await browser?.close();
  server?.kill();
  await stopRunHost(tmp);
  await rm(tmp, { recursive: true, force: true });
});

test.skipIf(!usable)(
  "the section shows the bind status and writes the toggle and port",
  async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    // The Tailscale read is stubbed: this machine's real answer would make the test flaky.
    await page.route(
      (u) => u.pathname === "/api/tailscale",
      (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            available: false,
            running: false,
            error: "tailscale is not installed",
          }),
        }),
    );
    await page.goto(`${url}/settings`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("nav.tabs");

    await page.getByRole("button", { name: "Remote access" }).click();
    const enabled = page.getByLabel("Enable remote access");
    await enabled.waitFor();
    expect(await enabled.isChecked()).toBe(false);
    const portInput = page.getByLabel("Port");
    expect(await portInput.inputValue()).toBe("4110");
    // The stubbed Tailscale read is reported, so an unavailable CLI has a visible reason.
    await page.getByText("Tailscale is not installed on this machine.").waitFor();

    await portInput.fill(String(port));
    await enabled.check();
    await page.getByRole("button", { name: "Save" }).click();
    await page.locator(".hint.saved").waitFor();

    const view = (await (await fetch(`${url}/api/settings`)).json()) as {
      file: { remoteAccess?: { enabled: boolean; port: number } };
      remoteAccessStatus: { enabled: boolean; listening: boolean };
    };
    expect(view.file.remoteAccess).toEqual({ enabled: true, port });
    expect(view.remoteAccessStatus.enabled).toBe(true);
    // The listener was started by the save, on the port the page wrote.
    expect(view.remoteAccessStatus.listening).toBe(true);
    await page.close();
  },
  60_000,
);

test.skipIf(!usable)(
  "a shared or foreign 443 is shown plainly, with the manual escape and a disabled Publish",
  async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    // The Tailscale read is stubbed per state; only its body changes between the two.
    let status: Record<string, unknown> = {
      available: true,
      running: true,
      dnsName: "omarchy.tailnet.ts.net",
      blocked: "mixed",
      error: "port 443 also serves port 8080; Corvi will not remove a shared tree",
    };
    await page.route(
      (u) => u.pathname === "/api/tailscale",
      (route) =>
        route.fulfill({ contentType: "application/json", body: JSON.stringify(status) }),
    );
    await page.goto(`${url}/settings`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("nav.tabs");
    await page.getByRole("button", { name: "Remote access" }).click();

    // The mixed state: our handler beside another's. The reason is shown, the manual command is
    // spelled out, and Publish is refused.
    await page.getByText("port 443 also serves port 8080").waitFor();
    await page.getByText("tailscale serve --https=443 off").waitFor();
    expect(await page.getByRole("button", { name: "Publish to Tailscale" }).isDisabled()).toBe(
      true,
    );

    // The conflict state: another service holds 443. The reason is shown and Publish stays
    // refused, and no manual off command is offered — there is nothing of ours to remove.
    status = {
      available: true,
      running: true,
      dnsName: "omarchy.tailnet.ts.net",
      blocked: "conflict",
      error: "port 443 already serves 8080; remove that mapping before publishing",
    };
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("nav.tabs");
    await page.getByRole("button", { name: "Remote access" }).click();
    await page.getByText("port 443 already serves 8080").waitFor();
    expect(await page.getByText("tailscale serve --https=443 off").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Publish to Tailscale" }).isDisabled()).toBe(
      true,
    );
    await page.close();
  },
  60_000,
);
