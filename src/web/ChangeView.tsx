import { useEffect, useState } from "react";
import {
  api,
  patch,
  post,
  CHANGE_STATES,
  type ApiError,
  type ChangeState,
  type Change,
  type Completion,
  type IntegrationInfo,
  type ProvisionResult,
} from "./api.ts";
import { ActionsMenu, type Action } from "./ActionsMenu.tsx";
import type { TerminalWindow } from "../terminalTypes.ts";
import { useCached } from "./cache.ts";
import { stateClass } from "./changeState.tsx";
import { isFinished } from "../types.ts";
import { NotesCard } from "./NotesCard.tsx";
import { TerminalPane } from "./TerminalPane.tsx";
import { CheatSheet } from "./CheatSheet.tsx";
import type { Platform } from "./newWindowKey.ts";
import { CompletionCard } from "./CompletionCard.tsx";
import { LocalPane } from "./LocalPane.tsx";
import { PerRepoCard } from "./PerRepoCard.tsx";
import { WidgetCard } from "./WidgetCard.tsx";
import { WindowTabs } from "./WindowTabs.tsx";

/** Branch names start with the change id, which the crumb already shows: drop the repetition. */
const branchLabel = (id: string, branch: string): string =>
  branch.startsWith(`${id}-`) ? branch.slice(id.length + 1) : branch;

