import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { json } from "../apps/server/src/capabilities/web.ts";
import {
  decideServe,
  parseServeMappings,
  parseTailscaleStatus,
  publicUrlFor,
  publishTailscale,
  reconcileTailscale,
  tailscaleStatus,
  unpublishTailscale,
} from "../apps/server/src/tailscale/server/index.ts";
import {
  runtimeRemoteAccessStatus,
  runtimeTailscalePublishedPort,
  setRemoteAccessStatus,
  setTailscalePublishedPort,
} from "../apps/server/src/capabilities/runtime.ts";
import { fakeShell, runRouteWithShell, runWithShell, withRuntimeConfig } from "./helpers.ts";

/**
 * The Tailscale capability: the parsing of `tailscale`'s JSON, the decision to enable or leave
 * 443 alone, and the exact commands each operation runs. The subprocesses are scripted, so no
 * real Tailscale is involved.
 */

const STATUS = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "omarchy.tailnet.ts.net." },
});

const served = (targetPort: number): string =>
  JSON.stringify({
    Web: {
      "omarchy.tailnet.ts.net:443": {
        Handlers: { "/": { Proxy: `http://127.0.0.1:${targetPort}` } },
      },
    },
  });

/** The runtime status as it stands once the external listener is bound. */
const listening = {
  enabled: true,
  listening: true,
  port: 4110,
  url: "http://127.0.0.1:4110/",
};

/** Put the runtime back the way a test found it, tracking included (it is process state). */
const withPublication = async (body: () => Promise<void>): Promise<void> => {
  const savedStatus = runtimeRemoteAccessStatus();
  const savedPort = runtimeTailscalePublishedPort();
  try {
    await body();
  } finally {
    setRemoteAccessStatus(savedStatus);
    setTailscalePublishedPort(savedPort);
  }
};

describe("parsing tailscale's JSON", () => {
  test("status: running and the machine's DNS name without its trailing dot", () => {
    expect(parseTailscaleStatus(STATUS)).toEqual({
      running: true,
      dnsName: "omarchy.tailnet.ts.net",
    });
  });

  test("status: a stopped backend, and output that is not JSON", () => {
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: "Stopped" }))).toEqual({
      running: false,
    });
    expect(parseTailscaleStatus("not json")).toEqual({ running: false });
    expect(parseTailscaleStatus("{}")).toEqual({ running: false });
  });

  test("serve mappings: the documented Web/host:port/Handlers/Proxy shape", () => {
    expect(parseServeMappings(served(4110))).toEqual([
      { externalPort: 443, host: "omarchy.tailnet.ts.net:443", targetPort: 4110 },
    ]);
    expect(parseServeMappings("")).toEqual([]);
    expect(parseServeMappings("{}")).toEqual([]);
    // A handler with no proxy still occupies its port: it is reported, without a target, so an
    // enable refuses rather than displacing a redirect or text handler.
    expect(parseServeMappings(JSON.stringify({ Web: { "host:443": { Handlers: { "/": {} } } } }))).toEqual([
      { externalPort: 443, host: "host:443" },
    ]);
  });

  test("the public URL is the tailnet HTTPS root", () => {
    expect(publicUrlFor("omarchy.tailnet.ts.net")).toBe("https://omarchy.tailnet.ts.net/");
  });

  test("the enable decision: free, ours, or a conflict", () => {
    expect(decideServe([], 4110)).toEqual({ kind: "free" });
    expect(decideServe(parseServeMappings(served(4110)), 4110)).toEqual({ kind: "published" });
    expect(decideServe(parseServeMappings(served(8080)), 4110)).toEqual({
      kind: "conflict",
      targetPort: 8080,
    });
    // A mapping on another external port is not a conflict.
    const otherPort = JSON.stringify({
      Web: { "omarchy.tailnet.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4110" } } } },
    });
    expect(decideServe(parseServeMappings(otherPort), 4110)).toEqual({ kind: "free" });
    // A 443 handler with no proxy is still something else holding the port.
    const foreignHandler = JSON.stringify({ Web: { "host:443": { Handlers: { "/": {} } } } });
    expect(decideServe(parseServeMappings(foreignHandler), 4110)).toEqual({
      kind: "conflict",
      targetPort: undefined,
    });
    // Our handler beside a foreign one is a shared tree: `off` would clear both.
    const mixed = JSON.stringify({
      Web: {
        "host:443": {
          Handlers: {
            "/": { Proxy: "http://127.0.0.1:4110" },
            "/admin": { Proxy: "http://127.0.0.1:8080" },
          },
        },
      },
    });
    expect(decideServe(parseServeMappings(mixed), 4110)).toEqual({
      kind: "mixed",
      foreignPorts: [8080],
    });
  });
});

