import { useCallback, useEffect, useState } from "react";
import {
  aborted,
  api,
  post,
  type IntegrationInfo,
  type RepoItems,
  type WidgetItem,
} from "./api.ts";
import { cached, putCached } from "./cache.ts";
import { EditReposDialog } from "./EditReposDialog.tsx";
import { Dot, Item } from "./WidgetRows.tsx";

const worstOf = (items: WidgetItem[]): string =>
  ["error", "pending", "warn", "ok"].find((s) => items.some((i) => i.state === s)) ?? "none";

const nameOf = (repo: string): string => repo.split("/").pop() ?? repo;

/**
 * A card whose rows come from a per-repository component: every repository is fetched on its own,
 * so they appear one by one instead of the card staying empty until the slowest one answers.
 */
export function PerRepoCard({
  changeId,
  info,
  repos,
  onReposChanged,
}: {
  changeId: string;
  info: IntegrationInfo;
  repos: string[];
  onReposChanged: () => void;
}) {
  const key = (repo: string) => `${changeId}:${info.name}:${repo}`;
  // undefined while that repository is still loading; seeded from the cache so coming back to a
  // change shows its last known rows immediately.
  const [items, setItems] = useState<Record<string, WidgetItem[] | undefined>>(() =>
    Object.fromEntries(repos.map((repo) => [repo, cached<WidgetItem[]>(key(repo))])),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const loadRepo = useCallback(
    (repo: string, signal?: AbortSignal): Promise<void> =>
      api<RepoItems>(`/changes/${changeId}/${info.name}/repo?path=${encodeURIComponent(repo)}`, {
        signal,
      })
        .then((r) => {
          putCached(key(repo), r.items);
          setItems((all) => ({ ...all, [repo]: r.items }));
        })
        .catch((e: Error) => {
          if (aborted(e)) return;
          setItems((all) => ({
            ...all,
            [repo]: [{ label: nameOf(repo), detail: e.message, state: "error" }],
          }));
        }),
    [changeId, info.name],
  );

  useEffect(() => {
    // Cancel on unmount: these requests are slow, and the browser only allows six at a time, so
    // leaving them open makes the next page wait seconds for a free connection.
    const ac = new AbortController();
    const tick = () => repos.forEach((repo) => void loadRepo(repo, ac.signal));
    tick();
    const timer = setInterval(tick, 15000);
    return () => {
      ac.abort();
      clearInterval(timer);
    };
  }, [loadRepo, repos.join(",")]);

  const act = (repo: string, actionId: string, arg?: string): Promise<void> => {
    setBusy(repo);
    return post<RepoItems>(`/changes/${changeId}/${info.name}/${actionId}`, { arg })
      .then((r) => {
        putCached(key(repo), r.items);
        setItems((all) => ({ ...all, [repo]: r.items }));
      })
      .catch((e: Error) =>
        setItems((all) => ({
          ...all,
          [repo]: [{ label: nameOf(repo), detail: e.message, state: "error" }],
        })),
      )
      .finally(() => setBusy(null));
  };

  const loaded = repos.filter((r) => items[r]);
  const all = loaded.flatMap((r) => items[r]!);
  return (
    <section className={`widget ${loaded.length === repos.length ? "" : "loading"}`}>
      <h3>
        <Dot state={loaded.length ? worstOf(all) : undefined} />
        {info.title}
        {/* The repository list belongs to the change, and git is the component that shows it. */}
        {info.name === "git" && (
          <>
            <span className="spacer" />
            <button className="icon" title="Edit repositories" onClick={() => setEditing(true)}>
              ✎
            </button>
          </>
        )}
      </h3>
      {/* No summary once everything is in: the rows already say it. */}
      {loaded.length < repos.length && (
        <div className="summary">{`${loaded.length}/${repos.length} repositories loaded…`}</div>
      )}
      {repos.map((repo) =>
        items[repo] ? (
          items[repo]!.map((item) => (
            <Item
              key={item.label}
              item={item}
              busy={busy === repo}
              onAction={(actionId, arg) => act(repo, actionId, arg)}
            />
          ))
        ) : (
          <div key={repo} className="item depth-0 pending-row">
            <span className="toggle-spacer" />
            <Dot />
            <span className="label">{nameOf(repo)}</span>
            <span className="detail">loading…</span>
          </div>
        ),
      )}
      {info.name === "git" && (
        <EditReposDialog
          changeId={changeId}
          open={editing}
          onClose={() => setEditing(false)}
          onSaved={onReposChanged}
        />
      )}
    </section>
  );
}
