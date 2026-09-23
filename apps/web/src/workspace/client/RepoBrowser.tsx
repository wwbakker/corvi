import { type JSX, useCallback, useEffect, useState } from "react";
import { apiClient, type Branches, type Listing, type Selection } from "../../app-root/api.ts";
import { DirectoryListing } from "./DirectoryListing.tsx";
import { fetchListing } from "./repoListing.ts";

/** Directory browser, unbounded: it opens where the context's repositories directory says and
 * can walk anywhere from there. Browsing and selecting are separate actions on every row,
 * because a directory can be both a repository and a parent of others. How a repository is
 * worked on is two questions per selected repository on the right — where its checkout lives,
 * and which branch it uses — plus what that branch starts from and merges into. */
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
      apiClient
        .branches(path)
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
            {selected.map(({ path, location, branch, base, target }) => {
              const known = branches[path];
              const names = known?.branches.length
                ? known.branches
                : [base ?? known?.default ?? "loading…"];
              const startFrom = base ?? known?.default ?? "";
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
                      value={location}
                      title="a separate checkout, or this repository's own"
                      onChange={(e) =>
                        onChange(path, {
                          location: e.target.value === "original" ? "original" : "new",
                          // A new worktree cannot adopt the branch a source checkout has
                          // checked out: that branch is already live there.
                          ...(e.target.value !== "original" && branch.kind === "current"
                            ? { branch: { kind: "change" as const } }
                            : {}),
                        })
                      }
                    >
                      <option value="new">New worktree</option>
                      <option value="original">In place</option>
                    </select>
                    <select
                      value={branch.kind}
                      title="the branch this work uses"
                      onChange={(e) =>
                        onChange(path, {
                          branch:
                            e.target.value === "current"
                              ? { kind: "current" }
                              : e.target.value === "existing"
                                ? { kind: "existing", name: known?.default ?? names[0] ?? "main" }
                                : { kind: "change" },
                        })
                      }
                    >
                      <option value="change">New branch</option>
                      <option
                        value="current"
                        disabled={location === "new"}
                        title={
                          location === "new"
                            ? "a new worktree cannot use the branch a source checkout has checked out"
                            : undefined
                        }
                      >
                        Current branch
                      </option>
                      <option value="existing">Existing branch</option>
                    </select>
                  </div>
                  {branch.kind === "existing" && (
                    <div className="row">
                      <select
                        className="name"
                        value={branch.name}
                        title="the existing branch to use; a remote-only branch gets a local branch tracking it"
                        onChange={(e) =>
                          onChange(path, { branch: { kind: "existing", name: e.target.value } })
                        }
                      >
                        {names.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="row">
                    {branch.kind === "change" && (
                      <select
                        className="base"
                        value={startFrom}
                        title="the branch this work starts from"
                        onChange={(e) => onChange(path, { base: e.target.value })}
                      >
                        {names.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                    )}
                    <select
                      className="target"
                      value={target ?? ""}
                      title="what a pull request merges into"
                      onChange={(e) => onChange(path, { target: e.target.value || undefined })}
                    >
                      <option value="">(repository default)</option>
                      {names.map((name) => (
                        <option key={name} value={name}>
                          {name}
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
