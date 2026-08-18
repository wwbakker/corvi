import type { Change, Widget, WidgetItem } from "../types.ts";
import type { Issue } from "../integrations/jira.ts";
import type { Entry } from "../repos.ts";

export type { Change, Widget, WidgetItem, Issue, Entry };
export type Listing = { root: string; path: string; entries: Entry[] };
export type IntegrationInfo = { name: string; title: string };
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

export const post = <T,>(path: string, body: unknown): Promise<T> =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });
