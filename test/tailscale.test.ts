import { statSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { json } from "../apps/server/src/capabilities/web.ts";
import { inExternalGate } from "../apps/server/src/capabilities/gate.ts";
import {
  decideServe,
  parseServeMappings,
  parseTailscaleStatus,
  persistPublishedPort,
  publicationPath,
  publicUrlFor,
  publishTailscale,
  readPublishedPort,
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

  test("status flags a shared 443 as mixed and another service's as conflict", async () => {
    await withBind(async () => {
      // Our handler beside another path: a shared tree, which `off` would clear wholesale.
      const shared = JSON.stringify({
        Web: {
          "host:443": {
            Handlers: {
              "/": { Proxy: "http://127.0.0.1:4110" },
              "/admin": { Proxy: "http://127.0.0.1:8080" },
            },
          },
        },
      });
      const mixed = await runWithShell(
        fakeShell({ "tailscale status --json": STATUS, "tailscale serve status --json": shared }),
        tailscaleStatus(),
      );
      expect(mixed.blocked).toBe("mixed");
      expect(mixed.publishedUrl).toBeUndefined();
      expect(mixed.error).toContain("also serves");

      // Another service holds 443 and ours is not among the handlers.
      const conflict = await runWithShell(
        fakeShell({ "tailscale status --json": STATUS, "tailscale serve status --json": served(8080) }),
        tailscaleStatus(),
      );
      expect(conflict.blocked).toBe("conflict");
      expect(conflict.publishedUrl).toBeUndefined();
      expect(conflict.error).toContain("443 already serves 8080");
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
      const outcome = await runWithShell(shell, Effect.result(publishTailscale()));
      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") expect(outcome.failure.message).toContain("443 already serves 8080");
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
        const outcome = await runWithShell(shell, Effect.result(publishTailscale()));
        expect(outcome._tag).toBe("Failure");
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
      const outcome = await runWithShell(shell, Effect.result(unpublishTailscale()));
      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") expect(outcome.failure.message).toContain("also serves");
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

  test("the published port is remembered across a restart", async () => {
    await withBind(async () => {
      try {
        persistPublishedPort(undefined);
        let mappings = "{}";
        const shell = fakeShell((cmd) => {
          const line = cmd.join(" ");
          if (line === "tailscale status --json") return STATUS;
          if (line === "tailscale serve status --json") return mappings;
          if (line === "tailscale serve --bg 4110") {
            mappings = served(4110);
            return "";
          }
          if (line === "tailscale serve --https=443 off") {
            mappings = "{}";
            return "";
          }
          return undefined;
        });

        await runWithShell(shell, publishTailscale());
        expect(runtimeTailscalePublishedPort()).toBe(4110);
        // The record is owner-only, and on disk: what a restart reads back.
        expect(statSync(publicationPath()).mode & 0o777).toBe(0o600);
        expect(readPublishedPort()).toBe(4110);

        // A restart: the runtime forgets, the file remembers.
        setTailscalePublishedPort(undefined);
        expect(runtimeTailscalePublishedPort()).toBeUndefined();
        setTailscalePublishedPort(readPublishedPort());
        expect(runtimeTailscalePublishedPort()).toBe(4110);

        // Unpublish clears the record, so the next restart finds nothing to clean up.
        await runWithShell(shell, unpublishTailscale());
        expect(runtimeTailscalePublishedPort()).toBeUndefined();
        expect(readPublishedPort()).toBeUndefined();
      } finally {
        persistPublishedPort(undefined);
      }
    });
  });

  test("a corrupt or out-of-range record reads as no record", () => {
    try {
      persistPublishedPort(4110); // creates the file (and its directory) first
      const corrupt = (text: string): number | undefined => {
        writeFileSync(publicationPath(), text);
        return readPublishedPort();
      };
      // A hand-mangled file is no record, not a wrong port.
      expect(corrupt(JSON.stringify({ port: 0 }))).toBeUndefined();
      expect(corrupt(JSON.stringify({ port: 70000 }))).toBeUndefined();
      expect(corrupt(JSON.stringify({ port: "4110" }))).toBeUndefined();
      expect(corrupt("not json")).toBeUndefined();
      // A real port is a record.
      expect(corrupt(JSON.stringify({ port: 4110 }))).toBe(4110);
    } finally {
      persistPublishedPort(undefined);
    }
  });

  test("a Tailscale click cannot interleave with a save's tracked-port change", async () => {
    setTailscalePublishedPort(4110);
    const events: string[] = [];
    const save = Effect.gen(function* () {
      events.push(`save:saw=${runtimeTailscalePublishedPort()}`);
      yield* Effect.sleep("40 millis");
      setTailscalePublishedPort(undefined);
      events.push("save:cleared");
    });
    const click = Effect.gen(function* () {
      events.push(`click:saw=${runtimeTailscalePublishedPort()}`);
      setTailscalePublishedPort(5000);
      events.push("click:published");
    });
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.forkChild(inExternalGate(save));
          // Let the save take the gate and reach its sleep, where an unguarded click would slip in.
          yield* Effect.sleep("5 millis");
          yield* inExternalGate(click);
        }),
      );
      // Serialized: the click read what the save left, not the stale 4110 it would have seen
      // inside the save's window.
      expect(events).toEqual([
        "save:saw=4110",
        "save:cleared",
        "click:saw=undefined",
        "click:published",
      ]);
    } finally {
      setTailscalePublishedPort(undefined);
    }
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
