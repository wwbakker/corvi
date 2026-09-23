/**
 * The app's pty half of the terminal: node-pty (a native addon, so node-only), the environment
 * a pane starts with, and whether this process can run a terminal at all.
 *
 * The attachment lifecycle — one pty per socket, the buffer before the upgrade, the set this
 * process owns and closes on shutdown — comes from `@corvi/terminals/session`; this file
 * supplies the two things that are the app's: how a pty starts, and what the user should be told
 * when it cannot.
 */
import { spawn } from "node-pty";

import {
  makeAttachments,
  type Attachments,
  type PtySpawner,
} from "@corvi/terminals/session";
import { childEnv } from "../../capabilities/env.ts";
import { env } from "@corvi/configuration/node";
import { commandAvailable } from "../../capabilities/os.ts";
import { attachCommand } from "./tmux.ts";

export type { TerminalSession, TerminalSocket } from "@corvi/terminals/session";

/** Bun loads the native addon but never delivers a byte of its output: its N-API shim does not
 * feed the pty's poll handle, so onData stays silent while spawn and exit work. Refuse rather
 * than open a socket that looks alive and is dead — `bun run dev` runs the server on Node, where
 * the terminal works (docs/manual/terminals.md). */
const onBun = (process.versions as Record<string, string | undefined>).bun !== undefined;

const missingTmux = (): Error => {
  const where = process.platform === "darwin" ? "macOS: brew install tmux" : "Arch: sudo pacman -S tmux";
  return new Error(`tmux is not installed — the terminal cannot start (${where})`);
};

/** Why a terminal cannot start here, if it cannot. The route that hands out the socket URL asks
 * this first, so the pane shows the reason instead of a socket that never connects. */
export const terminalUnavailable = (): string | undefined => {
  if (onBun) {
    return "the terminal needs Node — Bun never delivers pty output; run the server with Node (`bun run dev` does)";
  }
  if (!commandAvailable("tmux")) return missingTmux().message;
  return undefined;
};

/** node-pty is the app's own half: a native addon, and an environment that rests on the app's
 * scrubbing policy (`apps/server/src/capabilities/env.ts`) — the launcher's variables are dropped, and the
 * change's context is added on purpose, so a script or an agent in the pane knows where it is. */
const spawnPty: PtySpawner = ({ command, cwd, cols, rows, id, dir }) => {
  const [file, ...args] = command;
  return spawn(file!, [...args], {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: childEnv(process.env, { [env("CHANGE_ID")]: id, [env("CHANGE_DIR")]: dir }),
  });
};

const attachments: Attachments = makeAttachments(attachCommand, spawnPty);

/** Start the change's tmux session under a pty, at the page's size. Throws when the runtime is
 * Bun or tmux is missing: the route turns that into the pane's error banner. */
export const openSession = (
  id: string,
  dir: string,
  size: { cols: number; rows: number },
): ReturnType<Attachments["open"]> => {
  const unavailable = terminalUnavailable();
  if (unavailable) throw new Error(unavailable);
  return attachments.open(id, dir, size);
};

/** Close every attached pty when the server shuts down. */
export const closeAttachments = attachments.closeAll;

/** The WebSocket handlers `server.ts` installs: one pty per connection, wired to its socket. */
export const terminalSockets = attachments.sockets;
