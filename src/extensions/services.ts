import { Effect, Layer } from "effect";
import { Bus, Cache, Shell, Settings, Workspace, type Capabilities } from "./api.ts";
import { shEffectWithEnv } from "../sh.ts";
import { invalidate, swrEffect } from "../cache.ts";
import { config } from "../config.ts";
import { announce } from "../events.ts";
import { envOf } from "../context.ts";
import type { Workspace as WorkspaceShape } from "../config.ts";

/**
 * The live layers behind the capabilities (src/extensions/api.ts) — host-side, not part of
 * the contract. One static layer per service; the request's workspace is provided alongside
 * them per request, which is what lets `Shell` read it at run time instead of the layer
 * being built per request.
 */

/** `run` requires `Workspace` in its own R — the environment comes from the tag, read at
 * run time, so one Shell instance serves every request and `~` expansion stays where the
 * rest of the env handling lives (src/context.ts). */
export const ShellLive = Layer.effect(
  Shell,
  Effect.succeed({
    run: (cmd, opts) =>
      Effect.flatMap(Workspace, (workspace) => shEffectWithEnv(cmd, opts?.cwd, envOf(workspace))),
  }),
);

export const CacheLive = Layer.succeed(Cache, {
  swr: (key, ttlMs, work) => swrEffect(key, ttlMs, work),
  invalidate: (prefix) => Effect.sync(() => invalidate(prefix)),
});

// The same refilled object every module holds by reference: a settings-page save is visible
// through the service without restart, exactly as it is through direct imports today.
export const SettingsLive = Layer.succeed(Settings, config);

export const BusLive = Layer.succeed(Bus, {
  announce: (event) => Effect.sync(() => announce(event)),
});

/** Everything an extension's effect may ask for, provided at once: the request's workspace
 * plus the four services. Contributed effects run through this, so their requirements are
 * satisfied wherever the host runs them — cards, hooks, lookups, steps, routes. */
export const capabilitiesLayer = (workspace: WorkspaceShape): Layer.Layer<Capabilities> =>
  Layer.mergeAll(
    ShellLive,
    CacheLive,
    SettingsLive,
    BusLive,
    Layer.succeed(Workspace, workspace),
  );
