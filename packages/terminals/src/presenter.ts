/** What a window that ran one Corvi command says about itself, from the pane options the
 * command wrapper writes (`@corvi/terminals/model`).
 *
 * Pure — raw tmux facts in, presentation out — like the agents package's presenter. A run with
 * nothing announced is not this presenter's window; it falls through to the core's defaults. */
import type { TerminalPresenter } from "@corvi/contracts/terminal";
import {
  COMMAND_ACTION_OPTION,
  COMMAND_EXIT_OPTION,
  COMMAND_NOTIFY_OPTION,
} from "./model.ts";

export const commandWindowPresenter: TerminalPresenter = {
  paneOptions: [COMMAND_ACTION_OPTION, COMMAND_EXIT_OPTION, COMMAND_NOTIFY_OPTION],
  present: (window) => {
    const label = window.options[COMMAND_ACTION_OPTION]?.trim();
    if (!label) return undefined;
    const rawExit = window.options[COMMAND_EXIT_OPTION]?.trim();
    // An exit code is a small number; anything else (absent, half-written) is "still running".
    const exit = rawExit !== undefined && rawExit !== "" && /^\d+$/.test(rawExit) ? Number(rawExit) : undefined;
    const wants = window.options[COMMAND_NOTIFY_OPTION] === "1";
    return {
      label,
      running: exit === undefined ? label : "finished",
      state: exit === undefined ? "ok" : "idle",
      busy: exit === undefined,
      // A notified run wants you once — when it ends. The core only sees the edge into it.
      attention: wants && exit !== undefined,
      note: exit === undefined ? undefined : `finished with exit code ${exit}`,
    };
  },
};
