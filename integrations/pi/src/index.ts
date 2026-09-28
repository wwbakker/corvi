/**
 * The one pi extension Corvi installs: the reporter (`agent-state.ts`) and the conversational
 * relay (`turns.ts`) composed into the one entry an install directory needs (`index.ts`).
 *
 * `bun run extension:install:pi` links this directory's `*.ts` files into
 * `~/.pi/agent/extensions/corvi/` and removes the older installs' top-level symlinks.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import agentState from "./agent-state.ts";
import turns from "./turns.ts";

export default function (pi: ExtensionAPI): void {
  agentState(pi);
  turns(pi);
}
