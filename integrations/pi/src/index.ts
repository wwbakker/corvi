/**
 * The one pi extension Corvi installs: the reporter (`agent-state.ts`), the conversational relay
 * (`turns.ts`), and the CLI guide (`cli-guide.ts`) composed into the one entry an install
 * directory needs (`index.ts`).
 *
 * `bun run extension:install:pi` links this directory's `*.ts` files into
 * `~/.pi/agent/extensions/corvi/` and removes the older installs' top-level symlinks.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import agentState from "./agent-state.ts";
import cliGuide from "./cli-guide.ts";
import turns from "./turns.ts";

export default function (pi: ExtensionAPI): void {
  agentState(pi);
  cliGuide(pi);
  turns(pi);
}
