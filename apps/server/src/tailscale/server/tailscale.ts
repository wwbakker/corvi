/** Publishing the external listener through Tailscale.
 *
 * The server never binds a network interface: `tailscale serve` proxies a loopback port at
 * `https://<machine>.<tailnet>.ts.net/`, with a Tailscale-issued certificate, and decides who may
 * reach it. This module only runs that command. It reads what 443 serves first and refuses to
 * touch a mapping that is not ours, so enabling never displaces another service and disabling
 * removes our one mapping rather than resetting the machine's serve configuration.
 *
 * `tailscale serve --https=443 off` clears the whole 443 tree, so it is only run when every
 * handler there is ours; a shared tree is refused with a message the settings page shows. Corvi
 * tracks the port it actually published (runtime state, not config) so unpublish still finds the
 * mapping after the configured port has moved, and `reconcileTailscale` moves the mapping with
 * the listener.
 *
 * Every command is an argument array (`@corvi/shell`), never a shell string, and the port is
 * validated by the config schema (1..65535) before it is named as an argument.
 */
import { Effect, Either } from "effect";

import { BadRequestError } from "@corvi/contracts/errors";
import type { TailscaleStatusDto } from "@corvi/contracts/tailscale";
import {
  runtimeConfig,
  runtimeRemoteAccessStatus,
  runtimeTailscalePublishedPort,
  setTailscalePublishedPort,
} from "../../capabilities/runtime.ts";
import { sh, type Result } from "../../capabilities/shell.ts";
import {
  decideServe,
  firstLine,
  parseServeMappings,
  parseTailscaleStatus,
  publicUrlFor,
  SERVE_EXTERNAL_PORT,
  type ServeMapping,
} from "./parse.ts";
import { persistPublishedPort } from "./publication.ts";

/** One `tailscale` call whose failures are data: a missing binary is code 127 and a timeout is
 * the shell's own code, either way a `Result` the caller branches on. */
const runTailscale = (args: readonly string[]): Effect.Effect<Result> =>
  sh(["tailscale", ...args]).pipe(
    Effect.catchAll((error) =>
      Effect.succeed({ code: error.exitCode, stdout: "", stderr: error.stderr }),
    ),
  );

const readServeMappings = (): Effect.Effect<readonly ServeMapping[]> =>
  Effect.gen(function* () {
    const result = yield* runTailscale(["serve", "status", "--json"]);
    return result.code === 0 ? parseServeMappings(result.stdout) : [];
  });

/** Track the port Corvi published in the runtime, and remember it on disk so a restart recognizes
 * the 443 mapping. Called on every publish and unpublish, never with anything else. */
const remember = (port: number | undefined): void => {
  setTailscalePublishedPort(port);
  persistPublishedPort(port);
};

/** The port whose 443 mapping is Corvi's: what it published, else what the listener is bound to,
 * else what the config asks for. */
const publicationPort = (): number | undefined =>
  runtimeTailscalePublishedPort() ??
  runtimeRemoteAccessStatus().port ??
  runtimeConfig().remoteAccess.port;

const describeForeign = (foreignPorts: readonly (number | undefined)[]): string =>
  foreignPorts.length === 0
    ? "something else"
    : foreignPorts.map((port) => (port === undefined ? "another handler" : `port ${port}`)).join(", ");

