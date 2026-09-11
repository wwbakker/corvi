import { CHANGE_STATES, type Change, type ChangeState } from "../core/domain/change.ts";
import type { Widget, WidgetItem } from "../core/domain/widget.ts";
import type { Entry } from "../workspace/model.ts";

export type { Change, ChangeState, Widget, WidgetItem, Entry };
export { CHANGE_STATES };
export type Listing = { root: string; path: string; entries: Entry[] };
export type CardInfo = { name: string; title: string; perRepo: boolean; wide: boolean };
export type RepoItems = { items: WidgetItem[] };
export type RepoState = {
  path: string;
  name: string;
  direct: boolean;
  base?: string;
  unsafe?: { kind: string; text: string };
};

/** A repository chosen for a change: how it will be worked on, and what its branch starts from. */
export type Selection = { path: string; direct: boolean; base?: string };

export type Branches = { branches: string[]; default?: string };

export type Completion = { ready: boolean; reasons: string[]; toMerge: { repo: string; number: number }[] };
export type ProvisionResult = { integration: string; ok: boolean; error?: string };
export type Created = { change: Change; provision: ProvisionResult[] };

/** A completed change, the notes from its own completion steps, and what the `change:completed`
 * after-hooks reported under each extension's name (a failure there never fails the operation). */
export type Completed = { change: Change; notes: string[]; after: ProvisionResult[] };

/** A cancelled change, what cancelling deliberately left behind, and the `change:cancelled`
 * after-hook results. */
export type Cancelled = { change: Change; loose: string[]; after: ProvisionResult[] };

/** Errors carry the response body, so a caller can react to more than the message. */
export type ApiError = Error & { status: number; body: unknown };

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  // A route the server does not have falls through to the app's own HTML, which arrives as a
  // perfectly good 200. Parsing that as JSON produces a browser's idea of a parse error —
  // Safari's is "The string did not match the expected pattern" — and the page then shows it
  // as though the server had said something. It has not: it is out of date.
  if (!res.headers.get("content-type")?.includes("json")) {
    throw Object.assign(
      new Error(`the server has no ${path} — it is probably running older code, restart it`),
      { status: res.status, body: undefined },
    ) as ApiError;
  }
  const body = await res.json();
  if (!res.ok) {
    const message = (body as { error?: string }).error ?? res.statusText;
    throw Object.assign(new Error(message), { status: res.status, body }) as ApiError;
  }
  return body as T;
}

export const patch = <T,>(path: string, body: unknown): Promise<T> =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(body) });

export const put = <T,>(path: string, body: unknown): Promise<T> =>
  api<T>(path, { method: "PUT", body: JSON.stringify(body) });

export const del = <T,>(path: string): Promise<T> => api<T>(path, { method: "DELETE" });

export const post = <T,>(path: string, body: unknown): Promise<T> =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });

/** A request cancelled because its card went away is not an error worth showing. */
export const aborted = (e: unknown): boolean => e instanceof Error && e.name === "AbortError";
