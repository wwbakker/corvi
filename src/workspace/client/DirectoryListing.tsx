import { type JSX, useEffect, useMemo, useState } from "react";
import type { Entry, Listing } from "../../app-root/api.ts";

/**
 * One directory's contents: the breadcrumb, the hidden-directories toggle, the filter and the
 * rows. Shared by the repository browser and the settings page's directory picker, so browsing
 * for a repository and browsing for a directory look and behave the same.
 *
 * The row action is the only difference between the two: the repository browser offers "Add" on
 * a repository, the picker offers nothing and lets its own dialog footer be the action. The
 * `repo` tag is shown only where it means something, for the same reason.
 *
 * The hidden flag is controlled rather than held here: the server withholds dot-directories
 * unless the request asks for them, so ticking the box is a new listing, not a filter over the
 * one on screen. The filter is the opposite — it narrows what has already arrived, so it stays.
 */
export function DirectoryListing({
  listing,
  onOpen,
  showHidden,
  onShowHidden,
  action,
  showRepoTag = false,
}: {
  listing: Listing;
  /** Navigate into a directory (an absolute path). */
  onOpen: (path: string) => void;
  /** Whether dot-directories were asked for in this listing. */
  showHidden: boolean;
  /** Ticking or unticking the box: the caller re-lists, because the server withholds them. */
  onShowHidden: (show: boolean) => void;
  /** The control beside a row, or nothing when the dialog's footer is the action. */
  action?: (entry: Entry) => JSX.Element;
  /** Whether a row may say "repo": only where selecting a repository is what the pane is for. */
  showRepoTag?: boolean;
}): JSX.Element {
  const [filter, setFilter] = useState("");

  // A filter from the previous directory means nothing here.
  useEffect(() => setFilter(""), [listing.path]);

  // The parent of the current directory; undefined at the root, which has nowhere to go up to.
  const parent =
    listing.path === "/"
      ? undefined
      : listing.path.slice(0, listing.path.lastIndexOf("/")) || "/";

  // Filtering the current directory only; browsing into a subdirectory is still a click.
  const entries = useMemo(() => {
    const needle = filter.toLowerCase();
    return needle
      ? listing.entries.filter((e) => e.name.toLowerCase().includes(needle))
      : listing.entries;
  }, [listing.entries, filter]);

  // An empty pane has two reasons, and saying which saves a puzzled look at the toggle.
  const empty =
    listing.entries.length === 0
      ? showHidden
        ? "empty"
        : "empty — hidden directories are not shown"
      : "nothing matches";

  return (
    <div className="listing">
      <div className="breadcrumb">
        <button type="button" onClick={() => onOpen("/")} disabled={listing.path === "/"}>
          /
        </button>
        {listing.path !== "/" && <span>{listing.path.slice(1)}</span>}
        {parent !== undefined && (
          <button type="button" onClick={() => onOpen(parent)}>
            ↑ Up
          </button>
        )}
      </div>

      <div className="listing-controls">
        <input
          className="filter"
          placeholder="filter directories"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(e) => onShowHidden(e.target.checked)}
          />
          <span>show hidden directories</span>
        </label>
      </div>

      <ul className="entries">
        {entries.map((entry) => (
          <li key={entry.path}>
            <button type="button" className="dir" onClick={() => onOpen(entry.path)}>
              {entry.name}/{showRepoTag && entry.isRepo && <span className="tag">repo</span>}
            </button>
            {action?.(entry)}
          </li>
        ))}
        {entries.length === 0 && <li className="hint">{empty}</li>}
      </ul>
    </div>
  );
}
