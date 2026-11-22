import { type CSSProperties, type JSX, useEffect, useRef, useState } from "react";
import { ChangeId } from "@corvi/contracts/changes";
import type { Change } from "./api.ts";
import { stateClass } from "./stateClass.ts";
import {
  BoltIcon,
  ChangesIcon,
  CiIcon,
  TerminalIcon,
  AgentIcon,
  GearIcon,
  HarnessIcon,
  LeftoversIcon,
  PageIcon,
  PlusIcon,
  PowerIcon,
  RefreshIcon,
  SubagentsIcon,
  UpdateIcon,
} from "./icons.tsx";
import { byWorkOrder, IDEATION, isFinished, isIdeation, type ChangeSummary } from "../domain/change.ts";
import { TRAFFIC_LIGHTS } from "../domain/chrome.ts";
import type { TerminalWindow } from "../domain/terminal.ts";
import { changeKey, useAvailability, useSourceOwner } from "./sources.ts";
import { availabilitySuffix, statusOf } from "./sourceOwner.ts";
import { draftLabel, type Draft } from "../wizard/draft.ts";
import { getPref, setPref } from "./prefs.ts";
import { ALL, type Workspace } from "../workspace/client/workspaces.ts";
import { ActionsMenu } from "./ActionsMenu.tsx";
import { RavenMark } from "./RavenMark.tsx";
import { hostOf } from "./host.ts";
import type { AppUpdateStatus } from "../app-update/model.ts";
import { coloursOf } from "../domain/theme.ts";
import { PowerDialog } from "../power/PowerDialog.tsx";
import { usePower } from "../power/state.ts";
import { useLeaderGroup, type LeaderTarget } from "./leader.tsx";

/** Which page of a change is open. The dashboard is what selecting a change opens; terminals is
 * the core's own, and any other id is a tab an extension contributed — the id is the last
 * segment of the change's URL. */
export type Page = "dashboard" | "terminals" | (string & {});

/** How wide the column is, remembered between visits: it is furniture, and moving it back every
 * morning would be its own small annoyance. A cookie rather than localStorage: the app serves
 * itself from a fresh port every launch, and localStorage is scoped to the port (see prefs.ts). */
const WIDTH_KEY = "corvi:sidebar-width";
const MIN = 160;
const MAX = 480;

/** The app window's first row starts with the traffic lights on macOS (apps/web/src/domain/chrome.ts), and
 * the switcher sits to their right: there the column cannot be narrower than the space they take
 * plus a switcher you can read. Truncating that control is not a narrower column, it is a broken
 * one. A browser has no lights and keeps the column's own minimum. */
const minWidth = (): number => (hostOf()?.platform === "darwin" ? MIN + TRAFFIC_LIGHTS.inset : MIN);

const storedWidth = (): number => {
  const stored = Number(getPref(WIDTH_KEY));
  return stored >= minWidth() && stored <= MAX ? stored : Math.max(220, minWidth());
};

const CI_WORDS: Record<string, string> = {
  ok: "builds green",
  pending: "building",
  error: "build failing",
  warn: "builds need attention",
  none: "no builds",
};

