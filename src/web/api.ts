import { CHANGE_STATES, type Change, type ChangeState, type Widget, type WidgetItem } from "../types.ts";
import type { Issue } from "../integrations/jira.ts";
import type { Entry } from "../repos.ts";

export type { Change, ChangeState, Widget, WidgetItem, Issue, Entry };
export { CHANGE_STATES };
export type Listing = { root: string; path: string; entries: Entry[] };
export type IntegrationInfo = { name: string; title: string; perRepo: boolean; wide: boolean };
export type RepoItems = { items: WidgetItem[] };
export type RepoState = { path: string; name: string; unsafe?: { kind: string; text: string } };
export type Completion = { ready: boolean; reasons: string[]; toMerge: { repo: string; number: number }[] };
export type ProvisionResult = { integration: string; ok: boolean; error?: string };
export type Created = { change: Change; provision: ProvisionResult[] };
export type Board = { issues: Issue[]; sprints: string[]; baseUrl?: string; error?: string };

/** Errors carry the response body, so a caller can react to more than the message. */
export type ApiError = Error & { status: number; body: unknown };

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
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

export const post = <T,>(path: string, body: unknown): Promise<T> =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });

/** A request cancelled because its card went away is not an error worth showing. */
export const aborted = (e: unknown): boolean => e instanceof Error && e.name === "AbortError";
