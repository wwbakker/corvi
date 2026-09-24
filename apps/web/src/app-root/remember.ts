/**
 * What navigating between screens remembers, but a restart forgets: which of a change's views
 * was last showing, and how far into a remembered document its reader was.
 *
 * Module state on purpose — it lives as long as the page does and is deliberately not
 * persisted. A fresh start opens a change on its Plan again and its documents at the top,
 * which is what "initially" means; within a session, coming back to a change finds it as you
 * left it.
 *
 * Documents carry their own key (`documentKey("plan", id)`), so as more of them grow a memory —
 * notes, review panes — no document reads or overwrites another's place by accident.
 * `forgetChange` drops everything remembered of a change: a created one inherits nothing an old
 * record of its id left behind, and a change that is over keeps nothing after itself.
 */

/** One remembered document: its change's id and its own name, opaque to whoever holds it. The
 * change's id comes first inside the key, so forgetting a change is one prefix. */
export type DocumentKey = string & { readonly document: "document" };

/** The key for one remembered document of a change — the plan today. */
export const documentKey = (name: string, changeId: string): DocumentKey =>
  `${changeId}\u0000${name}` as DocumentKey;

/** Change id → the last view of its own that was showing (never `terminals`: a terminal is a
 * window of the change, not one of its views). Plan until there is a memory. */
const views = new Map<string, string>();

/** Where opening this change's overview lands: its last view, or its Plan the first time. */
export const lastViewOf = (changeId: string): string => views.get(changeId) ?? "plan";

/** Note which view of the change is showing now. */
export const seeView = (changeId: string, page: string): void => {
  views.set(changeId, page);
};

/** Document key → how far down its document the reader was. */
const scrolls = new Map<DocumentKey, number>();

/** Where a remembered document was left scrolled to; undefined when nothing is remembered of
 * it yet — which is not the same as "the top", and must not overwrite a reader who got there
 * first. */
export const scrollOf = (key: DocumentKey): number | undefined => scrolls.get(key);

/** Note how far down a remembered document is now. */
export const seeScroll = (key: DocumentKey, top: number): void => {
  scrolls.set(key, top);
};

/** Forget everything remembered of a change: what an old record of this id left behind must
 * not shape the change being created in its place, and a change that is over — completed or
 * cancelled — leaves nothing running after itself. */
export const forgetChange = (changeId: string): void => {
  views.delete(changeId);
  for (const key of [...scrolls.keys()]) {
    if (key.startsWith(`${changeId}\u0000`)) scrolls.delete(key);
  }
};
