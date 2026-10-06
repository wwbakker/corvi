/**
 * Powering the machine off: the platform command behind a service, the way every other CLI the
 * core runs is injected.
 *
 * The service exists so a test can provide a fake and never reach a real `systemctl poweroff`;
 * the live layer runs the command through `shOrThrow` (whose `Shell` seam a test can script
 * instead) so a non-zero exit fails rather than looking like a shutdown. Server-local on
 * purpose — an integration has no business powering the machine down.
 */
import { Context, Effect, Layer } from "effect";

import { CliError } from "@corvi/contracts/errors";

import { platformName } from "./os.ts";
import { shOrThrow } from "./shell.ts";

/** The one command that powers this platform off. macOS uses System Events; anything that is
 * neither Linux nor macOS is treated as macOS, the fallback the UI already uses. */
export const powerCommand = (platform: "linux" | "mac" | "other"): readonly string[] =>
  platform === "linux"
    ? ["systemctl", "poweroff"]
    : ["osascript", "-e", 'tell application "System Events" to shut down'];

export interface PowerShape {
  /** Power the machine off. Fails with the command's stderr when it exits non-zero — a denied
   * `systemctl`/`osascript` must not read as success and leave the machine on — and with the
   * timeout error while it is still running. */
  powerOff(): Effect.Effect<void, CliError>;
}

export class Power extends Context.Service<Power, PowerShape>()("corvi/Power") {}

export const PowerLive = Layer.succeed(Power, {
  powerOff: () => Effect.asVoid(shOrThrow(powerCommand(platformName))),
});
