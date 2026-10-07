import { type JSX, useCallback, useRef, useState } from "react";
import { ChangeId } from "@corvi/contracts/changes";
import {
  aborted,
  type CardInfo,
  type Change,
  type WidgetItem,
} from "../../app-root/api.ts";
import { changeKey, useChangeClient, useSource, useSourceAvailability } from "../../app-root/sources.ts";
import { gateFailureOf } from "../../app-root/sourceOwner.ts";
import { cached, putCached } from "../../app-root/cache.ts";
import { useCardEditor } from "./CardEditor.tsx";
import { usePolled } from "../../app-root/poll.ts";
import { Dot, Item, Refreshing } from "./WidgetRows.tsx";

const worstOf = (items: WidgetItem[]): string =>
  ["error", "pending", "warn", "ok"].find((s) => items.some((i) => i.state === s)) ?? "none";

const nameOf = (repo: string): string => repo.split("/").pop() ?? repo;

/**
 * A card whose rows come from a per-repository component: every repository is fetched on its own,
 * so they appear one by one instead of the card staying empty until the slowest one answers.
 */
export function PerRepoCard({
  changeId,
  change,
  workspace,
  info,
  repos,
  onSaved,
}: {
  changeId: string;
  /** The change itself, once it has loaded: the editor needs it, the rows do not. */
  change?: Change;
  /** The change's context, for its editor's browser and fetches. */
  workspace?: string;
  info: CardInfo;
  repos: string[];
  /** The editor wrote the change: this is where it goes. */
  onSaved: (change: Change) => void;
}): JSX.Element {
  const client = useChangeClient();
  const source = useSource();
  // Keyed by target generation: a same-id retarget remounts this card, and the fresh mount must
  // read an empty slot rather than the old target's rows from the same change key. The
  // reachability is what holds the per-repository reads back, and `blocked` in the loader's
  // identity restarts the poll on recovery rather than waiting the interval out.
  const availability = useSourceAvailability(source);
  const generation = availability.generation;
  const blocked = availability.status._tag !== "available";
  const key = (repo: string): string =>
    `${changeKey(source, changeId)}@${generation}:${info.name}:${repo}`;
  // undefined while that repository is still loading; seeded from the cache so coming back to a
  // change shows its last known rows immediately.
  const [items, setItems] = useState<Record<string, WidgetItem[] | undefined>>(() =>
    Object.fromEntries(repos.map((repo) => [repo, cached<WidgetItem[]>(key(repo))])),
  );
  const [busy, setBusy] = useState<string | null>(null);
  // The newest load per repository and the newest action, so a slow answer from an older attempt
  // (or an older target) cannot set a row back.
  const loadSeqs = useRef(new Map<string, number>());
  const actSeq = useRef(0);
  const editor = useCardEditor({ info, change, workspace, onSaved });

  const loadRepo = useCallback(
    (repo: string, signal?: AbortSignal): Promise<void> => {
      if (blocked) return Promise.resolve();
      const seq = (loadSeqs.current.get(repo) ?? 0) + 1;
      loadSeqs.current.set(repo, seq);
      const latest = (): boolean => loadSeqs.current.get(repo) === seq;
      return client
        .dashboard.cardRepo(ChangeId.make(changeId), info.name, repo, { signal })
        .then((r) => {
          if (!latest()) return;
          putCached(key(repo), r.items);
          setItems((all) => ({ ...all, [repo]: r.items }));
        })
        .catch((e: unknown) => {
          if (aborted(e) || !latest()) return;
          // A gate transition is the workspace going away, not this repository failing: keep the
          // last known rows and let the banner explain. Genuine/uncertain failures are shown.
          const gate = gateFailureOf(e);
          if (gate !== undefined && gate.kind !== "uncertain") return;
          setItems((all) => ({
            ...all,
            [repo]: [
              { label: nameOf(repo), detail: e instanceof Error ? e.message : String(e), state: "error" },
            ],
          }));
        });
    },
    [changeId, info.name, blocked],
  );

  // The repositories by their content: the array itself is rebuilt on every render, and a new
  // loader identity would restart the poll.
  const loadAll = useCallback(
    (signal: AbortSignal): Promise<unknown> =>
      Promise.all(repos.map((repo) => loadRepo(repo, signal))),
    [loadRepo, repos.join(",")],
  );
  const { refreshing, updated } = usePolled(loadAll, 15_000);

  const act = (repo: string, actionId: string, arg?: string): Promise<void> => {
    // The disabled fieldset keeps the buttons from being clicked while blocked; this is the same
    // rule at the transport seam, so a programmatic call cannot slip through the gate and surface
    // its refusal as the card's error.
    if (blocked) return Promise.resolve();
    const seq = ++actSeq.current;
    setBusy(repo);
    return client
      .dashboard.cardRepoAction(ChangeId.make(changeId), info.name, actionId, arg)
      .then((r) => {
        if (actSeq.current !== seq) return;
        putCached(key(repo), r.items);
        setItems((all) => ({ ...all, [repo]: r.items }));
      })
      .catch((e: unknown) => {
        // Still surfaced: a genuine failure or an uncertain outcome is what the user must see.
        if (actSeq.current !== seq) return;
        setItems((all) => ({
          ...all,
          [repo]: [
            { label: nameOf(repo), detail: e instanceof Error ? e.message : String(e), state: "error" },
          ],
        }));
      })
      .finally(() => {
        if (actSeq.current === seq) setBusy(null);
      });
  };

  const loaded = repos.filter((r) => items[r]);
  const all = loaded.flatMap((r) => items[r]!);
  return (
    <section className={`widget ${loaded.length === repos.length ? "" : "loading"}`}>
      <h3 title={updated}>
        <Dot state={loaded.length ? worstOf(all) : undefined} />
        {info.title}
        {refreshing && <Refreshing />}
        {editor.button}
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
      {editor.dialog}
    </section>
  );
}
