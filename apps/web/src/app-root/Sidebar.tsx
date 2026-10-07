import { type JSX, useEffect, useRef, useState } from "react";
import { ChangeId } from "@corvi/contracts/changes";
import type { Change } from "./api.ts";
import { stateClass } from "./stateClass.ts";
import {
  ActionsIcon,
  ChangesIcon,
  CiIcon,
  GearIcon,
  LeftoversIcon,
  PageIcon,
  PlusIcon,
  PowerIcon,
  SubagentIcon,
  UpdateIcon,
  WindowIcon,
} from "./icons.tsx";
import { byWorkOrder, IDEATION, isFinished, isIdeation, type ChangeSummary } from "../domain/change.ts";
import type { TerminalWindow } from "../domain/terminal.ts";
import { changeKey, useAvailability, useSourceOwner } from "./sources.ts";
import { availabilitySuffix, statusOf } from "./sourceOwner.ts";
import { draftLabel, type Draft } from "../wizard/draft.ts";
import { ALL, type Workspace } from "../workspace/client/workspaces.ts";
import { ActionsMenu } from "./ActionsMenu.tsx";
import type { AppUpdateStatus } from "../app-update/model.ts";
import { PowerDialog } from "../power/PowerDialog.tsx";
import { usePower } from "../power/state.ts";
import { initials, pageGlyph, paletteIndex } from "./rail.ts";

/** Which page of a change is open. The dashboard is what selecting a change opens; terminals is
 * the core's own, and any other id is a tab an extension contributed — the id is the last
 * segment of the change's URL. */
export type Page = "dashboard" | "terminals" | (string & {});

const CI_WORDS: Record<string, string> = {
  ok: "builds green",
  pending: "building",
  error: "build failing",
  warn: "builds need attention",
  none: "no builds",
};

/** The grace before a revealed change group closes: long enough to cross between its rows (which
 * differ in width once revealed), short enough not to feel sticky. */
const REVEAL_GRACE_MS = 160;

/** What the change's builds are doing. The change's own state is the badge on its avatar, so this
 * only says how its tools are doing — and only once its group is revealed. */
function Icons({ summary }: { summary?: ChangeSummary }): JSX.Element {
  const ci = summary?.state ?? "none";
  return (
    <span className="icons">
      <span className={summary ? `state-${ci}` : "state-idle"}>
        <CiIcon title={CI_WORDS[ci] ?? "builds"} />
      </span>
    </span>
  );
}

/**
 * The one navigation element: a thin rail of destinations, changes and terminals.
 *
 * The rail always rests at `--rail-width`. Hovering or focusing a change group — its avatar or
 * one of its terminals — reveals that group's names beside their glyphs, over the page, without
 * moving any other row. Only one group is revealed at a time.
 */
