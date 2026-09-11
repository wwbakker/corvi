import { type JSX, useEffect, useMemo, useState } from "react";
import { api, type Branches, type Entry, type Listing, type Selection } from "../../web/api.ts";

/** Directory browser under the configured repos root. Browsing and selecting are separate
 * actions on every row, because a directory can be both a repository and a parent of others.
 * How a repository is worked on, and what its branch starts from, is decided per selected
 * repository on the right. */
export function RepoBrowser({
  selected,
  onAdd,
  onRemove,
  onChange,
}: {
  /** Repositories already chosen, with their mode and base branch. */
  selected: Selection[];
  onAdd: (absolutePath: string) => void;
  onRemove: (absolutePath: string) => void;
  onChange: (absolutePath: string, patch: Partial<Selection>) => void;
}): JSX.Element {
  const [listing, setListing] = useState<Listing>({ root: "", path: "", entries: [] });
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  // Branches per repository, fetched once each: the base selector needs somewhere to choose from.
  const [branches, setBranches] = useState<Record<string, Branches>>({});

  // No argument opens the configured starting directory; an explicit "" is the root.
  const open = (path?: string): void => {
    api<Listing>(path === undefined ? "/repos" : `/repos?path=${encodeURIComponent(path)}`)
      .then((next) => {
        setListing(next);
        setFilter(""); // a filter from the previous directory means nothing here
      })
      .catch((e: Error) => setError(e.message));
  };
  useEffect(() => open(), []);

  // Every selected repository needs its branches, whether it was just added or came with the
  // change; the default is what a repository starts from unless you say otherwise.
  useEffect(() => {
    for (const { path } of selected) {
      if (branches[path]) continue;
      setBranches((known) => ({ ...known, [path]: { branches: [] } })); // claim it, fetch once
      api<Branches>(`/repos/branches?path=${encodeURIComponent(path)}`)
        .then((found) => setBranches((known) => ({ ...known, [path]: found })))
        .catch(() => {});
    }
  }, [selected]);

  const parent = listing.path.includes("/")
    ? listing.path.slice(0, listing.path.lastIndexOf("/"))
    : "";
  const absolute = (entry: Entry): string => `${listing.root}/${entry.path}`;

  // Filters the current directory only; browsing into a subdirectory is still a click.
  const entries = useMemo(() => {
    const needle = filter.toLowerCase();
    return needle
      ? listing.entries.filter((e) => e.name.toLowerCase().includes(needle))
      : listing.entries;
  }, [listing.entries, filter]);

  return (
    <div className="browser">
      {error && <div className="error-banner">{error}</div>}
      <div className="panes">
        <div className="pane">
          <div className="breadcrumb">
            <button type="button" onClick={() => open("")} disabled={!listing.path}>
              {listing.root}
            </button>
            {listing.path && <span>/ {listing.path}</span>}
            {listing.path && (
              <button type="button" onClick={() => open(parent)}>
                ↑ Up
              </button>
            )}
          </div>

          <input
            className="filter"
            placeholder="filter directories"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />

          <ul className="entries">
            {entries.map((entry) => {
              const path = absolute(entry);
              const added = selected.some((s) => s.path === path);
              return (
                <li key={entry.path}>
                  <button type="button" className="dir" onClick={() => open(entry.path)}>
                    {entry.name}/{entry.isRepo && <span className="tag">repo</span>}
                  </button>
                  <button
                    type="button"
                    disabled={!entry.isRepo || added}
                    title={entry.isRepo ? undefined : "not a git repository"}
                    onClick={() => onAdd(path)}
                  >
                    {added ? "Added" : "Add"}
                  </button>
                </li>
              );
            })}
            {entries.length === 0 && (
              <li className="hint">{listing.entries.length ? "nothing matches" : "empty"}</li>
            )}
          </ul>
        </div>

        <div className="pane selected-pane">
          <div className="breadcrumb">Selected ({selected.length})</div>
          <ul className="entries">
            {selected.map(({ path, direct, base }) => {
              const known = branches[path];
              const options = known?.branches.length
                ? known.branches
                : [base ?? known?.default ?? "loading…"];
              return (
                <li key={path} className="selection">
                  <div className="row">
                    <span className="path">{path.replace(`${listing.root}/`, "")}</span>
                    <button type="button" title="Remove" onClick={() => onRemove(path)}>
                      ✕
                    </button>
                  </div>
                  <div className="row">
                    <select
                      value={direct ? "direct" : "worktree"}
                      title="a separate checkout, or this repository's own"
                      onChange={(e) => onChange(path, { direct: e.target.value === "direct" })}
                    >
                      <option value="worktree">worktree</option>
                      <option value="direct">in place</option>
                    </select>
                    <select
                      className="base"
                      value={base ?? known?.default ?? ""}
                      title="the branch this work starts from"
                      onChange={(e) => onChange(path, { base: e.target.value })}
                    >
                      {options.map((branch) => (
                        <option key={branch} value={branch}>
                          {branch}
                        </option>
                      ))}
                    </select>
                  </div>
                </li>
              );
            })}
            {selected.length === 0 && <li className="hint">no repositories selected</li>}
          </ul>
        </div>
      </div>
    </div>
  );
}
