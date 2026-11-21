import { type JSX, type KeyboardEvent, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import type { Entry, Listing } from "../../app-root/api.ts";
import { KeysIcon } from "../../app-root/icons.tsx";
import { getPref, setPref } from "../../app-root/prefs.ts";

/** The control a row offers beside its name, as behaviour rather than as elements: the listing
 * draws the button from it and gives the same `run` to Shift+Enter, so the key and the button cannot
 * disagree about which rows it applies to. */
export type RowAction = {
  /** The button's own word, which also says what state the row is in ("Add", "Added"). */
  label: (entry: Entry) => string;
  /** What the key does, in the keymap's words: the picker has no action, so it has no such line. */
  hint: string;
  disabled?: (entry: Entry) => boolean;
  title?: (entry: Entry) => string | undefined;
  run: (entry: Entry) => void;
};

/** Whether the keymap is unfolded. A cookie rather than localStorage: the app serves itself from a
 * new port every launch and an origin includes the port, so localStorage is forgotten each time. */
const KEYS_PREF = "directoryKeys";

/** One chord of the keymap: the keys as they are written, and what they do. */
type KeyLine = { keys: string; what: string };

/**
 * One directory's contents: the breadcrumb, the hidden-directories toggle, the filter and the
 * rows, driven from the keyboard as well as the mouse. Shared by the repository browser and the
 * settings page's directory picker, so browsing for a repository and browsing for a directory
 * look and behave the same.
 *
 * The row action is the only difference between the two: the repository browser offers "Add" on
 * a repository, the picker offers nothing and lets its own dialog footer be the action. The
 * `repo` tag is shown only where it means something, for the same reason.
 *
 * The hidden flag is controlled rather than held here: the server withholds dot-directories
 * unless the request asks for them, so ticking the box is a new listing, not a filter over the
 * one on screen. The filter is the opposite — it narrows what has already arrived, so it stays.
 *
 * The selection is the keyboard's cursor and lives here rather than in the row that happens to
 * have focus: typing in the filter, arrowing down and pressing Enter should never move the caret
 * out of the field. Rows stay buttons, so tabbing and clicking still work around it.
 */
export function DirectoryListing({
  listing,
  onOpen,
  showHidden,
  onShowHidden,
  action,
  showRepoTag = false,
  filterRef,
}: {
  listing: Listing;
  /** Navigate into a directory (an absolute path). */
  onOpen: (path: string) => void;
  /** Whether dot-directories were asked for in this listing. */
  showHidden: boolean;
  /** Ticking or unticking the box: the caller re-lists, because the server withholds them. */
  onShowHidden: (show: boolean) => void;
  /** The control beside a row, or nothing when the dialog's footer is the action. */
  action?: RowAction;
  /** Whether a row may say "repo": only where selecting a repository is what the pane is for. */
  showRepoTag?: boolean;
  /** The filter, for the dialog that opens this to put the keyboard in it. The dialog owns the
   * moment because `showModal` focuses the dialog itself; the field is the listing's. */
  filterRef?: RefObject<HTMLInputElement | null>;
}): JSX.Element {
  const [filter, setFilter] = useState("");
  // The keyboard's row, as an index into what the filter shows. It starts at the first row and
  // returns there whenever the list underneath it becomes a different list.
  const [choice, setChoice] = useState(0);
  // Read in an effect rather than with the first render: the pane is also rendered to markup with
  // no document around it, and a cookie is a browser thing.
  const [showKeys, setShowKeys] = useState(false);
  const ownFilter = useRef<HTMLInputElement>(null);
  const filterInput = filterRef ?? ownFilter;
  const selectedRow = useRef<HTMLButtonElement>(null);

  // A filter from the previous directory means nothing here, and neither does a row number.
  useEffect(() => {
    setFilter("");
    setChoice(0);
  }, [listing.path]);

  // Whoever opened the keymap last time opens it here too.
  useEffect(() => setShowKeys(getPref(KEYS_PREF) === "open"), []);

  // The parent of the current directory; undefined at the root, which has nowhere to go up to.
  const parent =
    listing.path === "/" ? undefined : listing.path.slice(0, listing.path.lastIndexOf("/")) || "/";

  // Filtering the current directory only; browsing into a subdirectory is still a click.
  const entries = useMemo(() => {
    const needle = filter.toLowerCase();
    return needle ? listing.entries.filter((e) => e.name.toLowerCase().includes(needle)) : listing.entries;
  }, [listing.entries, filter]);

  // The filter can leave the row number past the end of a shorter list; the selection is the row
  // that is actually there.
  const selected = entries.length === 0 ? -1 : Math.min(choice, entries.length - 1);

  // The list scrolls at 420px, so the row the keyboard is on has to be the one you can see.
  useEffect(() => {
    selectedRow.current?.scrollIntoView({ block: "nearest" });
  }, [selected, entries]);

  const step = (delta: number): void => {
    if (entries.length === 0) return;
    setChoice((current) => {
      const from = Math.min(Math.max(current, 0), entries.length - 1);
      return (from + delta + entries.length) % entries.length;
    });
  };

  const up = (): void => {
    if (parent !== undefined) onOpen(parent);
  };

  /** Every chord the pane takes, handled here rather than on the filter, so the arrows work whether
   * the keyboard is in the field or on a row. Chords are matched on `code`: macOS reports a composed
   * character for a letter under Option, and Enter is the same key code on both hosts. */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const entry = selected >= 0 ? entries[selected] : undefined;

    if (event.altKey) {
      if (event.code === "ArrowUp") {
        event.preventDefault();
        up();
      }
      return;
    }
    if (event.shiftKey) {
      // Shift+Enter presses the row's action, where the row has one and it can be pressed. It is
      // not the picker's Enter (which walks into the directory), not the filter's, and it is no
      // other chord either: Ctrl/Meta+Shift+Enter belongs to whatever else wants it. A focused
      // button activates itself, so the key leaves that button alone, as Enter does below.
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.code !== "Enter" && event.code !== "NumpadEnter") return;
      if (event.target instanceof HTMLButtonElement) return;
      if (action === undefined || entry === undefined || action.disabled?.(entry)) return;
      event.preventDefault();
      action.run(entry);
      return;
    }
    // Everything else here is a plain key: a chord the app or the platform owns stays theirs.
    if (event.ctrlKey || event.metaKey) return;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        step(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        step(-1);
        break;
      case "Enter":
        // A focused button activates itself, so Enter there belongs to that button — the row's own,
        // or its Add. Anywhere else in the pane, Enter walks into the selected directory.
        if (event.target instanceof HTMLButtonElement || entry === undefined) return;
        event.preventDefault();
        onOpen(entry.path);
        break;
      default:
        break;
    }
  };

  // An empty pane has two reasons, and saying which saves a puzzled look at the toggle.
  const empty =
    listing.entries.length === 0
      ? showHidden
        ? "empty"
        : "empty — hidden directories are not shown"
      : "nothing matches";

  // What the pane can actually do: no line for a chord that has nothing to press here.
  const keymap: KeyLine[] = [
    { keys: "↑ ↓", what: "choose" },
    { keys: "Enter", what: "open" },
    { keys: "Alt+↑", what: "up" },
    ...(action === undefined ? [] : [{ keys: "Shift+Enter", what: action.hint }]),
  ];

  return (
    <div className="listing" onKeyDown={onKeyDown}>
      <div className="breadcrumb">
        <button type="button" onClick={() => onOpen("/")} disabled={listing.path === "/"}>
          /
        </button>
        {listing.path !== "/" && <span>{listing.path.slice(1)}</span>}
        {parent !== undefined && (
          <button type="button" title="Alt+↑" onClick={up}>
            ↑ Up
          </button>
        )}
      </div>

      <div className="listing-controls">
        <input
          ref={filterInput}
          className="filter"
          aria-label="Filter directories"
          placeholder="filter directories"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setChoice(0);
          }}
        />
        <label className="check">
          <input type="checkbox" checked={showHidden} onChange={(e) => onShowHidden(e.target.checked)} />
          <span>show hidden directories</span>
        </label>
        <button
          type="button"
          className="icon keys"
          aria-label="Keyboard shortcuts"
          aria-expanded={showKeys}
          title={keymap.map(({ keys, what }) => `${keys} ${what}`).join(" · ")}
          onClick={() => {
            setShowKeys(!showKeys);
            setPref(KEYS_PREF, showKeys ? "closed" : "open");
          }}
        >
          <KeysIcon title="Keyboard shortcuts" />
        </button>
      </div>

      {showKeys && (
        <ul className="keymap">
          {keymap.map(({ keys, what }) => (
            <li key={keys}>
              <code>{keys}</code> {what}
            </li>
          ))}
        </ul>
      )}

      <ul className="entries">
        {entries.map((entry, index) => (
          <li key={entry.path}>
            <button
              ref={index === selected ? selectedRow : undefined}
              type="button"
              className={index === selected ? "dir selected" : "dir"}
              aria-current={index === selected ? "true" : undefined}
              onClick={() => onOpen(entry.path)}
            >
              {entry.name}/{showRepoTag && entry.isRepo && <span className="tag">repo</span>}
            </button>
            {action && (
              <button
                type="button"
                disabled={action.disabled?.(entry) ?? false}
                title={action.title?.(entry)}
                onClick={() => action.run(entry)}
              >
                {action.label(entry)}
              </button>
            )}
          </li>
        ))}
        {entries.length === 0 && <li className="hint">{empty}</li>}
      </ul>
    </div>
  );
}
