import { expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Effect } from "effect";

import {
  runtimeConfig,
  runtimeRemoteAccessStatus,
  setRemoteAccessStatus,
  setRuntime,
} from "../apps/server/src/capabilities/runtime.ts";
import { makeRemoteAccess } from "../apps/server/src/remote-access/server.ts";
import { writeSettings } from "../apps/server/src/settings/server/index.ts";
import { runEffect } from "./helpers.ts";

/**
 * The external listener's lifecycle: it is not built once at process start any more, so a
 * settings save can start, stop or restart it. The local listener is never involved.
 */

const routes = { "/": () => new Response("ok") };
const websocket = {};

/** A port the OS says is free, used only to prove a restart bound a different one. */
const freePort = async (): Promise<number> => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
};

test("the external listener starts, stops and restarts with the config", async () => {
  const controller = makeRemoteAccess({ routes, websocket });
  const savedConfig = runtimeConfig().remoteAccess;
  const savedStatus = runtimeRemoteAccessStatus();
  try {
    runtimeConfig().remoteAccess = { enabled: true, port: 0 };
    await Effect.runPromise(controller.reconcile());
    const up = runtimeRemoteAccessStatus();
    expect(up.listening).toBe(true);
    expect(await (await fetch(up.url!)).text()).toBe("ok");

    runtimeConfig().remoteAccess = { enabled: false, port: 0 };
    await Effect.runPromise(controller.reconcile());
    expect(runtimeRemoteAccessStatus().listening).toBe(false);
    expect(await fetch(up.url!).then(() => false, () => true)).toBe(true);

    // A changed port restarts: the old listener is gone and the new one answers.
    const port = await freePort();
    runtimeConfig().remoteAccess = { enabled: true, port };
    await Effect.runPromise(controller.reconcile());
    const restarted = runtimeRemoteAccessStatus();
    expect(restarted.listening).toBe(true);
    expect(restarted.url).toContain(`:${port}/`);
    expect(await (await fetch(restarted.url!)).text()).toBe("ok");
  } finally {
    controller.stop();
    runtimeConfig().remoteAccess = savedConfig;
    setRemoteAccessStatus(savedStatus);
  }
});

test("a settings save reconciles the listener without a restart", async () => {
  const controller = makeRemoteAccess({ routes, websocket });
  const savedConfig = runtimeConfig().remoteAccess;
  const savedStatus = runtimeRemoteAccessStatus();
  setRuntime({ reconcileRemoteAccess: controller.reconcile });
  try {
    const port = await freePort();
    await runEffect(writeSettings({ remoteAccess: { enabled: true, port } }));
    expect(runtimeRemoteAccessStatus().listening).toBe(true);
    expect(runtimeRemoteAccessStatus().url).toContain(`:${port}/`);

    await runEffect(writeSettings({ remoteAccess: { enabled: false, port } }));
    expect(runtimeRemoteAccessStatus().listening).toBe(false);
  } finally {
    controller.stop();
    setRuntime({ reconcileRemoteAccess: () => Effect.void });
    runtimeConfig().remoteAccess = savedConfig;
    setRemoteAccessStatus(savedStatus);
  }
});
