import type { TerminalPresenter } from "./api.ts";

/**
 * Where the host's window presenters live for the code that must read them without importing
 * the host (src/terminal.ts does, and the host's module graph reaches back into it through
 * the events — a module cycle).
 *
 * This module stays a leaf: it imports nothing that runs, and the host (src/extensions/index.ts)
 * installs the source — a live view over the loaded extensions, so a presenter registered by a
 * later extension is seen. Before the host installs it there are no presenters, which is only
 * reachable from a stray import order, never from the server, which loads extensions first.
 */
type PresenterSource = () => TerminalPresenter[];

let source: PresenterSource = () => [];

export const setPresenterSource = (next: PresenterSource): void => {
  source = next;
};

export const windowPresenters = (): TerminalPresenter[] => source();