export function ChangeView({
  id,
  page,
  platform,
  provision,
  terminal,
  windows,
  onSelectWindow,
  onNewWindow,
  onMoveWindow,
  onOpenPage,
  onChanged,
}: {
  id: string;
  /** Which page of the change to show. */
  page: "dashboard" | "review" | "terminals";
  /** Results of the creation step, shown once: it is the one moment something can fail
   * without you having clicked it. */
  provision?: ProvisionResult[];
  /** The change's tmux session, owned by the app so the navigation column can list its
   * windows from any page. */
  terminal: {
    url: string | null;
    error: string | null;
    /** The ttyd on record has outlived its tmux session: the shells are gone. */
    gone: boolean;
    /** That ttyd's pid, for the message that says how to start over. */
    pid?: number;
    create: () => void;
  };
  /** This change's tmux windows: what the terminal page's tabs are. */
  windows: TerminalWindow[];
  /** Switching the session to one of its windows. */
  onSelectWindow: (index: number) => void;
  /** Another window beside the current one. The terminal's own chord does this from inside it;
   * this is the tab that does. */
  onNewWindow: () => void;
  /** A dragged tab landed: the window at `from` takes the place of the one at `to`. */
  onMoveWindow: (from: number, to: number) => void;
  /** Switching between the change's own pages, which are tabs rather than navigation: they are
   * two views of the same change, not two places. */
  onOpenPage: (page: "dashboard" | "review") => void;
  /** The change was renamed, completed or otherwise altered: the lists elsewhere are stale. */
  onChanged: () => void;
  /** The server's platform: what the terminal's key hints and shortcut assume. */
  platform: Platform;
}) {
  const [change, setChange] = useCached<Change>(`${id}:change`);
  // Per change, not global: which components there are depends on the workspace it is in.
  const [infos, setInfos] = useCached<IntegrationInfo[]>(`${id}:integrations`);
  const [completion, setCompletion] = useCached<Completion>(`${id}:completion`);
  const [completing, setCompleting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The terminal keeps its shells whichever page you are on, so it is mounted once it has been
  // opened and only hidden afterwards.
  const [terminalOpened, setTerminalOpened] = useState(page === "terminals");
  const [cheatSheet, setCheatSheet] = useState(false);
  // The change's name, while you are typing a new one. null when you are not.
  const [draft, setDraft] = useState<string | null>(null);
  // Bumping this remounts the widgets, so they re-read the world after a merge.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (page === "terminals") setTerminalOpened(true);
  }, [page]);

  // The change itself and the list of components are cheap: no CLI calls behind either.
  useEffect(() => {
    api<Change>(`/changes/${id}`)
      .then(setChange)
      .catch((e: Error) => setError(e.message));
    api<IntegrationInfo[]>(`/changes/${id}/integrations`)
      .then(setInfos)
      .catch((e: Error) => setError(e.message));
  }, [id]);

  // Whether completing is allowed, refreshed alongside the widgets.
  useEffect(() => {
    if (change?.completedAt) return;
    const ac = new AbortController();
    const load = () =>
      api<Completion>(`/changes/${id}/complete`, { signal: ac.signal })
        .then(setCompletion)
        .catch(() => {}); // keep the last verdict rather than blanking the button
    void load();
    const timer = setInterval(load, 15000);
    return () => {
      ac.abort();
      clearInterval(timer);
    };
  }, [id, change?.completedAt, generation]);

  const card = (info: IntegrationInfo) =>
    info.perRepo ? (
      <PerRepoCard
        key={`${info.name}-${generation}`}
        changeId={id}
        info={info}
        repos={change?.repos ?? []}
        onReposChanged={reload}
      />
    ) : (
      <WidgetCard key={`${info.name}-${generation}`} changeId={id} info={info} />
    );

  // Re-read the change and remount the cards: its repository list just changed.
  const reload = () => {
    api<Change>(`/changes/${id}`)
      .then(setChange)
      .catch((e: Error) => setError(e.message));
    setGeneration((g) => g + 1);
  };

  const copyDescription = () =>
    api<{ text: string }>(`/changes/${id}/description`)
      .then(({ text }) => navigator.clipboard.writeText(text))
      .then(() => {
        setNotice("Pull request description copied");
        setTimeout(() => setNotice(null), 2500);
      })
      .catch((e: Error) => setError(e.message));

  const complete = () => {
    setCompleting(true);
    setError(null);
    post<{ change: Change; notes: string[] }>(`/changes/${id}/complete`, {})
      .then(({ change: updated }) => {
        setChange(updated);
        setGeneration((g) => g + 1);
      })
      // Where it stopped is in the completion card, which reads it from disk; this is only for
      // a refusal before anything started, such as a pull request that is not approved.
      .catch((e: Error) => setError(e.message))
      .finally(() => setCompleting(false));
  };

  /**
   * Abandon the change: the worktrees and the terminal go, and everything anyone else can see —
   * branches, pull requests, the ticket — is left alone and listed back to you.
   */
  const cancel = (force = false) => {
    if (
      !force &&
      !window.confirm(
        `Cancel ${id}? The worktrees and the terminal go. The branches, pull requests and the ` +
          `ticket are left alone — you will be told what is left.`,
      )
    ) {
      return;
    }
    setCancelling(true);
    setError(null);
    post<{ change: Change; loose: string[] }>(`/changes/${id}/cancel`, { force })
      .then(({ change: updated, loose }) => {
        setChange(updated);
        setGeneration((g) => g + 1);
        onChanged();
        if (loose.length) setNotice(`Cancelled. Still open: ${loose.join("; ")}`);
      })
      .catch((e: ApiError) => {
        const needsForce = (e.body as { needsForce?: string[] })?.needsForce;
        // Commits nobody else has. The branch survives, so this is recoverable — by someone who
        // knows the branch is there, which is worth one question.
        if (needsForce?.length) {
          if (
            window.confirm(
              `${needsForce.join(", ")}: commits that were never pushed. ` +
                `The worktree goes, the branch is kept. Cancel anyway?`,
            )
          ) {
            cancel(true);
          }
          return;
        }
        setError(e.message);
      })
      .finally(() => setCancelling(false));
  };

  // The two ways a change ends are last, and apart: everything above them is reversible.
  const changeActions: Action[] = [
    { label: "Copy PR description", onSelect: copyDescription },
    {
      label: completing ? "Completing…" : "Complete change",
      separated: true,
      disabled: completing || !completion?.ready,
      // Every repository must be approved or already merged.
      title: completion?.reasons.join("\n") || undefined,
      onSelect: complete,
    },
    {
      label: cancelling ? "Cancelling…" : "Cancel change",
      disabled: cancelling || completing,
      title: "Abandon this change: the worktrees go, nothing is merged",
      onSelect: () => cancel(),
    },
  ];

  const windowTabs = (
    <WindowTabs
      page={page}
      windows={windows}
      platform={platform}
      onSelectWindow={onSelectWindow}
      onNewWindow={onNewWindow}
      onMoveWindow={onMoveWindow}
      onOpenPage={onOpenPage}
    />
  );

  /** The terminal page's own bar: the windows, and the key reference. The change's id, name,
   * state and actions are the dashboard's — while a shell has the keyboard they say nothing. */
  const terminalBar = (
    <header className="terminal-bar">
      {windowTabs}
      <span className="spacer" />
      <button onClick={() => setCheatSheet(true)}>tmux cheat sheet</button>
    </header>
  );

  const changeBar = (
    <header>
      {/* The one heading: where you are is in the navigation column, so this says what the
          change is rather than how you got here. */}
      <h2>
        {id}
        {change &&
          (draft === null ? (
            // A name that came from the ticket is a suggestion, not a fact: rename it here and
            // it stops being refreshed from Jira. Clearing it hands it back.
            <button
              className="subject"
              title="rename this change"
              onClick={() => setDraft(change.title ?? "")}
            >
              {change.title ?? branchLabel(id, change.branch)}
            </button>
          ) : (
            <input
              className="subject"
              autoFocus
              value={draft}
              placeholder={change.jira ? `from ${change.jira}` : "what this change is about"}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setDraft(null);
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              onBlur={() => {
                const next = draft.trim();
                setDraft(null);
                if (next === (change.title ?? "")) return;
                patch<Change>(`/changes/${id}`, { title: next })
                  .then((updated) => {
                    setChange(updated);
                    onChanged();
                  })
                  .catch((err: Error) => setError(err.message));
              }}
            />
          ))}
      </h2>
      <span className="spacer" />
      {change && (
        <select
          className={stateClass(change.state)}
          value={change.state ?? "In Progress"}
          // Your own view of where the change stands; completing it sets "Completed".
          onChange={(e) =>
            patch<Change>(`/changes/${id}`, { state: e.target.value as ChangeState })
              .then((updated) => {
                setChange(updated);
                onChanged(); // the navigation column and the overview list states too
              })
              .catch((err: Error) => setError(err.message))
          }
        >
          {/* Only the states you are in, not the ones a change ends in: picking "Completed"
              from a list used to set the word without merging anything, removing a worktree or
              archiving the change — a label that lies. Ending a change is Complete or Cancel,
              which do the work. A change that has already ended still shows its own state,
              because a select cannot display what it does not offer. */}
          {CHANGE_STATES.filter((s) => !isFinished({ ...change, state: s })).map((s) => (
            <option key={s}>{s}</option>
          ))}
          {isFinished(change) && <option>{change.state}</option>}
        </select>
      )}
      {change && isFinished(change) ? (
        // How it ended, not only that it did: a change that was abandoned is not one that
        // landed, and the badge is the only place that says so on this page.
        <span className={`badge ${change.state === "Cancelled" ? stateClass(change.state) : "ok"}`}>
          {(change.state ?? "Completed").toLowerCase()} {change.completedAt?.slice(0, 10)}
        </span>
      ) : (
        <ActionsMenu actions={changeActions} />
      )}
    </header>
  );

  return (
    <div className={page === "terminals" ? "page terminal-page" : "page"}>
      {/* The same strip at the very top of the dashboard too, above the change's header, so a
          terminal window is one click from where the work is. */}
      {page === "dashboard" && <div className="window-bar">{windowTabs}</div>}
      {page === "terminals" ? terminalBar : changeBar}
      <CheatSheet changeId={id} open={cheatSheet} onClose={() => setCheatSheet(false)} platform={platform} />
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="notice">{notice}</div>}
      {(provision ?? [])
        .filter((r) => !r.ok)
        .map((r) => (
          <div key={r.integration} className="error-banner">
            {r.integration}: {r.error}
          </div>
        ))}
      {/* Unmounted rather than hidden while you are in the terminal: their per-repository CLI
          calls hold every connection the browser allows per origin for seconds at a time, and
          the terminal's own polling would queue behind them. Coming back repaints from the
          cache and refreshes. */}
      {/* Two views of one change: what it is doing, and what is in it. The terminal is not one
          of them — it is reached from the navigation column, and lives in its own page. */}
      {page !== "terminals" && (
        <nav className="tabs">
          {([
            ["dashboard", "Dashboard"],
            ["review", "Review changes"],
          ] as const).map(([name, label]) => (
            <button
              key={name}
              className={page === name ? "tab current" : "tab"}
              onClick={() => onOpenPage(name)}
            >
              {label}
            </button>
          ))}
        </nav>
      )}
      {page === "dashboard" && (
        <div className="widgets">
          <div className="column">
            <CompletionCard changeId={id} busy={completing} onFinished={setChange} />
            {(infos ?? []).filter((i) => !i.wide).map(card)}
            <NotesCard changeId={id} />
          </div>
          <div className="column">{(infos ?? []).filter((i) => i.wide).map(card)}</div>
        </div>
      )}
      {/* Every repository in one list: a change is the unit of work, not a checkout. */}
      {page === "review" && (
        <LocalPane
          changeId={id}
          repos={change?.repos ?? []}
          // What people write anyway, so it is there to edit rather than to type.
          suggestion={change?.title ? `${id} ${change.title}` : id}
        />
      )}
      {terminalOpened && (
        <div className="terminal-host" hidden={page !== "terminals"}>
          <TerminalPane
            changeId={id}
            url={terminal.url}
            error={terminal.error}
            visible={page === "terminals"}
            platform={platform}
            onNewWindow={terminal.create}
            gone={terminal.gone}
            pid={terminal.pid}
            windows={windows.length}
          />
        </div>
      )}
    </div>
  );
}
