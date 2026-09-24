import { Effect } from "effect";
import type { TerminalWindow } from "../../domain/terminal.ts";
import type { TmuxWindow, WindowPresentation } from "../../integrations/types.ts";
import type { CommandFailure } from "@corvi/terminals/tmux";
import { agentsWindowPresenter } from "@corvi/agents/presenter";
import { commandWindowPresenter } from "@corvi/terminals/presenter";
import { rawAllWindows, rawWindows } from "./tmux.ts";

/**
 * The presentation half of the terminal: raw tmux facts in, the shape the page draws out.
 *
 * Everything here is pure, and the window presenter is the agents package's own, imported
 * directly rather than read through a registry: the pipeline that lists windows stays a leaf. Presenters are global — they run no effects and take no capabilities, and a
 * window's name cannot depend on whose client is looking at it. The core's defaults answer
 * where the presenter leaves a field alone.
 */

/** Shells: a window sitting at a prompt is idle, whatever the shell is called. */
const SHELLS = ["zsh", "bash", "sh", "fish", "-zsh", "-bash", "tmux"];

/** One tmux window as the page sees it, with the busy fact the overview counts — presentational
 * to the page, but the server's own accounting travels with it too. */
export type PresentedWindow = TerminalWindow & { busy: boolean };

/** The pane options any presenter declared, once each, in load order — the FORMAT asks tmux
 * for exactly these, so the raw window carries what presenters know how to read. */
export const paneOptions = (): string[] => {
  const seen = new Set<string>();
  for (const presenter of [agentsWindowPresenter, commandWindowPresenter]) {
    for (const option of presenter.paneOptions ?? []) seen.add(option);
  }
  return [...seen];
};

/** The tmux FORMAT for a set of pane options lives with the tmux calls
 * (`@corvi/terminals/tmux`): the options come from the presenters, the format is tmux's own
 * vocabulary. */

/** What the merge has gathered from the presenters before the core's defaults compose it:
 * fields the presenters left undefined fall through to later presenters, then to here. */
const merged = (raw: TmuxWindow): WindowPresentation =>
  [agentsWindowPresenter, commandWindowPresenter].reduce<WindowPresentation>((acc, presenter) => {
    const answer = presenter.present(raw);
    if (!answer) return acc; // a presenter with nothing to say contributes nothing
    return {
      label: acc.label ?? answer.label,
      running: acc.running ?? answer.running,
      detail: acc.detail ?? answer.detail,
      icon: acc.icon ?? answer.icon,
      state: acc.state ?? answer.state,
      busy: acc.busy ?? answer.busy,
      attention: acc.attention ?? answer.attention,
      note: acc.note ?? answer.note,
    };
  }, {});

/**
 * Present one raw window: ask the presenters what it is, and compose the core's defaults
 * around whatever they answered.
 *
 * The first presenter that answers a field wins (registration order within an extension, load
 * order across them); what nobody answered, the core says:
 *
 * - the base name is the name you gave the window, or where it is — tmux's own default names
 *   a window after whatever runs in it, which says less than the directory does;
 * - the composed name appends what is running, unless it is a plain shell or already the
 *   whole label — so a prompt reads as a place, not a program;
 * - busy is "not a shell" — the heuristic the overview's terminals fact uses, with an agent
 *   believed over its process name (an agent at its prompt is `node`).
 *
 * Pure, and exported for the tests: the page renders exactly what this says.
 */
export const presentWindow = (raw: TmuxWindow): PresentedWindow => {
  const said = merged(raw);
  const base = raw.named ? raw.name : raw.directory || raw.name;
  const what = said.running ?? raw.command;
  const label = said.label ?? (what && !SHELLS.includes(what) && what !== base ? `${base} - (${what})` : base);
  return {
    index: raw.index,
    id: raw.id,
    label,
    detail: said.detail ?? `${raw.name} (${raw.command}) in ${raw.directory}`,
    icon: said.icon ?? "terminal",
    state: said.state ?? "idle",
    active: raw.active,
    activity: raw.activity,
    attention: said.attention ?? false,
    note: said.note,
    busy: said.busy ?? (Boolean(raw.command) && !SHELLS.includes(raw.command)),
  };
};

/** The change's windows, presented: the raw facts come from `@corvi/terminals/tmux`, the
 * presentation is this module's. A timed-out tmux fails; callers that want an empty strip on
 * any failure (the routes) catch it themselves. */
export const listWindows = (id: string): Effect.Effect<PresentedWindow[], CommandFailure> =>
  Effect.map(rawWindows(id, paneOptions()), (windows) => windows.map(presentWindow));

/** Every change's windows, presented, in the one call the navigation column asks for. */
export const allWindows = (): Effect.Effect<Record<string, PresentedWindow[]>, CommandFailure> =>
  Effect.map(rawAllWindows(paneOptions()), (byChange) =>
    Object.fromEntries(Object.entries(byChange).map(([id, windows]) => [id, windows.map(presentWindow)])),
  );
