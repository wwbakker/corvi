/**
 * The one opencode plugin Corvi installs: the reporter (`agent-state.ts`), the conversational
 * relay (`turns.ts`), and the CLI guide (`cli-guide.ts`) composed into the one entry the install
 * points at (`index.ts`).
 *
 * The halves subscribe to opencode's hooks, so composition calls each in turn rather than
 * replacing one with another.
 */
import type { Hooks, PluginInput, PluginModule } from "@opencode-ai/plugin";

import agentState from "./agent-state.ts";
import { applyGuide } from "./cli-guide.ts";
import turns from "./turns.ts";

const server = async (input: PluginInput): Promise<Hooks> => {
  const state = await agentState.server?.(input);
  const relay = await turns.server?.(input);
  return {
    event: async (args): Promise<void> => {
      await state?.event?.(args);
      await relay?.event?.(args);
    },
    // The CLI guide joins the system prompt inside a Corvi pane and nowhere else
    // (`cli-guide.ts`).
    "experimental.chat.system.transform": async (_args, output): Promise<void> => {
      applyGuide(output.system, process.env);
    },
    dispose: async (): Promise<void> => {
      await relay?.dispose?.();
      await state?.dispose?.();
    },
  };
};

const combined: PluginModule = { id: "corvi", server };

export default combined;
