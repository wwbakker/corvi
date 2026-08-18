import { useEffect, useMemo, useState } from "react";
import { api, type Entry, type Listing } from "./api.ts";

/** Directory browser under the configured repos root. Browsing and selecting are separate
 * actions on every row, because a directory can be both a repository and a parent of others. */
export function RepoBrowser({
  selected,
  onAdd,
  onRemove,
}: {
  /** Absolute repository paths already chosen. */
  selected: string[];
  onAdd: (absolutePath: string) => void;
  onRemove: (absolutePath: string) => void;
}) {
  const [listing, setListing] = useState<Listing>({ root: "", path: "", entries: [] });
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const open = (path: string) => {
    api<Listing>(`/repos?path=${encodeURIComponent(path)}`)
      .then((next) => {
        setListing(next);
        setFilter(""); // a filter from the previous directory means nothing here
      })
      .catch((e: Error) => setError(e.message));
  };
  useEffect(() => open(""), []);

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
              const added = selected.includes(path);
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
            {selected.map((path) => (
              <li key={path}>
                <span className="path">{path.replace(`${listing.root}/`, "")}</span>
                <button type="button" title="Remove" onClick={() => onRemove(path)}>
                  ✕
                </button>
              </li>
            ))}
            {selected.length === 0 && <li className="hint">no repositories selected</li>}
          </ul>
        </div>
      </div>
    </div>
  );
}
