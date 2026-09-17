import { type JSX, useCallback, useEffect, useState } from "react";
import { api, type Branches, type Listing, type Selection } from "../../app-root/api.ts";
import { DirectoryListing } from "./DirectoryListing.tsx";
import { fetchListing } from "./repoListing.ts";

/** Directory browser, unbounded: it opens where the context's repositories directory says and
 * can walk anywhere from there. Browsing and selecting are separate actions on every row,
 * because a directory can be both a repository and a parent of others. How a repository is
 * worked on, and what its branch starts from, is decided per selected repository on the right. */
export function RepoBrowser({
  selected,
  onAdd,
  onRemove,
  onChange,
  workspace,
}: {
  /** Repositories already chosen, with their mode and base branch. */
  selected: Selection[];
  /** Which context's repositories directory to open on; undefined is the global one. */
  workspace?: string;
  onAdd: (absolutePath: string) => void;
  onRemove: (absolutePath: string) => void;
  onChange: (absolutePath: string, patch: Partial<Selection>) => void;
}): JSX.Element {
  const [listing, setListing] = useState<Listing>({ path: "", entries: [] });
  const [error, setError] = useState<string | null>(null);
  // Whether dot-directories are shown. The server withholds them, so this is part of the
  // request rather than a filter over the answer.
  const [showHidden, setShowHidden] = useState(false);
  // Branches per repository, fetched once each: the base selector needs somewhere to choose from.
  const [branches, setBranches] = useState<Record<string, Branches>>({});

  // No argument opens the configured starting directory; an explicit path is an absolute
  // directory to browse, which is how "up" and a click on a name both work.
  const open = useCallback(
    (path: string | undefined, hidden: boolean): void => {
      fetchListing({ path, workspace, hidden })
        .then(setListing)
        .catch((e: Error) => setError(e.message));
    },
    [workspace],
  );
  // Opens the start directory once and whenever the context changes; the hidden flag is read at
  // that moment, so a later tick refetches the directory on screen rather than resetting here.
  useEffect(() => open(undefined, showHidden), [open]);

  const show = (next: boolean): void => {
    setShowHidden(next);
    open(listing.path || undefined, next);
  };

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

  return (
    <div className="browser">
      {error && <div className="error-banner">{error}</div>}
      <div className="panes">
        <div className="pane">
          <DirectoryListing
            listing={listing}
            onOpen={(path) => open(path, showHidden)}
            showHidden={showHidden}
            onShowHidden={show}
            showRepoTag
            action={(entry) => {
              const added = selected.some((s) => s.path === entry.path);
              return (
                <button
                  type="button"
                  disabled={!entry.isRepo || added}
                  title={entry.isRepo ? undefined : "not a git repository"}
                  onClick={() => onAdd(entry.path)}
                >
                  {added ? "Added" : "Add"}
                </button>
              );
            }}
          />
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
                    <span className="path">{path}</span>
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