export function Sidebar({
  open,
  changes,
  workspaces,
  chosen,
  onChooseWorkspace,
  current,
  page,
  windows,
  onHome,
  onNew,
  newBlocked,
  draft,
  wizard,
  pages,
  onPage,
  extPage,
  onActions,
  actions,
  onSubagents,
  subagents,
  onSettings,
  settings,
  update,
  onUpdate,
  onOpenChange,
  onSelectWindow,
}: {
  /** Every change of the chosen workspace; the list below "Changes" shows the ones still going. */
  changes: Change[] | undefined;
  /** The contexts there are to switch between, and which one is on. */
  workspaces: Workspace[];
  chosen: string;
  onChooseWorkspace: (id: string) => void;
  current?: Change;
  page: Page;
  /** Every change's terminal windows, keyed by change: they sit under their own change. */
  windows: Record<string, TerminalWindow[]>;
  onHome: () => void;
  /** Start an idea: the plus in the destinations opens the draft already there. */
  onNew: () => void;
  /** The selected workspace is an unreachable remote: starting an idea there is disabled. */
  newBlocked?: boolean;
  /** The idea being written, if there is one: the dashed avatar above the ideas. */
  draft?: Draft;
  /** Whether the wizard is the page open: the draft avatar is current then, and the overview is
   * not. */
  wizard: boolean;
  /** The pages the server says this context has: one entry per page. The icon is the page's own
   * glyph name, when it declared one. */
  pages: { id: string; title: string; icon?: string }[];
  onPage: (id: string) => void;
  /** The id of the extension page that is open, when one is: it belongs to no change. */
  extPage?: string;
  /** The core's own Actions page, offered with the other destinations. */
  onActions: () => void;
  /** Whether the Actions page is the one open. */
  actions: boolean;
  /** The core's own Subagents page: the profile files behind the subagent menu. */
  onSubagents: () => void;
  /** Whether the Subagents page is the one open. */
  subagents: boolean;
  onSettings: () => void;
  /** Whether the settings page is the one open. */
  settings: boolean;
  /** What the app knows about updating itself: the update icon answers it — yellow when a new
   * version is waiting, gray when there is none, hidden when this run cannot update at all. */
  update: AppUpdateStatus | null;
  onUpdate: () => void;
  onOpenChange: (change: Change) => void;
  onSelectWindow: (change: Change, index: number) => void;
  /** Whether the narrow window's drawer is open: on a wide window the rail is always there and
   * this only marks the rail as deliberately opened (so it shows its names). */
  open: boolean;
}): JSX.Element {
  // What you can get on with first, then what is with somebody else, then what is stuck — and
  // the newest of each at the top. The overview list is sorted the same way.
  const live = (changes ?? []).filter((c) => !isFinished(c)).sort(byWorkOrder);
  // Ideas are a different kind of thing — a question, not a job — so they get their own block
  // above the work, with a divider between the two.
  const ideas = live.filter(isIdeation);
  const active = live.filter((c) => !isIdeation(c));

  // Which change group reveals its names. Hovering or keyboard focus within a group opens it;
  // leaving it closes after a short grace, so crossing between its rows (which differ in width
  // once revealed) does not flicker. Keyboard focus wins over the pointer, so Tab still shows the
  // same names; a mouse click's focus does not pin it, because only a :focus-visible focus opens.
  const [pointerGroup, setPointerGroup] = useState<string | null>(null);
  const [keyboardGroup, setKeyboardGroup] = useState<string | null>(null);
  const closeTimer = useRef<number | null>(null);
  const clearClose = (): void => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const openGroup = (key: string): void => {
    clearClose();
    setPointerGroup(key);
  };
  const closeGroup = (key: string): void => {
    clearClose();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setPointerGroup((current) => (current === key ? null : current));
    }, REVEAL_GRACE_MS);
  };
  useEffect(
    () => () => {
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    },
    [],
  );
  // One group at a time: the keyboard's group, or failing that the pointer's.
  const revealed = keyboardGroup ?? pointerGroup;

  const [summaries, setSummaries] = useState<Record<string, ChangeSummary>>({});
  // The power control is self-contained here: the column already has the workspaces, and it only
  // needs the page's own event connection to keep the machines fresh.
  const power = usePower(workspaces);
  const owner = useSourceOwner();
  const availability = useAvailability();
  // A local workspace's source is the local server (""); a remote one is its own id. The suffix
  // is reachability only: an unavailable workspace stays in the list and selectable.
  const statusOfWorkspace = (workspace: Workspace): ReturnType<typeof statusOf> =>
    statusOf(availability, workspace.remote !== undefined ? workspace.id : "");
  const chosenWorkspace = workspaces.find((w) => w.id === chosen);

  // The same numbers the overview cards show, for the CI icon. One request per change, from the
  // cache on the server, and slowly: this is a glance, not a monitor.
  // The generation is part of the key: a same-id retarget must not show the old target's
  // summary, and a late old answer lands under a key nothing reads.
  const generationOf = (source: string): string => availability.entries[source]?.generation ?? "";
  const ids = active
    .map((c) => `${changeKey(c.source ?? "", c.id)}@${generationOf(c.source ?? "")}`)
    .join("|");
  // The interval reads the world as it is now, not the render that installed it: a source that
  // goes down (or comes back) between ticks must stop being asked — and start being asked again —
  // without waiting the interval out.
  const latest = useRef({ availability, active, generationOf });
  latest.current = { availability, active, generationOf };
  // Reachability is part of the effect's identity: a loss and a recovery of the same generation
  // both re-run it immediately — skip while blocked, refresh on recovery.
  const statusKey = active
    .map((c) => `${c.source ?? ""}:${statusOf(availability, c.source ?? "")._tag}`)
    .join("|");
  useEffect(() => {
    let alive = true;
    const load = (): void =>
      latest.current.active.forEach((c) => {
        const source = c.source ?? "";
        // A checking/unavailable remote is not asked; the banner says why, and the next run after
        // recovery (or a retarget) fetches.
        if (statusOf(latest.current.availability, source)._tag !== "available") return;
        const key = `${changeKey(source, c.id)}@${latest.current.generationOf(source)}`;
        owner
          .clientFor(source)
          .changes.summary(ChangeId.make(c.id))
          .then((s) => alive && setSummaries((all) => ({ ...all, [key]: s })))
          .catch(() => {});
      });
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // `ids` encodes source + change + generation; `statusKey` the reachability, so both a retarget
    // and a same-generation outage/recovery re-run the effect.
  }, [ids, statusKey, owner]);

  const workspaceName = workspaces.find((w) => w.id === chosen)?.name ?? "All work";
  // "Changes" is home: current only when no change or other page is on.
  const home = !(current || extPage || actions || settings || subagents || wizard);

  /** A destination: the glyph and, always, its small label. Destinations never reveal — they are
   * the one part of the rail whose name is visible at rest. */
  const destination = (
    key: string,
    label: string,
    icon: JSX.Element,
    onClick: () => void,
    current: boolean,
    disabled = false,
  ): JSX.Element => (
    <button
      key={key}
      className={`entry dest${current ? " current" : ""}`}
      title={disabled ? "this workspace is unavailable" : label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="dest-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="dest-label">{label}</span>
    </button>
  );

  /** One change in the rail, with its terminals under it. The avatar carries the change's
   * identity; the name and the CI state appear when the group is revealed. Hovering or focusing
   * any row of the group reveals the whole group, and only it. */
  const entry = (c: Change): JSX.Element => {
    const key = changeKey(c.source ?? "", c.id);
    const mine = windows[key] ?? [];
    const selected = key === changeKey(current?.source ?? "", current?.id ?? "");
    // One thing is highlighted at a time. On a terminal that thing is the window, not the
    // change it belongs to: two highlights would be two answers to "where am I".
    const here = selected && page !== "terminals";
    const summary = summaries[`${key}@${generationOf(c.source ?? "")}`];
    const ci = summary?.state ?? "none";
    const name = c.title ?? c.branch;
    return (
      <div
        key={key}
        className={`change-entry${revealed === key ? " revealed" : ""}`}
        onPointerEnter={() => openGroup(key)}
        onPointerLeave={() => closeGroup(key)}
        onFocus={(e) => {
          // Only a keyboard focus reveals; a click's focus does not hold it open.
          if (e.target instanceof Element && e.target.matches(":focus-visible")) {
            clearClose();
            setKeyboardGroup(key);
          }
        }}
        onBlur={(e) => {
          const next = e.relatedTarget;
          if (next instanceof Node && e.currentTarget.contains(next)) return;
          setKeyboardGroup((current) => (current === key ? null : current));
        }}
      >
        <button
          className={`entry sub change ${stateClass(c.state)}${here ? " current" : ""}`}
          title={c.branch}
          aria-label={`${name} — ${CI_WORDS[ci] ?? "builds"}`}
          onClick={() => onOpenChange(c)}
        >
          <span className={`avatar hue-${paletteIndex(c.id) + 1}`} aria-hidden="true">
            {initials(c.title, c.id)}
            <span className={`state-badge ${stateClass(c.state)}`} />
          </span>
          {/* The name and CI state live in one reveal wrapper: fixed while shown, so the rail's
              own scroll does not clip them (the reveal block in styles.css). */}
          <span className="reveal">
            <span className="subject">{name}</span>
            <Icons summary={summary} />
          </span>
        </button>

        {/* The change's terminals, under the change they belong to. The server says what
            each window is called and which glyph it draws; the page renders that. */}
        {mine.map((w) => (
          <button
            key={w.index}
            data-window-id={w.id}
            className={
              selected && page === "terminals" && w.active
                ? "entry sub window current"
                : "entry sub window"
            }
            title={`ctrl-b ${w.index} — ${w.detail}`}
            aria-label={`${w.label} — ctrl-b ${w.index}${w.activity ? " — new output" : ""}`}
            // Focus is what a mousedown moves, and a terminal you cannot type in after
            // clicking is useless. Preventing the default keeps it in the terminal.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onSelectWindow(c, w.index)}
          >
            <span className={`glyph ${w.state === "ok" ? "state-ok" : "state-idle"}`}>
              <WindowIcon icon={w.icon} title={w.label} />
            </span>
            <span className="reveal">
              <span className="label">{w.label}</span>
            </span>
            {/* Not for the window you are looking at: you see its output already. */}
            {w.activity && !(selected && page === "terminals" && w.active) && (
              <span className="bell" title="new output" />
            )}
          </button>
        ))}
      </div>
    );
  };

  return (
    <nav className={open ? "sidebar open" : "sidebar"}>
      <div
        className="rail"
        onScroll={() => {
          // The revealed names are fixed to the viewport; a rail scroll would leave them behind,
          // so scrolling closes the reveal rather than showing it detached.
          if (revealed !== null) {
            setPointerGroup(null);
            setKeyboardGroup(null);
          }
        }}
      >
        {/* The window's own top row: on macOS the traffic lights sit here, and in the app window
            it is what you drag the window by (apps/web/src/domain/chrome.ts). The switcher shows
            the workspace's name in small type, and the menu it opens is the same list it always
            was. */}
        <div className="band">
          <ActionsMenu
            className="workspace"
            label={`${workspaceName}${chosenWorkspace === undefined ? "" : availabilitySuffix(statusOfWorkspace(chosenWorkspace))}`}
            ariaLabel={`Workspace: ${workspaceName}`}
            title={workspaceName}
            actions={[
              ...workspaces.map((w) => ({
                label: `${w.name}${availabilitySuffix(statusOfWorkspace(w))}`,
                disabled: w.id === chosen,
                onSelect: () => onChooseWorkspace(w.id),
              })),
              { label: "All work", separated: true, disabled: chosen === ALL, onSelect: () => onChooseWorkspace(ALL) },
            ]}
          />
        </div>

        {/* Where you can go: the overview, the new idea, the pages. Each is an icon and its name,
            always visible — the destinations do not reveal. */}
        <div className="destinations">
          {destination("changes", "Changes", <ChangesIcon title="Changes" />, onHome, home)}
          {destination("new", "New", <PlusIcon title="New" />, onNew, false, newBlocked === true)}
          {destination("actions", "Actions", <ActionsIcon title="Actions" />, onActions, actions)}
          {destination("subagents", "Subagents", <SubagentIcon title="Subagents" />, onSubagents, subagents)}
          {pages.map((p) =>
            destination(
              p.id,
              p.title,
              pageGlyph(p.icon) === "leftovers" ? (
                <LeftoversIcon title={p.title} />
              ) : (
                <PageIcon title={p.title} />
              ),
              () => onPage(p.id),
              extPage === p.id,
            ),
          )}
        </div>

        {/* Ideas first, then a divider, then the work. The ideation-coloured avatars carry the
            distinction the headings used to. */}
        <div className="list">
          {draft && (
            <div
              className={`change-entry${revealed === "draft" ? " revealed" : ""}`}
              onPointerEnter={() => openGroup("draft")}
              onPointerLeave={() => closeGroup("draft")}
              onFocus={(e) => {
                if (e.target instanceof Element && e.target.matches(":focus-visible")) {
                  clearClose();
                  setKeyboardGroup("draft");
                }
              }}
              onBlur={(e) => {
                const next = e.relatedTarget;
                if (next instanceof Node && e.currentTarget.contains(next)) return;
                setKeyboardGroup((current) => (current === "draft" ? null : current));
              }}
            >
              <button
                className={`entry sub change ${stateClass(IDEATION)}${wizard ? " current" : ""}`}
                title="not created yet — open it to finish or discard it"
                aria-label={`Draft idea: ${draftLabel(draft)}`}
                onClick={onNew}
              >
                <span className="avatar draft" aria-hidden="true">
                  {initials(draftLabel(draft), "")}
                </span>
                <span className="subject">{draftLabel(draft)}</span>
              </button>
            </div>
          )}
          {ideas.map(entry)}
          {(draft || ideas.length > 0) && active.length > 0 && (
            <div className="group-divider" role="separator" />
          )}
          {active.map(entry)}
          {changes && live.length === 0 && <p className="hint">nothing in progress</p>}
        </div>

        {/* At the bottom of the rail, not below the list: it is where you go once in a while, and
            it should be in the same place whether you have two changes or nine. Settings is the
            gear; the power control sits beside it, and the update icon to its right. */}
        <div className="bottom-row">
          <button
            className={`icon-entry${settings ? " current" : ""}`}
            title="Settings"
            aria-label="Settings"
            onClick={onSettings}
          >
            <GearIcon title="Settings" />
          </button>
          <button
            className={`icon-entry${power.open ? " current" : ""}`}
            title="Power down when done"
            aria-label="Power"
            onClick={power.openDialog}
          >
            <PowerIcon title="Power" />
          </button>
          {update?.eligible && (
            <button
              className={`icon-entry update${update.behind > 0 ? " available" : ""}`}
              title={update.behind > 0 ? "New version available" : "No updates"}
              aria-label="Update"
              onClick={onUpdate}
            >
              <UpdateIcon title="Update" />
            </button>
          )}
        </div>
      </div>

      {power.open && <PowerDialog view={power} onClose={power.closeDialog} />}
    </nav>
  );
}
