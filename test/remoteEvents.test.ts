import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { SourceEventDto } from "@corvi/contracts/events";
import { eventsRoutes } from "../apps/server/src/capabilities/bus.ts";
import { serve, type Serving } from "../apps/server/src/capabilities/serve.ts";
import { makeRemoteEvents, type RemoteEvents } from "../apps/server/src/remote-events/server.ts";
import { configPath, reloadConfigSync } from "../apps/server/src/workspace/server/index.ts";
import { runEffect, until } from "./helpers.ts";

/**
 * The remote-event fan-in, against fake remote SSE servers: a remote event lands on the local
 * stream under the `source` envelope, a dropped stream reconnects, a local-only config watches
 * nothing, and the config's changes start and stop subscriptions. The bearer token is on the
 * upstream request and nowhere downstream.
 */

type Frame = { event: string; data: string };

const parseSse = (frame: string): Frame | undefined => {
  let event: string | undefined;
  const data: string[] = [];
  for (const raw of frame.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line === "" || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return event === undefined ? undefined : { event, data: data.join("\n") };
};

/** A fake remote events server whose per-connection behaviour a test can set. */
type FakeRemote = {
  readonly url: string;
  readonly connections: () => number;
  readonly open: () => number;
  readonly auth: () => readonly (string | undefined)[];
  readonly onConnection: (handler: (res: ServerResponse, connection: number) => void) => void;
  readonly stop: () => void;
};

const fakeRemote = async (): Promise<FakeRemote> => {
  let connections = 0;
  let open = 0;
  const auth: (string | undefined)[] = [];
  let handler: (res: ServerResponse, connection: number) => void = (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: changes\ndata: \n\n");
  };
  const server = createServer((req, res) => {
    if (!req.url?.startsWith("/api/events")) {
      res.writeHead(404);
      res.end();
      return;
    }
    connections += 1;
    open += 1;
    auth.push(req.headers.authorization);
    res.on("close", () => {
      open -= 1;
    });
    handler(res, connections);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    connections: () => connections,
    open: () => open,
    auth: () => auth,
    onConnection: (next) => {
      handler = next;
    },
    stop: () => server.close(),
  };
};

let local: Serving;
let controllers: RemoteEvents[];
let fakes: FakeRemote[];

const newFake = async (): Promise<FakeRemote> => {
  const fake = await fakeRemote();
  fakes.push(fake);
  return fake;
};

const newController = (): RemoteEvents => {
  const controller = makeRemoteEvents();
  controllers.push(controller);
  return controller;
};

const writeConfig = (workspaces: unknown[]): void => {
  writeFileSync(configPath(), JSON.stringify({ workspaces }));
  reloadConfigSync();
};

const remoteWorkspace = (id: string, url: string, token = "remote-token"): unknown => ({
  id,
  name: id,
  remote: { url, workspace: id, token },
});

/** Connect to the local stream and read frames; `until` skips until the named event. */
const connectLocal = async (
  timeoutMs = 10_000,
): Promise<{ until: (name: string) => Promise<Frame | undefined>; close: () => void }> => {
  const controller = new AbortController();
  const response = await fetch(new URL("api/events", local.url), {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const next = async (): Promise<Frame> => {
    for (;;) {
      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        const parsed = parseSse(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
        if (parsed !== undefined) return parsed;
        index = buffer.indexOf("\n\n");
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("the local events stream ended");
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    }
  };
  return {
    until: async (name) => {
      try {
        for (;;) {
          const frame = await next();
          if (frame.event === name) return frame;
        }
      } catch {
        return undefined;
      }
    },
    close: () => controller.abort(),
  };
};

beforeAll(async () => {
  controllers = [];
  fakes = [];
  local = await serve({ port: 0, routes: eventsRoutes });
});

afterEach(() => {
  for (const controller of controllers) controller.stop();
  controllers = [];
  for (const fake of fakes) fake.stop();
  fakes = [];
});

afterAll(() => {
  local?.stop();
});

test("a remote event is re-emitted on the local stream with its source", async () => {
  const fake = await newFake();
  writeConfig([remoteWorkspace("remote-client", fake.url)]);
  const controller = newController();

  const stream = await connectLocal();
  try {
    // The stream's `open` frame proves the client is registered before the fan-in starts.
    expect((await stream.until("open"))?.event).toBe("open");
    await runEffect(controller.reconcile());

    const frame = await stream.until("source");
    expect(frame).toBeDefined();
    expect(JSON.parse(frame!.data)).toEqual({ source: "remote-client", event: "changes", data: "" });
    // The upstream carried the bearer token; the local frame does not.
    expect(fake.auth()).toContain("Bearer remote-token");
    expect(frame!.data).not.toContain("remote-token");
  } finally {
    stream.close();
  }
});

test("a remote stream that ends reconnects", async () => {
  const fake = await newFake();
  fake.onConnection((res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: changes\ndata: \n\n");
    res.end();
  });
  writeConfig([remoteWorkspace("remote-client", fake.url)]);
  const controller = newController();

  await runEffect(controller.reconcile());
  await until(async () => fake.connections() >= 2, true, 5000);
  expect(fake.connections()).toBeGreaterThanOrEqual(2);
});

test("a local-only config opens no remote subscriptions", async () => {
  const fake = await newFake();
  writeConfig([{ id: "local", name: "Local" }]);
  const controller = newController();

  await runEffect(controller.reconcile());
  await Bun.sleep(100);
  expect(fake.connections()).toBe(0);
});

test("adding and removing a remote workspace starts and stops its subscription", async () => {
  const fake = await newFake();
  writeConfig([]);
  const controller = newController();
  await runEffect(controller.reconcile());
  expect(fake.open()).toBe(0);

  writeConfig([remoteWorkspace("remote-client", fake.url)]);
  await runEffect(controller.reconcile());
  await until(async () => fake.open() === 1, true, 5000);
  expect(fake.connections()).toBeGreaterThanOrEqual(1);

  writeConfig([]);
  await runEffect(controller.reconcile());
  await until(async () => fake.open() === 0, true, 5000);
  expect(fake.open()).toBe(0);
});

test("frames split across chunks, with CRLF and multi-line data, are assembled", async () => {
  const fake = await newFake();
  fake.onConnection((res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: notify\r\ndata: line-");
    setTimeout(() => {
      res.write("1\r\ndata: line-2\r\n");
      setTimeout(() => res.write("\r\n"), 10);
    }, 20);
  });
  writeConfig([remoteWorkspace("remote-client", fake.url)]);
  const controller = newController();

  const stream = await connectLocal();
  try {
    expect((await stream.until("open"))?.event).toBe("open");
    await runEffect(controller.reconcile());
    const frame = await stream.until("source");
    expect(frame).toBeDefined();
    expect(JSON.parse(frame!.data)).toEqual({
      source: "remote-client",
      event: "notify",
      data: "line-1\nline-2",
    });
  } finally {
    stream.close();
  }
});

test("a retargeted workspace restarts its subscription", async () => {
  const fake = await newFake();
  writeConfig([remoteWorkspace("remote-client", fake.url, "first-token")]);
  const controller = newController();

  await runEffect(controller.reconcile());
  await until(async () => fake.connections() === 1, true, 5000);
  expect(fake.auth()).toEqual(["Bearer first-token"]);

  writeConfig([remoteWorkspace("remote-client", fake.url, "second-token")]);
  await runEffect(controller.reconcile());
  await until(async () => fake.connections() === 2, true, 5000);
  expect(fake.auth()[1]).toBe("Bearer second-token");
});

test("two remotes emit distinct source envelopes", async () => {
  const first = await newFake();
  const second = await newFake();
  first.onConnection((res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: changes\ndata: \n\n");
  });
  second.onConnection((res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: windows\ndata: \n\n");
  });
  writeConfig([remoteWorkspace("first", first.url), remoteWorkspace("second", second.url)]);
  const controller = newController();

  const stream = await connectLocal();
  try {
    expect((await stream.until("open"))?.event).toBe("open");
    await runEffect(controller.reconcile());
    const one = await stream.until("source");
    const two = await stream.until("source");
    expect(one).toBeDefined();
    expect(two).toBeDefined();
    const envelopes = [JSON.parse(one!.data), JSON.parse(two!.data)] as SourceEventDto[];
    expect(envelopes).toContainEqual({ source: "first", event: "changes", data: "" });
    expect(envelopes).toContainEqual({ source: "second", event: "windows", data: "" });
  } finally {
    stream.close();
  }
});

test("a redirect from the remote is refused, not followed", async () => {
  const target = await newFake();
  const redirecting = await newFake();
  redirecting.onConnection((res) => {
    res.writeHead(302, { location: `${target.url}/api/events` });
    res.end();
  });
  writeConfig([remoteWorkspace("remote-client", redirecting.url)]);
  const controller = newController();

  const stream = await connectLocal(1500);
  try {
    expect((await stream.until("open"))?.event).toBe("open");
    await runEffect(controller.reconcile());
    // No source event arrives, and the off-origin target is never fetched.
    expect(await stream.until("source")).toBeUndefined();
    // The redirecting remote was tried (and retried on its backoff); the off-origin target was
    // never fetched at all.
    expect(target.connections()).toBe(0);
    expect(redirecting.connections()).toBeGreaterThanOrEqual(1);
  } finally {
    stream.close();
  }
});
