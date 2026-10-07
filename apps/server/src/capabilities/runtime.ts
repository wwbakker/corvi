import { Effect } from "effect";

import { defaultCache, type CacheStore } from "./cache.ts";
import type { Config } from "@corvi/configuration/config";
import type { RemoteAccessStatusDto } from "@corvi/contracts/api";
import type { RemoteAvailabilitySnapshotDto } from "@corvi/contracts/availability";
import { NotFoundError } from "@corvi/contracts/errors";
import { DEFAULT_GATEWAY_TIMEOUTS, type GatewayTimeouts } from "../gateway/server/timeouts.ts";
import type { RemoteObservation } from "../remote-events/model.ts";
import { readConfig, reloadInto } from "../workspace/server/config.ts";
import { createRedeemLimiter, type RedeemLimiter } from "../devices/server/rate-limit.ts";

/**
 * The process's runtime: the instances the entrypoint constructs once and every request reads.
 *
 * A holder rather than a value threaded through every route: the server installs the cache it
 * built, and the config snapshot is created on first use (or installed, as tests do) and refilled
 * in place by the settings write. Routes reach for the runtime through its accessors instead of
 * receiving it as a parameter.
 */
export type Runtime = {
  readonly cache: CacheStore;
  readonly config: Config;
  /** The pairing-redeem rate limiter this process owns. */
  readonly redeemLimiter: RedeemLimiter;
  /** Whether the external listener is actually running; the settings page reads it. Set by the
   * entrypoint after it binds (or fails to). */
  readonly remoteAccessStatus: RemoteAccessStatusDto;
  /** The loopback port Corvi actually published through `tailscale serve`, when it did. Runtime
   * state, not config: it lets unpublish remove the mapping it made even after the configured
   * port changed. */
  readonly tailscalePublishedPort: number | undefined;
  /** Bring the external listener in line with the current config. The entrypoint installs the
   * real one; the default does nothing, so a test or script that never starts a server is safe. */
  readonly reconcileRemoteAccess: () => Effect.Effect<void>;
  /** Bring the remote-event subscriptions in line with the current config. The entrypoint
   * installs the real one; the default does nothing. */
  readonly reconcileRemoteEvents: () => Effect.Effect<void>;
  /** The availability owner's current map. The unstarted default is empty, not a claim. */
  readonly remoteAvailabilitySnapshot: () => RemoteAvailabilitySnapshotDto;
  /** Ask the availability owner for an immediate coordinated health check of one source. */
  readonly remoteAvailabilityRetry: (
    source: string,
  ) => Effect.Effect<RemoteAvailabilitySnapshotDto, NotFoundError>;
  /** A transport-level observation from the gateway: at most a request for a recheck. */
  readonly remoteAvailabilityObserve: (source: string, observation: RemoteObservation) => void;
  /** The gateway's bounded waits. The entrypoint builds them; the defaults are the shared ones. */
  readonly gatewayTimeouts: GatewayTimeouts;
};

let current: Runtime | undefined;

/** The runtime, constructed on first use when the entrypoint has not installed one: a test or a
 * script gets the process default cache and the config file as written. */
const runtime = (): Runtime =>
  (current ??= {
    cache: defaultCache,
    config: readConfig(),
    redeemLimiter: createRedeemLimiter(),
    remoteAccessStatus: { enabled: false, listening: false },
    tailscalePublishedPort: undefined,
    reconcileRemoteAccess: () => Effect.void,
    reconcileRemoteEvents: () => Effect.void,
    remoteAvailabilitySnapshot: () => ({ instance: "unstarted", revision: 0, availability: [] }),
    remoteAvailabilityRetry: (source) =>
      Effect.fail(new NotFoundError({ message: `no such remote workspace: ${source}` })),
    remoteAvailabilityObserve: () => undefined,
    gatewayTimeouts: DEFAULT_GATEWAY_TIMEOUTS,
  });


/** Install (or replace parts of) the runtime. The entrypoint calls this before serving; tests
 * set and reset it around a case. */
export const setRuntime = (next: Partial<Runtime>): void => {
  current = { ...runtime(), ...next };
};

/** Drop the installed runtime; the next read constructs a fresh one. */
export const resetRuntime = (): void => {
  current = undefined;
};

/** The runtime's cache. */
export const runtimeCache = (): CacheStore => runtime().cache;

/** The runtime's config snapshot: the one object every module reads, refilled in place by the
 * settings write so references stay valid. */
export const runtimeConfig = (): Config => runtime().config;

/** The runtime's pairing-redeem limiter. */
export const runtimeRedeemLimiter = (): RedeemLimiter => runtime().redeemLimiter;

/** Whether the external listener is running, for the settings page. */
export const runtimeRemoteAccessStatus = (): RemoteAccessStatusDto => runtime().remoteAccessStatus;

/** Record the result of the external listener's bind attempt. The entrypoint calls this once at
 * startup; a failed bind leaves the process serving locally with the failure visible here. */
export const setRemoteAccessStatus = (status: RemoteAccessStatusDto): void => {
  current = { ...runtime(), remoteAccessStatus: status };
};

/** The port Corvi last published through `tailscale serve`, or undefined. */
export const runtimeTailscalePublishedPort = (): number | undefined =>
  runtime().tailscalePublishedPort;

/** Record (or clear, with `undefined`) the port Corvi published. */
export const setTailscalePublishedPort = (port: number | undefined): void => {
  current = { ...runtime(), tailscalePublishedPort: port };
};

/** Bring the external listener in line with the config. The settings write calls this after a
 * save, so toggling remote access takes effect without a restart. */
export const runtimeReconcileRemoteAccess = (): Effect.Effect<void> =>
  runtime().reconcileRemoteAccess();

/** Bring the remote-event subscriptions in line with the config. The settings write calls this
 * after a save, so adding or removing a remote workspace takes effect at once. */
export const runtimeReconcileRemoteEvents = (): Effect.Effect<void> =>
  runtime().reconcileRemoteEvents();

/** The availability owner's current map, for the snapshot route. */
export const runtimeRemoteAvailabilitySnapshot = (): RemoteAvailabilitySnapshotDto =>
  runtime().remoteAvailabilitySnapshot();

/** Ask for an immediate coordinated health check of one source, for the retry route. */
export const runtimeRemoteAvailabilityRetry = (
  source: string,
): Effect.Effect<RemoteAvailabilitySnapshotDto, NotFoundError> => runtime().remoteAvailabilityRetry(source);

/** Report a transport-level observation from the gateway. It may at most request a recheck. */
export const runtimeRemoteAvailabilityObserve = (source: string, observation: RemoteObservation): void =>
  runtime().remoteAvailabilityObserve(source, observation);

/** The gateway's bounded waits, built by the entrypoint. */
export const runtimeGatewayTimeouts = (): GatewayTimeouts => runtime().gatewayTimeouts;

/** Refill the snapshot from the file. Sync, because the settings write path is synchronous and
 * the object identity must not change. */
export const reloadConfigSync = (): Config => reloadInto(runtimeConfig());

/** The same refill as an Effect, for the settings page's Effect write path. */
export const reloadConfig: Effect.Effect<Config> = Effect.sync(reloadConfigSync);
