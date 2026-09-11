import { type JSX, useEffect, useState } from "react";
import { api, post } from "../../frontend/api.ts";
import type { Change } from "../../core/domain/change.ts";
import { CommitDialog } from "./CommitDialog.tsx";
import type { CommitResult, FileChange, LocalStatus, Selection } from "./shared.ts";

/** The word for a status letter, so a row reads as English rather than as porcelain. */
const statusWord = (letter: string): string =>
  ({
    M: "modified",
    A: "added",
    D: "deleted",
    R: "renamed",
    C: "copied",
    U: "conflicted",
    T: "type changed",
    "?": "untracked",
  })[letter] ?? "changed";

/** The extension's routes live under its own namespace, and the request names the workspace the
 * change belongs to, so the server's git calls inherit the right environment. */
const url = (path: string, workspace?: string): string =>
  workspace ? `${path}${path.includes("?") ? "&" : "?"}workspace=${encodeURIComponent(workspace)}` : path;

/** A diff, coloured the way every tool colours one. Rendered line by line rather than by a
 * library: a unified diff is already a line format, and the whole grammar is five prefixes. */
function Diff({ text }: { text: string }): JSX.Element {
  if (!text.trim()) return <p className="hint">no textual difference — a binary file, or a mode change</p>;
  return (
    <pre className="diff">
      {text.split("\n").map((line, i) => {
        // Order matters: +++ and --- are file headers, not added and removed lines.
        const kind = line.startsWith("+++") || line.startsWith("---")
          ? "meta"
          : line.startsWith("@@")
            ? "hunk"
            : line.startsWith("+")
              ? "add"
              : line.startsWith("-")
                ? "del"
                : line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("new ") || line.startsWith("deleted ")
                  ? "meta"
                  : "context";
        return (
          <span key={i} className={`line ${kind}`}>
            {line || " "}
          </span>
        );
      })}
    </pre>
  );
}

