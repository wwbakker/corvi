import { type JSX, useEffect, useState } from "react";
import type { PageComponent, PageProps } from "../../extension-host/client.tsx";
import { api, del } from "../../app-root/api.ts";
import type { Leftover } from "./shared.ts";

const size = (kb: number): string =>
  kb >= 1024 * 1024
    ? `${(kb / 1024 / 1024).toFixed(1)} GB`
    : kb >= 1024
      ? `${Math.round(kb / 1024)} MB`
      : `${kb} kB`;

/**
 * Directories in the changes root that no longer belong to a change — what a completed one left
 * behind, or one that was never finished. Shown with what is in them, and removed only when you
 * say so: `target/` from a build is rubbish, but a scratch file you wrote there is not.
 *
 * The page half of the leftovers extension: it calls the extension's own routes
 * (`/api/ext/leftovers/…`) through the page's api helpers, and never reached the core's old
 * `/api/leftovers` routes, which are gone.
 */
export function LeftoversPage({ workspace }: PageProps): JSX.Element {
  const [leftovers, setLeftovers] = useState<Leftover[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The page exists per workspace, so the request says which one it is being read as.
  const query = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";

  useEffect(() => {
    api<Leftover[]>(`/ext/leftovers/list${query}`)
      .then(setLeftovers)
      .catch((e: Error) => setError(e.message));
  }, [query]);

  const remove = (leftover: Leftover): void => {
    const name = leftover.name;
    const git = leftover.entries.filter((e) => e.git);
    const warning = git.length
      ? `\n\n${git.map((e) => `${e.name} is a git ${e.git}`).join(", ")}. ` +
        "Anything committed there and not pushed goes with it."
      : "";
    if (!window.confirm(`Delete ${name} and everything in it? This cannot be undone.${warning}`)) {
      return;
    }
    setBusy(name);
    del<Leftover[]>(`/ext/leftovers/list/${encodeURIComponent(name)}${query}`)
      .then(setLeftovers)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(null));
  };

  // Nothing to tidy is the normal state. As a page a click has already happened, so say so
  // rather than render an empty widget; before the first answer, say it is loading.
  if (!leftovers?.length && !error) {
    return (
      <div className="page">
        <p className="hint">{leftovers ? "nothing left behind" : "loading…"}</p>
      </div>
    );
  }

  return (
    <div className="page">
      <section className="widget leftovers">
        <h3>
          Left behind
          <span className="spacer" />
          <span className="summary">
            {leftovers?.length} director{leftovers?.length === 1 ? "y" : "ies"} from changes that are
            done
          </span>
        </h3>
        {error && <div className="error-banner">{error}</div>}
        {(leftovers ?? []).map((leftover) => (
          <div key={leftover.name} className="item-block">
            <div className="item">
              <button
                className="disclosure"
                onClick={() => setOpen(open === leftover.name ? null : leftover.name)}
              >
                {open === leftover.name ? "▾" : "▸"}
              </button>
              <span className="label">{leftover.name}</span>
              <span className="detail">
                {size(leftover.kilobytes)} · {leftover.entries.length} item
                {leftover.entries.length === 1 ? "" : "s"} · {leftover.path}
              </span>
              <span className="spacer" />
              <button disabled={busy === leftover.name} onClick={() => remove(leftover)}>
                {busy === leftover.name ? "Deleting…" : "Delete"}
              </button>
            </div>
            {open === leftover.name && (
              <ul className="files">
                {leftover.entries.map((entry) => (
                  <li key={entry.name}>
                    {entry.name}
                    {entry.directory ? "/" : ""}
                    {entry.git && <span className="tag warn">git {entry.git}</span>}
                  </li>
                ))}
                {leftover.entries.length === 0 && <li className="hint">empty</li>}
              </ul>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}

/** The page, as the page's PageHost renders it. */
export const page: PageComponent = LeftoversPage;
