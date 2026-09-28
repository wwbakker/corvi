/**
 * The one opencode plugin Corvi installs: the reporter (`agent-state.ts`) and the conversational
 * relay (`turns.ts`) composed into the one entry the install points at (`index.ts`).
 *
 * Both halves subscribe to opencode's event stream, so composition calls each hook in turn rather
 * than replacing one with the other.
 */
import type { Hooks, PluginInput, PluginModule } from "@opencode-ai/plugin";

import agentState from "./agent-state.ts";
import turns from "./turns.ts";

const server = async (input: PluginInput): Promise<Hooks> => {
  const state = await agentState.server?.(input);
  const relay = await turns.server?.(input);
  return {
    event: async (args): Promise<void> => {
      await state?.event?.(args);
      await relay?.event?.(args);
    },
    dispose: async (): Promise<void> => {
      await relay?.dispose?.();
      await state?.dispose?.();
    },
  };
};

const combined: PluginModule = { id: "corvi", server };

export default combined;
