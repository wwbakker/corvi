import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { chromium, webkit, type Browser } from "playwright";
import { WebSocketServer } from "ws";

import {
  budget,
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
 * Two availability-view races:
 *
 * - a same-id retarget (same workspace id, different remote target) clears the old target's
 *   document, while a same-generation outage retains it marked unavailable;
 * - a remote terminal stops sending input and closes when its workspace goes unavailable.
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

const REMOTE = "REMOTE-1";

const reservePort = async (): Promise<number> => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
};

const writeConfig = (tmp: string, remotePort: number, remoteWorkspace: string): void => {
  writeFileSync(
    join(tmp, "config.json"),
    JSON.stringify({
      workspaces: [
        { id: "local", name: "Local" },
        {
          id: "remote-client",
          name: "Remote client",
          remote: { url: `http://127.0.0.1:${remotePort}`, workspace: remoteWorkspace, token: "remote-token" },
        },
      ],
    }),
  );
};

const startServer = async (tmp: string, port = 0): Promise<{ proc: ReturnType<typeof Bun.spawn>; url: string }> => {
  const proc = Bun.spawn(["node", "apps/server/src/server.ts", `--corvi-test-run=${testRun()}`], {
    env: serverEnv(tmp, { CORVI_PORT: String(port) }),
    stdout: "pipe",
    stderr: process.env.CORVI_TEST_LOUD ? "inherit" : "ignore",
  });
  return { proc, url: await waitForUrl(proc) };
};

type FakeRemote = {
  readonly port: number;
  readonly received: string[];
  readonly paths: () => string[];
  readonly connections: () => number;
  readonly close: () => void;
};

const record = (title: string): Record<string, string> => ({
  id: REMOTE,
  branch: "remote-1",
  workspace: "client",
  title,
  state: "Implementation",
  createdAt: "2026-01-01T00:00:00.000Z",
});

