/** The new-terminal dialog: shell or harness, in a chosen directory, opened by the "+" tab or the
 * leader's positional key. 1/Enter starts a shell; 2 starts a harness; the dialog owns its keys
 * while it is open. */
import { type JSX, useEffect, useRef, useState } from "react";

/** What opened the dialog. The leader key is advertised by the keycaps, so the dialog shows the
 * keys it answers to; the "+" tab is a control you already pressed, and a key hint there is a
 * second set of instructions for a choice the pointer is making. */
export type NewTerminalOpener = "keyboard" | "pointer";
import { ChangeId } from "@corvi/contracts/changes";
import type { Change } from "../../app-root/api.ts";
import type { TerminalWindow } from "../../domain/terminal.ts";
import type { CorviClient } from "@corvi/client";
import { getPref, setPref } from "../../app-root/prefs.ts";

type Kind = "shell" | "harness";

const LAST_KIND = "corvi:new-terminal-kind";
const LAST_DIR = "corvi:new-terminal-dir";
const LAST_HARNESS = "corvi:new-terminal-harness";

export function NewTerminalDialog({
  open,
  opener,
  change,
  client,
  currentDirectory,
  onClose,
  onCreated,
}: {
  open: boolean;
  /** How it was opened: with the keys showing, or with the pointer. */
  opener: NewTerminalOpener;
  change: Change;
  client: CorviClient;
  /** Where the active pane's shell is now, the dialog's default directory. */
  currentDirectory?: string;
  onClose: () => void;
  /** The change's windows after the create, which is what the page applies to its window list.
   * Both paths answer with the list: a window action's answer is the list, and a harness window's
   * carries it beside the new pane's id. */
  onCreated: (windows: readonly TerminalWindow[]) => void | Promise<void>;
}): JSX.Element {
  // The chips are the leader's promise kept: they are in the dialog because a modal one lives in
  // the browser's top layer, where the leader's own overlay cannot be drawn.
  const keysShown = opener === "keyboard";
  const dialog = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState<Kind>(() => (getPref(LAST_KIND) === "harness" ? "harness" : "shell"));
  const [directory, setDirectory] = useState(() => getPref(LAST_DIR) ?? "current");
  const [harness, setHarness] = useState(() => getPref(LAST_HARNESS) ?? "");
  const [directories, setDirectories] = useState<readonly { path: string; label: string }[]>([]);
  const [harnesses, setHarnesses] = useState<readonly { key: string; label: string; problem?: string }[]>([]);
  const [userDefault, setUserDefault] = useState("builtin:pi");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const changeId = ChangeId.make(change.id);
    // Restore only after both lists are in hand: a stored checkout is valid only if the checkout
    // list knows it, and a stored "Change default" (empty key) is a real remembered choice.
    Promise.all([
      client.changes.checkouts(changeId).catch(() => []),
      client.harnessProfiles.summaries(changeId).catch((error: Error) => {
        setError(error.message);
        return null;
      }),
    ]).then(([repos, listed]) => {
      setDirectories(repos.map((repo) => ({ path: repo.checkoutLocation, label: repo.checkoutLocation })));
      if (listed === null) return;
      setHarnesses(
        listed.harnessProfiles.map((one) => ({
          key: one.key,
          label: `${one.label} (${one.harness ?? "?"})`,
          ...(one.problem === undefined ? {} : { problem: one.problem }),
        })),
      );
      setUserDefault(listed.selection.userHarnessProfile ?? listed.selection.userDefault);
      const storedDirectory = getPref(LAST_DIR);
      if (
        storedDirectory !== undefined &&
        storedDirectory !== "current" &&
        storedDirectory !== "change" &&
        !repos.some((repo) => repo.checkoutLocation === storedDirectory)
      ) {
        setDirectory("current");
      }
      const storedHarness = getPref(LAST_HARNESS);
      const fallback = listed.selection.userHarnessProfile ?? listed.selection.userDefault;
      if (
        storedHarness === undefined ||
        (storedHarness !== "" && !listed.harnessProfiles.some((one) => one.key === storedHarness))
      ) {
        setHarness(fallback);
      }
    });
  }, [open, change.id, client]);

  const start = async (wanted: Kind): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setPref(LAST_KIND, wanted);
    setPref(LAST_DIR, directory);
    // "Change default" is a choice worth remembering too.
    setPref(LAST_HARNESS, harness);
    try {
      // The selector's three values are distinct: the current pane's directory, the change root
      // (the server's sentinel), or one checkout's absolute path. Always sent explicitly, so the
      // same label cannot mean two things for a shell and a harness.
      const target = directory === "current" ? "current" : directory === "" ? "change" : directory;
      const windows =
        wanted === "shell"
          ? await client.terminals.windowAction(ChangeId.make(change.id), {
              action: "new",
              directory: target,
            })
          : (
              await client.harnessProfiles.openWindow(ChangeId.make(change.id), {
                harnessProfile: harness === "" ? userDefault : harness,
                directory: target,
              })
            ).windows;
      // The answer is handed over before the dialog closes: the page applies it, so the view it
      // moves to already knows about the window it is showing.
      await onCreated(windows);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="new-terminal-dialog"
      aria-label="new terminal"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        // The dialog owns its keys. A select still takes its own arrows; typing a digit or Enter
        // elsewhere is the dialog's choice.
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
          return;
        }
        if (event.target instanceof HTMLSelectElement) return;
        if (event.key === "1") {
          event.preventDefault();
          void start("shell");
        } else if (event.key === "2") {
          event.preventDefault();
          void start("harness");
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setKind((current) => (current === "shell" ? "harness" : "shell"));
        } else if (event.key === "Enter") {
          event.preventDefault();
          void start(kind);
        }
      }}
    >
      <header>
        <h2>New terminal</h2>
        <span className="spacer" />
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </header>
      <div className="terminal-choices" role="radiogroup" aria-label="what to open">
        <button
          type="button"
          role="radio"
          aria-checked={kind === "shell"}
          className={kind === "shell" ? "choice current" : "choice"}
          onClick={() => setKind("shell")}
          onDoubleClick={() => void start("shell")}
        >
          {keysShown && <kbd>1</kbd>}
          <strong>Shell</strong>
          <span className="hint">a shell with the change&apos;s user harness profile</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={kind === "harness"}
          className={kind === "harness" ? "choice current" : "choice"}
          onClick={() => setKind("harness")}
          onDoubleClick={() => void start("harness")}
        >
          {keysShown && <kbd>2</kbd>}
          <strong>Harness profile</strong>
          <span className="hint">
            start the program with a harness profile, in a new window named after it
          </span>
        </button>
      </div>
      <div className="form">
        <label>
          <span>Directory</span>
          <select
            aria-label="terminal directory"
            value={directory}
            onChange={(event) => setDirectory(event.target.value)}
          >
            <option value="current">
              Current pane{currentDirectory === undefined ? "" : ` (${currentDirectory})`}
            </option>
            <option value="change">Change root</option>
            {directories.map((entry) => (
              <option key={entry.path} value={entry.path}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Harness profile</span>
          <select
            aria-label="terminal harness profile"
            value={harness}
            disabled={kind !== "harness"}
            onChange={(event) => setHarness(event.target.value)}
          >
            <option value="">Change default ({userDefault})</option>
            {harnesses.map((entry) => (
              <option key={entry.key} value={entry.key} disabled={entry.problem !== undefined}>
                {entry.label}
                {entry.problem === undefined ? "" : ` — ${entry.problem}`}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error !== null && <div className="error-banner">{error}</div>}
      <footer>
        {keysShown && (
          <span className="hint">
            <kbd>1</kbd> shell · <kbd>2</kbd> harness · <kbd>Enter</kbd> open · <kbd>Esc</kbd> close
          </span>
        )}
        <span className="spacer" />
        <button type="button" className="create" disabled={busy} onClick={() => void start(kind)}>
          {busy ? "Opening…" : kind === "shell" ? "Open shell" : "Start harness"}
        </button>
      </footer>
    </dialog>
  );
}