/** One row per changed file: what happened to it, and where it is. */
function FileRow({
  file,
  staged,
  selected,
  onSelect,
}: {
  file: FileChange;
  staged: boolean;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  const letter = staged ? file.index : file.worktree;
  const parts = file.path.split("/");
  // Colour by what happened, not by the letter: a class name cannot be "?".
  const tone = { A: "add", "?": "add", D: "del", R: "move", C: "move", U: "conflict" }[letter] ?? "mod";
  return (
    // The full path in the tooltip, since the row may have had to shorten it.
    <button
      className={selected ? "file selected" : "file"}
      title={file.path}
      onClick={onSelect}
    >
      <span className={`mark ${tone}`}>{letter}</span>
      <span className="name">{parts.pop()}</span>
      {/* The directory is dimmed: two files with the same name are told apart by it, and it is
          not what you are looking for otherwise. */}
      {parts.length > 0 && <span className="dir">{parts.join("/")}</span>}
      <span className="what">
        {staged && <span className="tag">staged</span>}
        {file.from ? `${statusWord(letter)} from ${file.from}` : statusWord(letter)}
      </span>
    </button>
  );
}

/** How a repository is doing: what is uncommitted in it, and what is committed but only here. */
export const summarise = (status?: LocalStatus): { text: string; state: string } => {
  if (!status) return { text: "…", state: "none" };
  if (status.error) return { text: status.error, state: "error" };
  const n = status.files.length;
  const parts: string[] = [];
  if (n > 0) parts.push(`${n} change${n === 1 ? "" : "s"}`);
  // Committed but nowhere else: worth saying even when the working tree is clean, because a
  // clean repository with unpushed commits looks finished and is not.
  if (status.unpushed > 0) parts.push(`${status.unpushed} unpushed`);
  return parts.length === 0
    ? { text: "clean", state: "ok" }
    : { text: parts.join(", "), state: "pending" };
};

/**
 * Uncommitted work across the change: every repository in one list on the left, the diff of the
 * selected file on the right — an IDE's local-changes window, for a unit of work that spans
 * repositories rather than for one checkout.
 *
 * A repository with nothing uncommitted still gets its heading, because "nothing here" is an
 * answer: a change where one repository is clean and another is not is the normal case, and the
 * absence should be visible rather than inferred from a missing row.
 *
 * This is the review extension's change tab; the change it is about and its workspace arrive
 * through the tab contract.
 */
export function LocalPane({
  change,
  workspace,
}: {
  change: Change;
  workspace?: string;
}): JSX.Element {
  const changeId = change.id;
  const repos = change.repos;
  // What people write anyway, so it is there to edit rather than to type.
  const suggestion = change.title ? `${changeId} ${change.title}` : changeId;

  const [statuses, setStatuses] = useState<Record<string, LocalStatus>>({});
  const [selected, setSelected] = useState<Selection | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = (): Promise<(false | void)[]> =>
      Promise.all(
        repos.map((repo) =>
          api<LocalStatus>(url(`/ext/review/changes/${changeId}/local?path=${encodeURIComponent(repo)}`, workspace))
            .then((next) => alive && setStatuses((all) => ({ ...all, [repo]: next })))
            .catch((e: Error) => alive && setError(e.message)),
        ),
      );
    void load();
    // You edit in the terminal or an IDE while this is open; the list has to keep up, and `git
    // status` costs about five milliseconds.
    const timer = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [changeId, repos.join("|"), reload, workspace]);

  // The diff follows the selection, and is re-read whenever the file changes underneath: the
  // point of the pane is watching your own edits appear.
  const files = selected ? (statuses[selected.repo]?.files ?? []) : [];
  const fingerprint = files.map((f) => `${f.path}${f.index}${f.worktree}`).join("|");
  useEffect(() => {
    if (!selected) return setDiff(null);
    const query = `path=${encodeURIComponent(selected.repo)}&file=${encodeURIComponent(selected.file)}&staged=${selected.staged ? 1 : 0}`;
    api<{ text: string }>(url(`/ext/review/changes/${changeId}/local/diff?${query}`, workspace))
      .then((r) => setDiff(r.text))
      .catch((e: Error) => setError(e.message));
  }, [changeId, selected?.repo, selected?.file, selected?.staged, fingerprint, workspace]);

  // Only repositories with something in them: a clean one has nothing to offer the dialog.
  const candidates = repos
    .map((repo) => statuses[repo])
    .filter((s): s is LocalStatus => Boolean(s) && s!.files.length > 0)
    .map((s) => ({ repo: s.repo, name: s.name, files: s.files }));

  // Repositories with commits the remote has not got. A branch that was never pushed counts
  // every commit it has, which is what makes the first push offer itself.
  const behind = repos
    .map((repo) => statuses[repo])
    .filter((s): s is LocalStatus => Boolean(s) && s!.unpushed > 0);
  const unpushed = behind.reduce((n, s) => n + s.unpushed, 0);

  const push = (): void => {
    setPushing(true);
    setError(null);
    setNotice(null);
    post<CommitResult[]>(url(`/ext/review/changes/${changeId}/push`, workspace), { repos: behind.map((s) => s.repo) })
      .then((results) => {
        const failed = results.filter((r) => !r.ok);
        // The failures are the news; the successes are visible in the counts going away.
        if (failed.length > 0) setError(failed.map((r) => `${r.name}: ${r.error}`).join(" · "));
        else setNotice(`pushed ${unpushed} commit${unpushed === 1 ? "" : "s"}`);
        setReload((n) => n + 1);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setPushing(false));
  };

  return (
    <div className="local">
      <div className="files">
        {error && <div className="error-banner">{error}</div>}
        {notice && <div className="notice">{notice}</div>}
        <div className="toolbar">
          <button
            className="create"
            disabled={candidates.length === 0}
            title={candidates.length === 0 ? "nothing to commit" : "commit across the change"}
            onClick={() => setCommitting(true)}
          >
            Commit…
          </button>
          {/* Only when there is something to push: a button that does nothing is a question you
              have to answer every time you look at it. */}
          {unpushed > 0 && (
            <button
              disabled={pushing}
              title={behind.map((s) => `${s.name}: ${s.unpushed}`).join(", ")}
              onClick={push}
            >
              {pushing ? "Pushing…" : `Push ${unpushed}`}
            </button>
          )}
        </div>
        <CommitDialog
          changeId={changeId}
          workspace={workspace}
          open={committing}
          candidates={candidates}
          suggestion={suggestion}
          onClose={() => setCommitting(false)}
          onCommitted={() => {
            setSelected(null); // the file it was showing may be gone now
            setReload((n) => n + 1);
          }}
        />
        {repos.map((repo) => {
          const status = statuses[repo];
          const { text, state } = summarise(status);
          // Staged first, then the rest: that is the order they will be committed in, and a
          // file that is in both appears in both, which is what git means by both.
          const rows = [
            ...(status?.files ?? []).filter((f) => f.staged).map((f) => ({ file: f, staged: true })),
            ...(status?.files ?? [])
              .filter((f) => f.unstaged || f.untracked)
              .map((f) => ({ file: f, staged: false })),
          ];
          return (
            <div key={repo} className="group">
              <h4>{repo.split("/").pop()}</h4>
              <p className="state">
                <span className={`dot ${state}`} />
                {text}
              </p>
              {rows.map(({ file, staged }) => (
                <FileRow
                  key={`${staged ? "s" : "u"}:${file.path}`}
                  file={file}
                  staged={staged}
                  selected={
                    selected?.repo === repo &&
                    selected.file === file.path &&
                    selected.staged === staged
                  }
                  onSelect={() => setSelected({ repo, file: file.path, staged })}
                />
              ))}
            </div>
          );
        })}
      </div>
      <div className="diff-pane">
        {selected ? (
          diff === null ? (
            <p className="hint">loading…</p>
          ) : (
            <Diff text={diff} />
          )
        ) : (
          <p className="hint">select a file to see what changed in it</p>
        )}
      </div>
    </div>
  );
}