/** A remote Corvi-shaped server, optionally with a terminal socket. */
const startRemote = async (
  port: number,
  options: {
    readonly title: string;
    readonly plan: string;
    readonly terminal?: boolean;
    /** The state the remote reports for the sidebar icon ("ok", "error", ...). */
    readonly summaryState?: string;
    /** The one card's summary line, so the dashboard's cached value is visible. */
    readonly widgetSummary?: string;
    /** The notes extension: the dashboard lists its widget and its own route serves the text. */
    readonly notes?: boolean;
    /** The leftovers extension's page: the page list offers it and its route serves these names. */
    readonly leftovers?: readonly string[];
  },
): Promise<FakeRemote> => {
  const received: string[] = [];
  const paths: string[] = [];
  let connections = 0;
  const server = createServer((req, res) => {
    const path = req.url ?? "";
    paths.push(`${req.method ?? ""} ${path}`);
    const json = (value: unknown): void => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (path.startsWith("/api/events")) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(": open\n\n");
      const beat = setInterval(() => res.write(": ping\n\n"), 250);
      res.on("close", () => clearInterval(beat));
      return;
    }
    if (options.terminal === true && path.startsWith(`/api/changes/${REMOTE}/terminal`) && !path.includes("/socket")) {
      return json({ url: `/api/changes/${REMOTE}/terminal/socket` });
    }
    if (path.startsWith(`/api/changes/${REMOTE}/plan`)) return json({ text: options.plan, revision: "1" });
    if (path === `/api/changes/${REMOTE}/summary`)
      return json({ facts: [], state: options.summaryState ?? "ok" });
    if (path === `/api/changes/${REMOTE}/cards`)
      return json([{ name: "demo", title: "Demo", perRepo: false, column: "left" }]);
    if (path.startsWith(`/api/changes/${REMOTE}/cards/demo`))
      return json({
        integration: "demo",
        title: "Demo",
        state: "ok",
        summary: "",
        // The value the card renders: a row whose label names the target, so a cache that kept
        // the old target's widget would show the old label.
        items: [{ label: options.widgetSummary ?? "WIDGET", state: "ok" }],
      });
    if (path === `/api/changes/${REMOTE}/widgets`)
      return json({
        widgets:
          options.notes === true
            ? [{ id: "notes", title: "Notes", extension: "notes", column: "left" }]
            : [],
      });
    // The notes extension's own routes, through the gateway's prefix: a GET is the document, a
    // PUT is a save. Both are recorded so a test can say a blocked editor never wrote.
    if (path.includes("/ext/notes/")) return json({ text: "NOTES" });
    if (path === `/api/changes/${REMOTE}/tabs`) return json({ tabs: [] });
    if (path === `/api/changes/${REMOTE}`) return json(record(options.title));
    if (path === "/api/changes") return json([record(options.title)]);
    if (path.startsWith("/api/pages"))
      return json({
        pages:
          options.leftovers === undefined
            ? []
            : [{ id: "leftovers", title: "Leftovers", extension: "leftovers" }],
      });
    // The wire transport prepends `/api`, so an extension route arrives as `/api/ext/...`.
    if (path.includes("/ext/leftovers/list"))
      return json(
        (options.leftovers ?? []).map((name) => ({
          name,
          path: `/tmp/${name}`,
          entries: [],
          kilobytes: 1,
        })),
      );
    if (path.startsWith("/api/terminals")) return json({});
    if (path.startsWith("/api/dashboard/")) return json([]);
    if (path.startsWith("/api/wizard")) return json({ steps: [], planTemplate: "" });
    json({});
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => {
    connections += 1;
    socket.on("message", (data, isBinary) => {
      received.push(isBinary ? new TextDecoder().decode(data as Buffer) : data.toString());
    });
    // The pane is "attached" once a control frame names its session.
    socket.send(JSON.stringify({ type: "reset", sessionId: "w-1" }));
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
  return {
    port,
    received,
    paths: () => paths,
    connections: () => connections,
    close: () => {
      wss.close();
      server.closeAllConnections?.();
      server.close();
    },
  };
};

afterAll(async () => {
  if (!usable) return;
  await closePages(browser, "availability-retarget");
  await browser?.close();
}, budget(30_000));

test.skipIf(!usable)("a same-id retarget clears the old target's plan; a same-generation outage retains it", async () => {
  const tmp = await testTempDir("availability-retarget");
  const portA = await reservePort();
  const portB = await reservePort();
  writeConfig(tmp, portA, "client");
  const started = await startServer(tmp);
  const localPort = Number(new URL(started.url).port);
  const a = await startRemote(portA, { title: "Remote A", plan: "# PLAN-A\n" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${started.url}/changes/${REMOTE}/plan?source=remote-client`, { waitUntil: "domcontentloaded" });
    await until(async () => (await page.locator(".md-editor").innerText()).includes("PLAN-A"), true, budget(40_000));
    expect(await page.locator(".md-editor").innerText()).toContain("PLAN-A");

    // Same target, same generation: going down retains the document, marked unavailable.
    a.close();
    await page.locator(".remote-unavailable").waitFor({ timeout: budget(40_000) });
    // Same generation: the change stays listed (retained, not cleared).
    await until(async () => (await page.locator(".sidebar").innerText()).includes("Remote A"), true, budget(20_000));

    // Same workspace id, different target: the old target's document must be gone, and the new
    // target's shown after recovery.
    const b = await startRemote(portB, { title: "Remote B", plan: "# PLAN-B\n" });
    writeConfig(tmp, portB, "other");
    started.proc.kill();
    await started.proc.exited;
    const restarted = await startServer(tmp, localPort);
    try {
      await until(async () => (await page.locator(".remote-unavailable").count()), 0, budget(60_000));
      expect(await page.locator(".remote-unavailable").count()).toBe(0);
      await until(async () => (await page.locator(".md-editor").innerText()).includes("PLAN-B"), true, budget(40_000));
      expect(await page.locator(".md-editor").innerText()).not.toContain("PLAN-A");
    } finally {
      restarted.proc.kill();
      await restarted.proc.exited;
    }
    b.close();
  } finally {
    await page.close();
    await stopRunHost(tmp);
    await rm(tmp, { recursive: true, force: true });
  }
}, budget(240_000));

test.skipIf(!usable)("an available remote's plan editor becomes read-only when its workspace goes offline", async () => {
  const tmp = await testTempDir("availability-readonly");
  const portA = await reservePort();
  writeConfig(tmp, portA, "client");
  const started = await startServer(tmp);
  const a = await startRemote(portA, { title: "Remote A", plan: "# PLAN-READONLY\n" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${started.url}/changes/${REMOTE}/plan?source=remote-client`, { waitUntil: "domcontentloaded" });
    const content = page.locator(".md-editor .cm-content").first();
    await until(async () => (await page.locator(".md-editor .cm-content").count()) > 0, true, budget(40_000));
    // Available: the document is loaded and the editor is editable.
    await until(async () => (await content.getAttribute("contenteditable")) === "true", true, budget(20_000));
    await until(async () => (await content.textContent() ?? "").includes("PLAN-READONLY"), true, budget(30_000));
    expect(await content.textContent() ?? "").toContain("PLAN-READONLY");
    // The change's own controls are usable while the target is reachable.
    const phase = page.locator(".change-tabs select");
    await until(async () => (await phase.count()) > 0, true, budget(20_000));
    expect(await phase.isDisabled()).toBe(false);

    // Same target goes offline: the document is retained, and the editor is read-only.
    a.close();
    await page.locator(".remote-unavailable").waitFor({ timeout: budget(40_000) });
    await until(async () => (await content.getAttribute("contenteditable")) === "false", true, budget(30_000));
    expect(await content.getAttribute("contenteditable")).toBe("false");
    // The phase select must not offer a remote mutation while its workspace is away.
    await until(async () => await phase.isDisabled(), true, budget(20_000));
    expect(await phase.isDisabled()).toBe(true);
    // The document is retained after the reconfigure settles.
    await until(async () => (await content.textContent() ?? "").includes("PLAN-READONLY"), true, budget(30_000));
    expect(await content.textContent() ?? "").toContain("PLAN-READONLY");
  } finally {
    await page.close();
    await stopRunHost(tmp);
    await rm(tmp, { recursive: true, force: true });
  }
}, budget(240_000));

test.skipIf(!usable)("an unavailable remote's retained notes are read-only and their draft is not replayed", async () => {
  const tmp = await testTempDir("availability-notes");
  const portA = await reservePort();
  writeConfig(tmp, portA, "client");
  const started = await startServer(tmp);
  const a = await startRemote(portA, { title: "Remote A", plan: "# PLAN-A\n", notes: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // Saves that leave the browser: a blocked editor must not issue one at all.
  const saves: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "PUT" && req.url().includes("/ext/notes/")) saves.push(req.url());
  });
  try {
    await page.goto(`${started.url}/changes/${REMOTE}/dashboard?source=remote-client`, {
      waitUntil: "domcontentloaded",
    });
    const notes = page.locator(".widget", { hasText: "Notes" });
    const editor = notes.locator(".md-editor .cm-content").first();
    await until(async () => (await editor.count()) > 0, true, budget(40_000));
    await until(async () => ((await editor.textContent()) ?? "").includes("NOTES"), true, budget(30_000));
    expect((await editor.textContent()) ?? "").toContain("NOTES");
    await until(async () => (await editor.getAttribute("contenteditable")) === "true", true, budget(20_000));

    // An edit while the source is reachable, then the remote goes down before the debounce fires.
    await editor.click();
    await page.keyboard.type(" draft");
    a.close();
    await page.locator(".remote-unavailable").waitFor({ timeout: budget(40_000) });

    // The retained notes are a contenteditable CodeMirror, which a disabled fieldset cannot reach:
    // the editor itself must be read-only. The draft stays, and no save leaves the browser.
    await until(async () => (await editor.getAttribute("contenteditable")) === "false", true, budget(20_000));
    const before = saves.length;
    await until(async () => ((await editor.textContent()) ?? "").includes("draft"), true, budget(10_000));
    await Bun.sleep(1500); // past the debounce, were one still scheduled
    expect(saves.length).toBe(before);

    // Recovery is not a replay: the draft is still there, and still unsent.
    const b = await startRemote(portA, { title: "Remote A", plan: "# PLAN-A\n", notes: true });
    try {
      await page.locator(".remote-unavailable").getByRole("button", { name: "Retry now" }).click();
      await until(async () => (await page.locator(".remote-unavailable").count()), 0, budget(40_000));
      await until(async () => (await editor.getAttribute("contenteditable")) === "true", true, budget(30_000));
      expect(await editor.getAttribute("contenteditable")).toBe("true");
      await Bun.sleep(1500);
      expect(saves.length).toBe(before);
      expect((await editor.textContent()) ?? "").toContain("draft");

      // The next real edit does save: the hold was the outage, not a broken save.
      await editor.click();
      await page.keyboard.type("!");
      await until(async () => saves.length > before, true, budget(10_000));
      expect(saves.length).toBeGreaterThan(before);
    } finally {
      b.close();
    }
  } finally {
    await page.close();
    await stopRunHost(tmp);
    await rm(tmp, { recursive: true, force: true });
  }
}, budget(240_000));

test.skipIf(!usable)("a dirty document is never written to a retargeted workspace", async () => {
  const tmp = await testTempDir("availability-dirty-retarget");
  const portA = await reservePort();
  const portB = await reservePort();
  writeConfig(tmp, portA, "client");
  const started = await startServer(tmp);
  const localPort = Number(new URL(started.url).port);
  const a = await startRemote(portA, { title: "Remote A", plan: "# PLAN-A\n", notes: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${started.url}/changes/${REMOTE}/dashboard?source=remote-client`, {
      waitUntil: "domcontentloaded",
    });
    const editor = page.locator(".widget", { hasText: "Notes" }).locator(".md-editor .cm-content").first();
    await until(async () => (await editor.count()) > 0, true, budget(40_000));
    await until(async () => (await editor.getAttribute("contenteditable")) === "true", true, budget(30_000));

    // A dirty draft, then the workspace goes down before the debounce fires: the draft is held.
    await editor.click();
    await page.keyboard.type(" OLD-DRAFT");
    a.close();
    await page.locator(".remote-unavailable").waitFor({ timeout: budget(40_000) });

    // Retarget the same source id at another workspace while it is down; when it comes back the
    // page remounts for the new target, and the old draft must never be written to it.
    writeConfig(tmp, portB, "other");
    started.proc.kill();
    await started.proc.exited;
    const b = await startRemote(portB, { title: "Remote B", plan: "# PLAN-B\n", notes: true });
    const restarted = await startServer(tmp, localPort);
    try {
      await until(async () => (await page.locator(".remote-unavailable").count()), 0, budget(60_000));
      await Bun.sleep(1500);
      // The new target never received a write, and its own document is what the editor shows.
      expect(b.paths().some((path) => path.startsWith("PUT "))).toBe(false);
      expect((await editor.textContent()) ?? "").not.toContain("OLD-DRAFT");
    } finally {
      restarted.proc.kill();
      await restarted.proc.exited;
      b.close();
    }
  } finally {
    await page.close();
    await stopRunHost(tmp);
    await rm(tmp, { recursive: true, force: true });
  }
}, budget(300_000));

test.skipIf(!usable)("a workspace integration page remounts on retarget, keeps its facts through an outage, and re-reads on recovery", async () => {
  const tmp = await testTempDir("availability-page");
  const portA = await reservePort();
  const portB = await reservePort();
  writeConfig(tmp, portA, "client");
  const started = await startServer(tmp);
  const localPort = Number(new URL(started.url).port);
  const a = await startRemote(portA, {
    title: "Remote A",
    plan: "# PLAN-A\n",
    leftovers: ["LEFTOVER-A"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageText = async (): Promise<string> => (await page.locator(".leftovers").innerText()) ?? "";
  try {
    await page.goto(started.url, { waitUntil: "domcontentloaded" });
    await page.locator("button.workspace").click();
    await page.getByText("Remote client", { exact: true }).click();
    // The remote workspace's own page list, then the page itself.
    const entry = page.getByRole("button", { name: "Leftovers" });
    await entry.waitFor({ timeout: budget(30_000) });
    await entry.click();
    await until(async () => (await pageText()).includes("LEFTOVER-A"), true, budget(30_000));
    expect(await pageText()).toContain("LEFTOVER-A");

    // Same target goes offline: the page keeps what it loaded, and only the banner is added.
    a.close();
    await page.locator(".remote-unavailable").waitFor({ timeout: budget(40_000) });
    expect(await pageText()).toContain("LEFTOVER-A");

    // Recovery re-reads in place, without navigating or reloading: the transport's identity
    // changes on the transition, which is what a page with no poll re-reads on.
    const b = await startRemote(portA, {
      title: "Remote A",
      plan: "# PLAN-A\n",
      leftovers: ["LEFTOVER-C"],
    });
    try {
      await page.locator(".remote-unavailable").getByRole("button", { name: "Retry now" }).click();
      await until(async () => (await pageText()).includes("LEFTOVER-C"), true, budget(30_000));
      expect(await pageText()).toContain("LEFTOVER-C");
      expect(await pageText()).not.toContain("LEFTOVER-A");
    } finally {
      b.close();
    }

    // A same-id retarget: the page is remounted for the new target rather than carrying the old
    // target's React state, and it re-reads the new server.
    writeConfig(tmp, portB, "other");
    started.proc.kill();
    await started.proc.exited;
    const c = await startRemote(portB, {
      title: "Remote B",
      plan: "# PLAN-B\n",
      leftovers: ["LEFTOVER-B"],
    });
    const restarted = await startServer(tmp, localPort);
    try {
      await until(async () => (await pageText()).includes("LEFTOVER-B"), true, budget(60_000));
      expect(await pageText()).toContain("LEFTOVER-B");
      expect(await pageText()).not.toContain("LEFTOVER-C");
    } finally {
      restarted.proc.kill();
      await restarted.proc.exited;
      c.close();
    }
  } finally {
    await page.close();
    await stopRunHost(tmp);
    await rm(tmp, { recursive: true, force: true });
  }
}, budget(300_000));

test.skipIf(!usable)("a same-id retarget replaces the old target's widget and summary icon", async () => {
  const tmp = await testTempDir("availability-widget-retarget");
  const portA = await reservePort();
  writeConfig(tmp, portA, "client");
  const started = await startServer(tmp);
  const a = await startRemote(portA, {
    title: "Remote A",
    plan: "# PLAN-A\n",
    summaryState: "ok",
    widgetSummary: "WIDGET-A",
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${started.url}/changes/${REMOTE}/dashboard?source=remote-client`, {
      waitUntil: "domcontentloaded",
    });
    // Target A: its widget value and its summary icon are shown.
    const widgetText = (): Promise<string> =>
      page.evaluate(() => document.body.textContent ?? "");
    await until(async () => (await widgetText()).includes("WIDGET-A"), true, budget(40_000));
    expect(await widgetText()).toContain("WIDGET-A");
    const entry = page.locator(".change-entry", { hasText: "Remote A" });
    await until(async () => (await entry.locator(".icons .state-ok").count()) > 0, true, budget(20_000));
    expect(await entry.locator(".icons .state-ok").count()).toBeGreaterThan(0);

    // The same target goes offline: the card keeps the rows it already has rather than replacing
    // them with an empty error widget (the gate transition is the workspace going away).
    a.close();
    await page.locator(".remote-unavailable").waitFor({ timeout: budget(40_000) });
    await Bun.sleep(700); // past a poll tick that would have tried and been refused
    expect(await widgetText()).toContain("WIDGET-A");

    // Retarget the same workspace id at B: the local server restarts on the same port, the page
    // reconnects to a new instance, and the new generation's widget must replace the old one.
    const localPort = Number(new URL(started.url).port);
    const portB = await reservePort();
    writeConfig(tmp, portB, "other");
    started.proc.kill();
    await started.proc.exited;
    const b = await startRemote(portB, {
      title: "Remote B",
      plan: "# PLAN-B\n",
      summaryState: "error",
      widgetSummary: "WIDGET-B",
    });
    const restarted = await startServer(tmp, localPort);
    try {
      await until(async () => (await widgetText()).includes("WIDGET-B"), true, budget(60_000));
      expect(await widgetText()).not.toContain("WIDGET-A");
      const reentry = page.locator(".change-entry", { hasText: "Remote B" });
      await until(async () => (await reentry.locator(".icons .state-error").count()) > 0, true, budget(30_000));
      expect(await reentry.locator(".icons .state-error").count()).toBeGreaterThan(0);
    } finally {
      restarted.proc.kill();
      await restarted.proc.exited;
      b.close();
    }
  } finally {
    await page.close();
    await stopRunHost(tmp);
    await rm(tmp, { recursive: true, force: true });
  }
}, budget(300_000));

test.skipIf(!usable)("a remote terminal closes and sends no input once its workspace is unavailable", async () => {
  const tmp = await testTempDir("availability-ws");
  const portA = await reservePort();
  writeConfig(tmp, portA, "client");
  const started = await startServer(tmp);
  const a = await startRemote(portA, { title: "Remote A", plan: "# PLAN-A\n", terminal: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${started.url}/changes/${REMOTE}/terminals?source=remote-client`, { waitUntil: "domcontentloaded" });
    // The gateway opened the upstream socket; the pane's own socket is what carries input.
    await until(async () => a.connections() >= 1, true, budget(60_000));
    await page.locator(".terminal-screen").click();
    await page.keyboard.type("BEFORE\n");
    await until(async () => a.received.join("").includes("BEFORE"), true, budget(30_000));
    expect(a.received.join("")).toContain("BEFORE");

    // The remote goes down: the pane closes its socket and says why; typing reaches nothing.
    a.close();
    await page.locator(".remote-unavailable").waitFor({ timeout: budget(40_000) });
    await until(async () => (await page.locator(".terminal-screen[data-attached]").count()), 0, budget(40_000));
    expect(await page.locator(".terminal-screen[data-attached]").count()).toBe(0);
    const before = a.received.length;
    await page.keyboard.type("AFTER\n");
    await Bun.sleep(1500);
    expect(a.received.length).toBe(before);
    expect(a.received.join("")).not.toContain("AFTER");
  } finally {
    await page.close();
    await stopRunHost(tmp);
    await rm(tmp, { recursive: true, force: true });
  }
}, budget(240_000));