/** What Tailscale is doing right now, and whether our external port is published. */
export const tailscaleStatus = (): Effect.Effect<TailscaleStatusDto> =>
  Effect.gen(function* () {
    const status = yield* runTailscale(["status", "--json"]);
    if (status.code === 127) {
      return { available: false, running: false, error: "tailscale is not installed" };
    }
    const parsed = parseTailscaleStatus(status.stdout);
    if (!parsed.running) {
      return {
        available: true,
        running: false,
        error: firstLine(status.stderr) || "tailscale is not connected",
      };
    }
    if (parsed.dnsName === undefined) {
      return { available: true, running: true, error: "tailscale has no DNS name yet" };
    }

    const port = publicationPort();
    const decision = port === undefined ? { kind: "free" as const } : decideServe(yield* readServeMappings(), port);
    if (decision.kind === "published" && port !== undefined) {
      // The mapping is ours: remember which port, so a later unpublish finds it even if the
      // configured port has changed since — across a restart, too. A GET writing state is
      // deliberate here: the serve configuration is the truth, and this is how a crash or a lost
      // record re-adopts the mapping it names (rather than leaving the user to clear it by hand).
      remember(port);
      return {
        available: true,
        running: true,
        dnsName: parsed.dnsName,
        publishedUrl: publicUrlFor(parsed.dnsName),
      };
    }
    if (decision.kind === "mixed") {
      return {
        available: true,
        running: true,
        dnsName: parsed.dnsName,
        blocked: "mixed",
        error: `port 443 also serves ${describeForeign(decision.foreignPorts)}; Corvi will not remove a shared tree`,
      };
    }
    if (decision.kind === "conflict") {
      const target = decision.targetPort === undefined ? "something else" : String(decision.targetPort);
      return {
        available: true,
        running: true,
        dnsName: parsed.dnsName,
        blocked: "conflict",
        error: `port 443 already serves ${target}; remove that mapping before publishing`,
      };
    }
    return { available: true, running: true, dnsName: parsed.dnsName };
  });

/** Publish the external listener at https 443, unless 443 already serves something else or the
 * external listener is not listening to publish. Idempotent: an already-published port is left
 * as it is. */
export const publishTailscale = (): Effect.Effect<TailscaleStatusDto, BadRequestError> =>
  Effect.gen(function* () {
    const bind = runtimeRemoteAccessStatus();
    if (!bind.listening) {
      return yield* new BadRequestError({
        message: "remote access is not listening yet; enable it and check its port",
      });
    }
    // The port the listener is actually on, not the config value a save in flight may already
    // have moved past.
    const port = bind.port ?? runtimeConfig().remoteAccess.port;

    const status = yield* tailscaleStatus();
    if (!status.available) {
      return yield* new BadRequestError({ message: status.error ?? "tailscale is not installed" });
    }
    if (!status.running) {
      return yield* new BadRequestError({ message: status.error ?? "tailscale is not connected" });
    }
    if (status.publishedUrl !== undefined) {
      remember(port);
      return status;
    }
    if (status.error !== undefined) return yield* new BadRequestError({ message: status.error });

    const result = yield* runTailscale(["serve", "--bg", String(port)]);
    if (result.code !== 0) {
      return yield* new BadRequestError({
        message: firstLine(result.stderr) || "tailscale serve failed",
      });
    }
    remember(port);
    return yield* tailscaleStatus();
  });

/** Remove our external port's mapping. Never `tailscale serve reset`, and never `off` while 443
 * serves anything besides our own handler: `off` clears the whole tree. */
export const unpublishTailscale = (): Effect.Effect<TailscaleStatusDto, BadRequestError> =>
  Effect.gen(function* () {
    const port = publicationPort();
    const at443 = (yield* readServeMappings()).filter(
      (mapping) => mapping.externalPort === SERVE_EXTERNAL_PORT,
    );
    const ours = at443.filter((mapping) => mapping.targetPort === port);
    const foreign = at443.filter((mapping) => mapping.targetPort !== port);

    if (ours.length === 0) {
      remember(undefined);
      return yield* tailscaleStatus();
    }
    if (foreign.length > 0) {
      return yield* new BadRequestError({
        message: `port 443 also serves ${describeForeign(foreign.map((mapping) => mapping.targetPort))}; remove Corvi's handler by hand before stopping`,
      });
    }

    const result = yield* runTailscale(["serve", "--https=443", "off"]);
    if (result.code !== 0) {
      return yield* new BadRequestError({
        message: firstLine(result.stderr) || "tailscale serve off failed",
      });
    }
    remember(undefined);
    return yield* tailscaleStatus();
  });

/** Keep the publication in step with the listener: a moved listener is republished on its new
 * port, a stopped one has its mapping removed. A no-op unless Corvi published something. Failures
 * are not fatal — the status read reports why — and never run a command that could displace a
 * mapping that is not ours. */
export const reconcileTailscale = (bind: {
  readonly listening: boolean;
  readonly port?: number;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const published = runtimeTailscalePublishedPort();
    if (published === undefined) return;
    if (bind.listening && bind.port === published) return;

    const stopped = yield* Effect.either(unpublishTailscale());
    if (Either.isLeft(stopped)) return;
    if (!bind.listening) return;
    yield* Effect.either(publishTailscale());
  });
