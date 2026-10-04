/** The external listener's lifecycle: start, stop and reconcile it as `remoteAccess` changes.
 *
 * The local listener is started once and never touched. The external one is optional and, since
 * 1.3, toggled from the settings page, so it cannot be a thing the process builds once and
 * forgets: this owns the current `Serving` and brings it in line with the config on demand.
 * `remoteAccess.enabled` off stops it; a changed port restarts it; the same port is left alone.
 *
 * A bind that fails is not fatal — remote access is optional, so the process keeps serving
 * locally and the failure is visible through the runtime status. The listener serves the route
 * table the caller built and authenticates with the device-token hook (`devices/server/auth.ts`).
 */
import { Effect, Either } from "effect";

import { runtimeConfig, setRemoteAccessStatus } from "../capabilities/runtime.ts";
import { inExternalGate } from "../capabilities/gate.ts";
import { serve, type Serving, type WebSocketHandlers } from "../capabilities/serve.ts";
import { authorizeExternalRequest } from "../devices/server/index.ts";
import { reconcileTailscale } from "../tailscale/server/index.ts";
import type { TerminalSocket } from "../terminals/server/session.ts";

export type RemoteAccess = {
  /** Bring the listener in line with `runtimeConfig().remoteAccess`. Serialized, so two
   * settings saves cannot start two listeners. */
  reconcile: () => Effect.Effect<void>;
  /** Stop the external listener synchronously, for a signal handler that is about to exit. */
  stop: () => void;
};

export const makeRemoteAccess = (options: {
  readonly routes: Record<string, unknown>;
  readonly websocket: WebSocketHandlers<TerminalSocket>;
}): RemoteAccess => {
  let serving: Serving | undefined;
  let port: number | undefined;

  // One reconcile at a time, through the shared external gate: a save that changes the port twice
  // in quick succession must not leave the first listener running beside the second, and a
  // Tailscale click must not interleave with a reconcile's command.

  const start = (nextPort: number): Promise<Serving> =>
    serve<TerminalSocket>({
      port: nextPort,
      hostname: "127.0.0.1",
      routes: options.routes,
      websocket: options.websocket,
      authorize: authorizeExternalRequest,
    });

  const reconcileOne = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      const remoteAccess = runtimeConfig().remoteAccess;
      if (!remoteAccess.enabled) {
        serving?.stop();
        serving = undefined;
        port = undefined;
        setRemoteAccessStatus({ enabled: false, listening: false });
        // A disabled listener's published mapping points at nothing: remove it.
        yield* reconcileTailscale({ listening: false });
        return;
      }
      // The same configured port and a listener still accepting: nothing to do but refresh the
      // status. `isListening` rather than `serving !== undefined`: a closed listener is not one.
      if (serving !== undefined && port === remoteAccess.port && serving.isListening()) {
        setRemoteAccessStatus({
          enabled: true,
          listening: true,
          port: serving.port,
          url: serving.url.toString(),
        });
        yield* reconcileTailscale({ listening: true, port: serving.port });
        return;
      }

      serving?.stop();
      serving = undefined;
      port = undefined;
      const started = yield* Effect.either(Effect.tryPromise(() => start(remoteAccess.port)));
      if (Either.isLeft(started)) {
        const message = started.left instanceof Error ? started.left.message : String(started.left);
        setRemoteAccessStatus({ enabled: true, listening: false, error: message });
        console.error(
          `could not start the external listener on 127.0.0.1:${remoteAccess.port}: ${message}`,
        );
        console.error("remote access is unavailable until that port is free; serving locally.");
        // A mapping to a listener that never came up is dead: remove it.
        yield* reconcileTailscale({ listening: false });
        return;
      }
      serving = started.right;
      port = remoteAccess.port;
      setRemoteAccessStatus({
        enabled: true,
        listening: true,
        port: serving.port,
        url: serving.url.toString(),
      });
      yield* reconcileTailscale({ listening: true, port: serving.port });
    });

  return {
    reconcile: (): Effect.Effect<void> => inExternalGate(reconcileOne()),
    stop: (): void => {
      serving?.stop();
      serving = undefined;
      port = undefined;
    },
  };
};
