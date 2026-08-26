import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { FileChange } from "../types.ts";

export type LocalStatus = {
  repo: string;
  name: string;
  worktree?: string;
  files: FileChange[];
  error?: string;
};

/** Which file is being looked at: the repository as well, since two repositories may both have
 * a README.md, and the staged half, since that is a different diff of the same path. */
type Selection = { repo: string; file: string; staged: boolean };

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

/** A diff, coloured the way every tool colours one. Rendered line by line rather than by a
 * library: a unified diff is already a line format, and the whole grammar is five prefixes. */
function Diff({ text }: { text: string }) {
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
}) {
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

/** How a repository is doing, in the two words this list can say: what is uncommitted in it. */
export const summarise = (status?: LocalStatus): { text: string; state: string } => {
  if (!status) return { text: "…", state: "none" };
  if (status.error) return { text: status.error, state: "error" };
  const n = status.files.length;
  return n === 0
    ? { text: "clean", state: "ok" }
    : { text: `${n} change${n === 1 ? "" : "s"}`, state: "pending" };
};

/**
 * Uncommitted work across the change: every repository in one list on the left, the diff of the
 * selected file on the right — an IDE's local-changes window, for a unit of work that spans
 * repositories rather than for one checkout.
 *
 * A repository with nothing uncommitted still gets its heading, because "nothing here" is an
 * answer: a change where one repository is clean and another is not is the normal case, and the
 * absence should be visible rather than inferred from a missing row.
 */
export function LocalPane({ changeId, repos }: { changeId: string; repos: string[] }) {
  const [statuses, setStatuses] = useState<Record<string, LocalStatus>>({});
  const [selected, setSelected] = useState<Selection | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      Promise.all(
        repos.map((repo) =>
          api<LocalStatus>(`/changes/${changeId}/local?path=${encodeURIComponent(repo)}`)
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
  }, [changeId, repos.join("|")]);

  // The diff follows the selection, and is re-read whenever the file changes underneath: the
  // point of the pane is watching your own edits appear.
  const files = selected ? (statuses[selected.repo]?.files ?? []) : [];
  const fingerprint = files.map((f) => `${f.path}${f.index}${f.worktree}`).join("|");
  useEffect(() => {
    if (!selected) return setDiff(null);
    const query = `path=${encodeURIComponent(selected.repo)}&file=${encodeURIComponent(selected.file)}&staged=${selected.staged ? 1 : 0}`;
    api<{ text: string }>(`/changes/${changeId}/local/diff?${query}`)
      .then((r) => setDiff(r.text))
      .catch((e: Error) => setError(e.message));
  }, [changeId, selected?.repo, selected?.file, selected?.staged, fingerprint]);

  return (
    <div className="local">
      <div className="files">
        {error && <div className="error-banner">{error}</div>}
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
