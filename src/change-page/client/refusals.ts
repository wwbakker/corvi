import type { ApiError, Completion, CompletionReason, CompletionRefusal } from "../../app-root/api.ts";

/**
 * Reading a failed change action's response. The routes answer a refusal with a structured 409,
 * and these turn that body into what the dialogs render — pure, so the page's wiring is pinned
 * without a DOM.
 */

/** What a failed completion request means: a 409 with reasons is a structured refusal, which
 * opens the override dialog. Anything else — a veto, a CLI failure, an old server — is news for
 * the error banner. */
export function completionRefusal(e: ApiError): CompletionRefusal | undefined {
  if (e.status !== 409) return undefined;
  const body = e.body as
    | { reasons?: CompletionReason[]; toMerge?: Completion["toMerge"] }
    | undefined;
  if (!body?.reasons?.length) return undefined;
  return { reasons: body.reasons, toMerge: body.toMerge ?? [] };
}

/** What a failed cancel means: a 409 naming unpushed commits opens the dialog with one
 * acknowledge. Anything else is news for the error banner. */
export function cancelNeedsForce(e: ApiError): string[] | undefined {
  if (e.status !== 409) return undefined;
  const repos = (e.body as { needsForce?: string[] } | undefined)?.needsForce;
  return repos?.length ? repos : undefined;
}
