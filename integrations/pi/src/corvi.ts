/**
 * The one pi extension Corvi installs: the reporter (`agent-state.ts`) and the conversational
 * relay (`turns.ts`) composed into a single entry, so the installer keeps its one-symlink-per-agent
 * shape.
 *
 * `bun run extension:install:pi` symlinks this file into `~/.pi/agent/extensions/corvi.ts` and
 * removes the legacy `agent-state.ts` symlink.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import agentState from "./agent-state.ts";
import turns from "./turns.ts";

export default function (pi: ExtensionAPI): void {
  agentState(pi);
  turns(pi);
}