/** What the change's builds are doing. Its own state is the coloured bar down the left of the
 * row, and its terminals are the rows underneath, so neither needs an icon here. */
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
 * The one navigation element: a single column, from the top of the window down.
 *
 * The whole hierarchy is visible at once — the changes, the pages of the one you picked, and the
 * terminals inside it — so moving anywhere is one click from anywhere.
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
  onHarnesses,
  harnesses,
  onSubagents,
  subagents,
  onSettings,
  settings,
  update,
  onUpdate,
  hostReason,
  onRestartHost,
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
  /** Start an idea: it belongs beside the Ideas heading, where the entries it adds to begin —
   * and it is the same control the overview's header has. It opens the draft already there. */
  onNew: () => void;
  /** The selected workspace is an unreachable remote: starting an idea there is disabled. */
  newBlocked?: boolean;
  /** The idea being written, if there is one: the row under Ideas that leads back to it. */
  draft?: Draft;
  /** Whether the wizard is the page open: the draft row is current then, and the overview is
   * not. */
  wizard: boolean;
  /** The pages the server says this context has, under Changes: one entry per page. */
  pages: { id: string; title: string }[];
  onPage: (id: string) => void;
  /** The id of the extension page that is open, when one is: it belongs to no change. */
  extPage?: string;
  /** The core's own Actions page, offered above the extensions' pages. */
  onActions: () => void;
  /** Whether the Actions page is the one open. */
  actions: boolean;
  /** The core's own Harnesses page: the named Pi environments. */
  onHarnesses: () => void;
  /** Whether the Harnesses page is the one open. */
  harnesses: boolean;
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
  /** Why the running terminal host is not the one this server would have started. Present only
   * while it is not, so the icon exists only when there is a restart to offer. */
  hostReason?: string;
  onRestartHost: () => void;
  onOpenChange: (change: Change) => void;
  onSelectWindow: (change: Change, index: number) => void;
  /** Whether the narrow window's drawer is open: on a wide window the column is always there and
   * this changes nothing. */
  open: boolean;
}): JSX.Element {
  // What you can get on with first, then what is with somebody else, then what is stuck — and
  // the newest of each at the top. The overview list is sorted the same way.
  const live = (changes ?? []).filter((c) => !isFinished(c)).sort(byWorkOrder);
  // Ideas are a different kind of thing — a question, not a job — so they get their own block
  // above the work rather than sitting in the attention order among it.
  const ideas = live.filter(isIdeation);
  const active = live.filter((c) => !isIdeation(c));
  const [width, setWidth] = useState(storedWidth);
  const dragging = useRef(false);
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
  // Where the leader mode's keycaps sit (app-root/leader.tsx). The column's keys are positional:
  // the entries below register in the order they are read down the column, and a slot for a
  // heading that is not there is kept so the keys under it do not move. Every cap sits on the
  // column's lane, so the keys read as one rail however far each control reaches.
  const changesRef = useRef<HTMLButtonElement>(null);
  const newIdeaRef = useRef<HTMLButtonElement>(null);
  const ideasListRef = useRef<HTMLDivElement>(null);
  const changesListRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLSpanElement>(null);
  const workspaceRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<HTMLButtonElement>(null);
  const harnessesRef = useRef<HTMLButtonElement>(null);
  const subagentsRef = useRef<HTMLButtonElement>(null);
  const pageRefs = useRef(new Map<string, HTMLButtonElement>());
  const settingsRef = useRef<HTMLButtonElement>(null);
  const powerRef = useRef<HTMLButtonElement>(null);
  const restartRef = useRef<HTMLButtonElement>(null);
  const updateRef = useRef<HTMLButtonElement>(null);

  // The same numbers the overview cards show, for the icons. One request per change, from the
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

  // Dragging the edge: listened for on the window, so the pointer may leave the handle — which
  // it always does, since the thing being dragged moves out from under it.
  useEffect(() => {
    const move = (e: MouseEvent): void => {
      if (!dragging.current) return;
      e.preventDefault(); // otherwise the drag selects the text it passes over
      setWidth(Math.min(MAX, Math.max(minWidth(), e.clientX)));
    };
    const up = (): void => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.classList.remove("resizing");
      setPref(WIDTH_KEY, String(width));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [width]);

  /** One change in the column, with its terminals under it. Shared by the two blocks — ideas, and
   * the work they become — so a change looks the same in both. Adding a terminal is the window
   * tabs' job (apps/web/src/terminals/client/WindowTabs.tsx): the column is for going to the ones there
   * are, and it says nothing about windows a change has not got. */
  const entry = (c: Change, group: "ideas" | "changes"): JSX.Element => {
    const mine = windows[changeKey(c.source ?? "", c.id)] ?? [];
    const selected = changeKey(c.source ?? "", c.id) === changeKey(current?.source ?? "", current?.id ?? "");
    // One thing is highlighted at a time. On a terminal that thing is the window, not the
    // change it belongs to: two highlights would be two answers to "where am I".
    const here = selected && page !== "terminals";
    // The pair Spaces draws beside the name; the other themes never show it (`--change-mark`).
    const colours = coloursOf(c.id, isIdeation(c));
    return (
      <div key={changeKey(c.source ?? "", c.id)} className="change-entry">
        <button
          // The bar down the left is the change's own state, in the usual colours.
          data-leader-item={group}
          className={`entry sub change ${stateClass(c.state)}${here ? " current" : ""}`}
          title={c.branch}
          style={{ "--change-a": colours.from, "--change-b": colours.to } as CSSProperties}
          onClick={() => onOpenChange(c)}
        >
          {/* One line: the change's name, and how it is doing. The branch is the tooltip above,
              which is where the id has gone — it is what the branch starts with, and the row has
              room for one of the two. */}
          <span className="top">
            <span className="swatch" aria-hidden="true" />
            <span className="subject">{c.title ?? c.branch}</span>
            <Icons
              summary={summaries[`${changeKey(c.source ?? "", c.id)}@${generationOf(c.source ?? "")}`]}
            />
          </span>
        </button>

        {/* The change's terminals, under the change they belong to. The server says what
            each window is called and which glyph it draws; the page renders that. */}
        {mine.map((w) => (
          <button
            key={w.index}
            data-window-id={w.id}
            className={
              selected && page === "terminals" && w.active ? "entry sub window current" : "entry sub window"
            }
            title={w.detail}
            // Focus is what a mousedown moves, and a terminal you cannot type in after
            // clicking is useless. Preventing the default keeps it in the terminal.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onSelectWindow(c, w.index)}
          >
            <span className={w.state === "ok" ? "state-ok" : "state-idle"}>
              {w.icon === "agent" ? <AgentIcon title={w.label} /> : <TerminalIcon title={w.label} />}
            </span>
            <span className="label">{w.label}</span>
            {/* Not for the window you are looking at: you see its output already. */}
            {w.activity && !(selected && page === "terminals" && w.active) && (
              <span className="bell" title="new output" />
            )}
          </button>
        ))}
      </div>
    );
  };

  const items = (group: "ideas" | "changes", list: HTMLDivElement | null): readonly LeaderTarget[] =>
    list === null
      ? []
      : [...list.querySelectorAll<HTMLElement>(`[data-leader-item="${group}"]`)].map((element) => ({
          element,
        }));

  // The column's keys are on one lane, and the two lists put theirs at the middle of the list they
  // pick from. An idea or a change is somewhere to go, so picking one leaves the keys up for the
  // view or the terminal that follows (leader.tsx — `LeaderSelector.stay`).
  useLeaderGroup(
    "sidebar",
    "qwertyuiop",
    () => [
      { kind: "target", element: changesRef.current, align: "rail" },
      { kind: "target", element: newIdeaRef.current, align: "rail" },
      {
        kind: "selector",
        align: "middle",
        stay: true,
        items: () => items("ideas", ideasListRef.current),
        outline: () => ideasListRef.current,
      },
      {
        kind: "selector",
        align: "middle",
        stay: true,
        items: () => items("changes", changesListRef.current),
        outline: () => changesListRef.current,
      },
      { kind: "target", element: workspaceRef.current, keep: true, align: "rail" },
      { kind: "target", element: actionsRef.current, align: "rail" },
      { kind: "target", element: harnessesRef.current, align: "rail" },
      { kind: "target", element: subagentsRef.current, align: "rail" },
      ...pages.map((p) => ({
        kind: "target" as const,
        element: pageRefs.current.get(p.id) ?? null,
        align: "rail" as const,
      })),
    ],
    () => railRef.current,
  );

  useLeaderGroup("bottom", "zxcv", () => [
    { kind: "target", element: settingsRef.current },
    { kind: "target", element: powerRef.current },
    ...(hostReason === undefined ? [] : [{ kind: "target" as const, element: restartRef.current }]),
    ...(update?.eligible === true ? [{ kind: "target" as const, element: updateRef.current }] : []),
  ]);

  return (
    <nav className={open ? "sidebar open" : "sidebar"} style={{ width }}>
      {/* The brand row: the raven and the app's name. In the app window it is the top of the
          window — the lights sit in it on macOS, and the whole row is what you drag the window by
          (apps/web/src/domain/chrome.ts) — so it clears them and lines up with the page's title
          row beside it. The workspace switcher is not here: it belongs with the other entries of
          the workspace section, below the changes, so the column reads top-to-bottom and the
          leader's keys follow it (app-root/leader.tsx). */}
      <div className="band">
        <RavenMark />
        <span className="brand-name">Corvi</span>
      </div>

      {/* The overview. The way to start one left this row for the Ideas heading below, where the
          entries it adds to begin. The icon says what the list is; the count says how much work
          is in it, quietly, at the row's right. */}
      <button
        ref={changesRef}
        className={current || extPage || actions || settings || wizard ? "entry" : "entry current"}
        onClick={onHome}
      >
        <span className="ic" aria-hidden="true">
          <ChangesIcon title="changes" />
        </span>
        <span className="label">Changes</span>
        {/* The number is drawn for the eye; the row's name stays "Changes", which is what it is
            called everywhere else. */}
        {live.length > 0 && (
          <em className="count" aria-hidden="true">
            {live.length}
          </em>
        )}
      </button>
      <div className="list">
        {/* Ideas first, under their own heading: they are the newest thing and the one thing you
            have not started. The work they become follows in attention order. The heading is the
            New button's home — it sits with the entries it adds to, and stays there with no
            ideas and no draft. */}
        <div className="ideas-row">
          <p className="group-label">Ideas</p>
          <button
            ref={newIdeaRef}
            className="create"
            title={newBlocked === true ? "this workspace is unavailable" : "start a new idea"}
            aria-label="new idea"
            disabled={newBlocked}
            onClick={onNew}
          >
            <PlusIcon title="new idea" />
          </button>
        </div>
        {/* The draft is not a change yet — nothing has been written — so it appears as an idea
            that is still being written, above the ideas that exist. Clicking it is the way back
            into the wizard, wherever you left it. */}
        <div className="list-group" ref={ideasListRef}>
          {draft && (
            <div className="change-entry">
              <button
                data-leader-item="ideas"
                className={`entry sub change ${stateClass(IDEATION)}${wizard ? " current" : ""}`}
                title="not created yet — open it to finish or discard it"
                onClick={onNew}
              >
                <span className="top">
                  <span className="swatch" aria-hidden="true" />
                  <span className="subject">{draftLabel(draft)}</span>
                </span>
              </button>
            </div>
          )}
          {ideas.map((c) => entry(c, "ideas"))}
        </div>
        {active.length > 0 && <p className="group-label">Changes</p>}
        <div className="list-group" ref={changesListRef}>
          {active.map((c) => entry(c, "changes"))}
        </div>
        {changes && live.length === 0 && <p className="hint">nothing in progress</p>}
      </div>

      {/* Not under a change, because they are not about one: the core's own Actions page first,
          then the extensions' pages, offered as the server lists them — a context without the
          extension has no entry, not an empty one. Settings stays hardcoded below: it is the
          core's own too, but where you go once in a while rather than while working. */}
      <div className="workspace-row">
        <p className="group-label workspace-label">Workspace</p>
        {/* Which client's world this is. It sits with the section's entries, below the changes:
            everything under it is what that context contains. Always shown, even with one
            workspace: which context you are in should be visible, not implied. */}
        <ActionsMenu
          className="workspace"
          triggerRef={workspaceRef}
          label={`${chosenWorkspace?.name ?? "All work"}${chosenWorkspace === undefined ? "" : availabilitySuffix(statusOfWorkspace(chosenWorkspace))} ▾`}
          actions={[
            ...workspaces.map((w) => ({
              label: `${w.name}${availabilitySuffix(statusOfWorkspace(w))}`,
              disabled: w.id === chosen,
              onSelect: () => onChooseWorkspace(w.id),
            })),
            {
              label: "All work",
              separated: true,
              disabled: chosen === ALL,
              onSelect: () => onChooseWorkspace(ALL),
            },
          ]}
        />
      </div>
      <button ref={actionsRef} className={`entry${actions ? " current" : ""}`} onClick={onActions}>
        <span className="ic" aria-hidden="true">
          <BoltIcon title="actions" />
        </span>
        <span className="label">Actions</span>
      </button>
      <button ref={harnessesRef} className={`entry${harnesses ? " current" : ""}`} onClick={onHarnesses}>
        <span className="ic" aria-hidden="true">
          <HarnessIcon title="harnesses" />
        </span>
        <span className="label">Harnesses</span>
      </button>
      <button ref={subagentsRef} className={`entry${subagents ? " current" : ""}`} onClick={onSubagents}>
        <span className="ic" aria-hidden="true">
          <SubagentsIcon title="subagents" />
        </span>
        <span className="label">Subagents</span>
      </button>
      {pages.map((p) => (
        <button
          key={p.id}
          ref={(element) => {
            if (element === null) pageRefs.current.delete(p.id);
            else pageRefs.current.set(p.id, element);
          }}
          className={extPage === p.id ? "entry current" : "entry"}
          onClick={() => onPage(p.id)}
        >
          <span className="ic" aria-hidden="true">
            {p.id === "leftovers" ? <LeftoversIcon title={p.title} /> : <PageIcon title={p.title} />}
          </span>
          <span className="label">{p.title}</span>
        </button>
      ))}

      {/* At the bottom of the column, not below the list: it is where you go once in a while,
          and it should be in the same place whether you have two changes or nine. Settings is
          the gear; the update icon sits to its right, and the terminal host's own restart stands
          between them, present only while the host is not the one this server would have
          started. */}
      <div className="bottom-row">
        <button
          ref={settingsRef}
          className={`icon-entry${settings ? " current" : ""}`}
          title="Settings"
          aria-label="Settings"
          onClick={onSettings}
        >
          <GearIcon title="Settings" />
        </button>
        <button
          ref={powerRef}
          className={`icon-entry${power.open ? " current" : ""}`}
          title="Power down when done"
          aria-label="Power"
          onClick={power.openDialog}
        >
          <PowerIcon title="Power" />
        </button>
        {hostReason !== undefined && (
          <button
            ref={restartRef}
            className="icon-entry stale"
            title={hostReason}
            aria-label="Restart the terminal host"
            onClick={onRestartHost}
          >
            <RefreshIcon title="Restart the terminal host" />
          </button>
        )}
        {update?.eligible && (
          <button
            ref={updateRef}
            className={`icon-entry update${update.behind > 0 ? " available" : ""}`}
            title={update.behind > 0 ? "New version available" : "No updates"}
            aria-label="Update"
            onClick={onUpdate}
          >
            <UpdateIcon title="Update" />
          </button>
        )}
      </div>

      {/* The whole edge is the handle, because that is where you aim for. */}
      <div
        className="resize"
        title="drag to resize"
        onMouseDown={() => {
          dragging.current = true;
          document.body.classList.add("resizing");
        }}
      />

      {/* Where the column's keycaps line up: a hairline on the column's content edge, which only
          the leader mode ever reads (app-root/leader.tsx — `Group.rail`). */}
      <span className="leader-rail" ref={railRef} aria-hidden="true" />

      {power.open && <PowerDialog view={power} onClose={power.closeDialog} />}
    </nav>
  );
}
