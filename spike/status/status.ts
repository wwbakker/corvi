/**
 * The consumer half of the status spike: reuse the *real* presenter (`presentWindow`, which
 * merges `agentsWindowPresenter` and the core defaults) and the real notification-edge rule from
 * `apps/server/src/capabilities/watch.ts`, driven by either transport's status map.
 *
 * The presenter is imported by path on purpose — it is the thing being reused, not a copy.
 */
import type { RawWindow } from "../../packages/contracts/src/terminal.ts";
import { presentWindow, type PresentedWindow } from "../../apps/server/src/terminals/server/presenter.ts";

export type StatusRecord = {
  readonly state: "working" | "waiting";
  readonly name?: string;
  readonly message?: string;
  readonly sessionName?: string;
  readonly at: string;
};

/** One live session as a raw tmux-shaped window, with the status merged in as pane options —
 * exactly the shape the real presenter reads. */
export const windowOf = (id: string, status: StatusRecord | undefined): RawWindow => ({
  index: 0,
  name: id,
  command: status ? "node" : "sh",
  active: true,
  activity: false,
  directory: "/tmp",
  named: false,
  id,
  options: status
    ? {
        "@agent_status": status.state,
        ...(status.name ? { "@agent_name": status.name } : {}),
        ...(status.sessionName ? { "@agent_session_name": status.sessionName } : {}),
        ...(status.message ? { "@agent_last_message": status.message } : {}),
      }
    : {},
});

/** The live windows of a change, as the page would draw them, for the given per-session status. */
export const presentedWindows = (
  live: readonly { readonly id: string; readonly status?: StatusRecord }[],
  statusOf: (id: string) => StatusRecord | undefined,
): PresentedWindow[] =>
  live.map((session) => presentWindow(windowOf(session.id, statusOf(session.id))));

export type Notify = {
  readonly change: string;
  readonly window: string;
  readonly label: string;
  readonly note?: string;
  readonly sound: string;
};

/** One presented window together with the change it belongs to: the edge is keyed by both, as
 * `watch.ts` keys it, so the same window id in two changes cannot collide. */
export type ChangedWindow = { readonly change: string; readonly window: PresentedWindow };

/** The attention edges, exactly as `watch.ts` computes them: seeded on the first read, notify
 * only on the edge into `attention`, keyed by `change:windowId`, forgetting windows that are
 * gone. */
export const attentionEdges = (
  previous: Map<string, boolean>,
  seeded: boolean,
  windows: readonly ChangedWindow[],
  sound: string,
): { readonly seeded: boolean; readonly notify: Notify[] } => {
  const notify: Notify[] = [];
  const seen = new Set<string>();
  for (const { change, window } of windows) {
    const key = `${change}:${window.id}`;
    seen.add(key);
    const was = previous.get(key);
    previous.set(key, window.attention);
    if (seeded && window.attention && was === false) {
      notify.push({
        change,
        window: window.id,
        label: window.label,
        ...(window.note ? { note: window.note } : {}),
        sound,
      });
    }
  }
  for (const key of [...previous.keys()]) if (!seen.has(key)) previous.delete(key);
  return { seeded: true, notify };
};

export const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
};

/** A presented window built directly from a status, for edge tests that need the same window id
 * to move from calm to attentive. */
export const presentedFromStatus = (id: string, status: StatusRecord | undefined): PresentedWindow =>
  presentWindow(windowOf(id, status));