describe("the tailscale operations", () => {
  const withBind = async (body: () => Promise<void>): Promise<void> =>
    withPublication(async () => {
      setRemoteAccessStatus(listening);
      await withRuntimeConfig({ remoteAccess: { enabled: true, port: 4110 } }, body);
    });

  test("status reports the published URL when our port is served", async () => {
    await withBind(async () => {
      const shell = fakeShell({
        "tailscale status --json": STATUS,
        "tailscale serve status --json": served(4110),
      });
      const status = await runWithShell(shell, tailscaleStatus());
      expect(status).toEqual({
        available: true,
        running: true,
        dnsName: "omarchy.tailnet.ts.net",
        publishedUrl: "https://omarchy.tailnet.ts.net/",
      });
    });
  });

  test("status explains a missing binary and a stopped backend", async () => {
    await withBind(async () => {
      const missing = fakeShell({ "tailscale status --json": { code: 127, stderr: "not found" } });
      expect(await runWithShell(missing, tailscaleStatus())).toEqual({
        available: false,
        running: false,
        error: "tailscale is not installed",
      });

      const stopped = fakeShell({
        "tailscale status --json": JSON.stringify({ BackendState: "Stopped" }),
      });
      expect(await runWithShell(stopped, tailscaleStatus())).toEqual({
        available: true,
        running: false,
        error: "tailscale is not connected",
      });
    });
  });

  test("status reports a foreign 443 mapping as an error, not as published", async () => {
    await withBind(async () => {
      const shell = fakeShell({
        "tailscale status --json": STATUS,
        "tailscale serve status --json": served(8080),
      });
      const status = await runWithShell(shell, tailscaleStatus());
      expect(status.publishedUrl).toBeUndefined();
      expect(status.error).toContain("443 already serves 8080");
    });
  });

  test("publish runs the exact serve command when 443 is free", async () => {
    await withBind(async () => {
      // The serve status reflects the publish once the command has run, as the real CLI would.
      let published = false;
      const shell = fakeShell((cmd) => {
        const line = cmd.join(" ");
        if (line === "tailscale status --json") return STATUS;
        if (line === "tailscale serve status --json") return published ? served(4110) : "{}";
        if (line === "tailscale serve --bg 4110") {
          published = true;
          return "";
        }
        return undefined;
      });
      const status = await runWithShell(shell, publishTailscale());
      expect(status.publishedUrl).toBe("https://omarchy.tailnet.ts.net/");
      expect(shell.calls.map((call) => call.cmd.join(" "))).toContain("tailscale serve --bg 4110");
    });
  });

  test("publish refuses to displace a foreign 443 mapping and runs no command", async () => {
    await withBind(async () => {
      const shell = fakeShell({
        "tailscale status --json": STATUS,
        "tailscale serve status --json": served(8080),
      });
      const outcome = await runWithShell(shell, Effect.either(publishTailscale()));
      expect(outcome._tag).toBe("Left");
      if (outcome._tag === "Left") expect(outcome.left.message).toContain("443 already serves 8080");
      expect(shell.calls.some((call) => call.cmd.includes("--bg"))).toBe(false);
    });
  });

  test("publish is idempotent when our port is already served", async () => {
    await withBind(async () => {
      const shell = fakeShell({
        "tailscale status --json": STATUS,
        "tailscale serve status --json": served(4110),
      });
      const status = await runWithShell(shell, publishTailscale());
      expect(status.publishedUrl).toBe("https://omarchy.tailnet.ts.net/");
      expect(shell.calls.some((call) => call.cmd.includes("--bg"))).toBe(false);
    });
  });

  test("publish refuses when the external listener is not listening", async () => {
    const saved = runtimeRemoteAccessStatus();
    setRemoteAccessStatus({ enabled: true, listening: false, error: "busy" });
    try {
      await withRuntimeConfig({ remoteAccess: { enabled: true, port: 4110 } }, async () => {
        const shell = fakeShell({ "tailscale status --json": STATUS });
        const outcome = await runWithShell(shell, Effect.either(publishTailscale()));
        expect(outcome._tag).toBe("Left");
        expect(shell.calls.some((call) => call.cmd.includes("--bg"))).toBe(false);
      });
    } finally {
      setRemoteAccessStatus(saved);
    }
  });

  test("unpublish removes only our mapping, with --https=443 off", async () => {
    await withBind(async () => {
      const shell = fakeShell({
        "tailscale status --json": STATUS,
        "tailscale serve status --json": served(4110),
      });
      await runWithShell(shell, unpublishTailscale());
      expect(shell.calls.map((call) => call.cmd.join(" "))).toContain(
        "tailscale serve --https=443 off",
      );
    });
  });

  test("unpublish leaves a foreign mapping alone and runs no command", async () => {
    await withBind(async () => {
      const shell = fakeShell({
        "tailscale status --json": STATUS,
        "tailscale serve status --json": served(8080),
      });
      await runWithShell(shell, unpublishTailscale());
      expect(shell.calls.some((call) => call.cmd.includes("off"))).toBe(false);
    });
  });

  test("unpublish refuses to clear a 443 tree that also serves a foreign path", async () => {
    await withBind(async () => {
      const mixed = JSON.stringify({
        Web: {
          "host:443": {
            Handlers: {
              "/": { Proxy: "http://127.0.0.1:4110" },
              "/admin": { Proxy: "http://127.0.0.1:8080" },
            },
          },
        },
      });
      const shell = fakeShell({
        "tailscale status --json": STATUS,
        "tailscale serve status --json": mixed,
      });
      const outcome = await runWithShell(shell, Effect.either(unpublishTailscale()));
      expect(outcome._tag).toBe("Left");
      if (outcome._tag === "Left") expect(outcome.left.message).toContain("also serves");
      expect(shell.calls.some((call) => call.cmd.includes("off"))).toBe(false);
    });
  });

  test("unpublish finds the mapping Corvi published after the configured port changed", async () => {
    await withPublication(async () => {
      // Published on 4110, then the listener moved to 5000: unpublish must remove 4110's mapping,
      // not look for one on 5000 and give up.
      setTailscalePublishedPort(4110);
      setRemoteAccessStatus({
        enabled: true,
        listening: true,
        port: 5000,
        url: "http://127.0.0.1:5000/",
      });
      const shell = fakeShell({
        "tailscale status --json": STATUS,
        "tailscale serve status --json": served(4110),
      });
      await runWithShell(shell, unpublishTailscale());
      expect(shell.calls.map((call) => call.cmd.join(" "))).toContain(
        "tailscale serve --https=443 off",
      );
      expect(runtimeTailscalePublishedPort()).toBeUndefined();
    });
  });

  test("reconcile moves the mapping to the listener's new port", async () => {
    await withPublication(async () => {
      setTailscalePublishedPort(4110);
      setRemoteAccessStatus({
        enabled: true,
        listening: true,
        port: 5000,
        url: "http://127.0.0.1:5000/",
      });
      let mappings = served(4110);
      const shell = fakeShell((cmd) => {
        const line = cmd.join(" ");
        if (line === "tailscale status --json") return STATUS;
        if (line === "tailscale serve status --json") return mappings;
        if (line === "tailscale serve --https=443 off") {
          mappings = "{}";
          return "";
        }
        if (line === "tailscale serve --bg 5000") {
          mappings = served(5000);
          return "";
        }
        return undefined;
      });
      await runWithShell(shell, reconcileTailscale({ listening: true, port: 5000 }));
      const calls = shell.calls.map((call) => call.cmd.join(" "));
      expect(calls).toContain("tailscale serve --https=443 off");
      expect(calls).toContain("tailscale serve --bg 5000");
      expect(runtimeTailscalePublishedPort()).toBe(5000);
    });
  });

  test("publish serves the port the listener is actually on", async () => {
    await withPublication(async () => {
      setTailscalePublishedPort(undefined);
      setRemoteAccessStatus({
        enabled: true,
        listening: true,
        port: 5000,
        url: "http://127.0.0.1:5000/",
      });
      // The config still says 4110: a save in flight must not be what publish reads.
      await withRuntimeConfig({ remoteAccess: { enabled: true, port: 4110 } }, async () => {
        const shell = fakeShell({
          "tailscale status --json": STATUS,
          "tailscale serve status --json": "{}",
        });
        await runWithShell(shell, publishTailscale());
        expect(shell.calls.map((call) => call.cmd.join(" "))).toContain(
          "tailscale serve --bg 5000",
        );
        expect(runtimeTailscalePublishedPort()).toBe(5000);
      });
    });
  });

  test("the status route answers the contract shape", async () => {
    await withBind(async () => {
      const shell = fakeShell({
        "tailscale status --json": STATUS,
        "tailscale serve status --json": served(4110),
      });
      const response = await runRouteWithShell(shell, Effect.map(tailscaleStatus(), json));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        available: true,
        running: true,
        dnsName: "omarchy.tailnet.ts.net",
        publishedUrl: "https://omarchy.tailnet.ts.net/",
      });
    });
  });
});
