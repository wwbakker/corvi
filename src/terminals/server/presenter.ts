import { basename } from "node:path";
import type { TerminalWindow } from "../../domain/terminal.ts";
import type { TmuxWindow, WindowPresentation } from "../../extension-host/api.ts";
import { windowPresenters } from "../../extension-host/registry.ts";

/**
 * The presentation half of the terminal: raw tmux facts in, the shape the page draws out.
 *
 * Everything here is pure, and it reads the window presenters from the registry leaf directly
 * rather than through the host (`src/extension-host/registry.ts`), so this module imports neither the
 * host nor anything that runs the host: the pipeline that lists windows and the pipeline that
 * loads extensions meet at the registry, not at each other. Presenters are global — they run no
 * effects and take no capabilities, and a window's name cannot depend on whose client is looking
 * (docs/guides/style.md, rule 7). See `windowPresenters` in the registry for why the aggregation
 * lives there.
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
  for (const presenter of windowPresenters()) {
    for (const option of presenter.paneOptions ?? []) seen.add(option);
  }
  return [...seen];
};

/** The tmux FORMAT for a set of pane options: the fixed fields, then one field per option.
 * Built per call, because the options depend on which extensions are loaded. `list-windows`
 * still answers in one call per session. */
export const formatFor = (options: readonly string[]): string => {
  const fixed =
    "#{window_index}\t#{window_name}\t#{pane_current_command}\t#{window_active}\t#{window_activity_flag}\t#{pane_current_path}\t#{automatic-rename}\t#{window_id}";
  return options.length ? `${fixed}\t${options.map((o) => `#{${o}}`).join("\t")}` : fixed;
};

export const parseWindow = (line: string, options: readonly string[]): TmuxWindow => {
  const [index, name, command, active, activity, path, auto, id, ...extra] = line.split("\t");
  const opts: Record<string, string> = {};
  extra.forEach((value, i) => {
    const option = options[i];
    if (option) opts[option] = value ?? "";
  });
  return {
    index: Number(index),
    id: id ?? "",
    name: name ?? "",
    command: command ?? "",
    active: active === "1",
    activity: activity === "1",
    directory: basename(path ?? ""),
    named: auto === "0",
    options: opts,
  };
};

/** What the merge has gathered from the presenters before the core's defaults compose it:
 * fields the presenters left undefined fall through to later presenters, then to here. */
const merged = (raw: TmuxWindow): WindowPresentation =>
  windowPresenters().reduce<WindowPresentation>((acc, presenter) => {
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
 *   believed over its process name (pi at its prompt is `node`).
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
