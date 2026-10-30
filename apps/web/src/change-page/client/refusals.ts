import type { Completion, CompletionReason, CompletionRefusal } from "../../app-root/api.ts";

/**
 * Reading a failed change action's response. The routes answer a refusal with a structured 409,
 * and these turn that body into what the dialogs render — pure, so the page's wiring is pinned
 * without a DOM. The value is whatever was thrown: the typed client's `ClientError` and the old
 * `ApiError` both carry `status` and `body`, and anything else is news for the banner.
 */

/** What a failed completion request means: a 409 with reasons is a structured refusal, which
 * opens the override dialog. Anything else — a veto, a CLI failure, an old server — is news for
 * the error banner. */
export function completionRefusal(e: unknown): CompletionRefusal | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const { status, body } = e as { status?: number; body?: unknown };
  if (status !== 409) return undefined;
  const refusal = body as
    | { reasons?: CompletionReason[]; toMerge?: Completion["toMerge"] }
    | undefined;
  if (!refusal?.reasons?.length) return undefined;
  return { reasons: refusal.reasons, toMerge: refusal.toMerge ?? [] };
}

/** What a failed cancel or repository edit means: a 409 naming what would be discarded is the
 * server's force question, one line per reason ("orders: untracked files: build/"), which the
 * dialog asks with one acknowledge. Anything else is news for the error banner. */
export function forceQuestion(e: unknown): string[] | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const { status, body } = e as { status?: number; body?: unknown };
  if (status !== 409) return undefined;
  const { needsForce, reasons } = (body ?? {}) as {
    needsForce?: string[];
    reasons?: { repository?: string; text?: string }[];
  };
  if (!needsForce?.length) return undefined;
  const lines = (reasons ?? []).flatMap((reason) =>
    reason.text ? [reason.repository ? `${reason.repository}: ${reason.text}` : reason.text] : [],
  );
  return lines.length ? lines : needsForce;
}
