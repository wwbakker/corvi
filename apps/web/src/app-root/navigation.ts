/**
 * Navigation: the URL is the view, and the leave guard a page publishes before it can be left.
 *
 * `viewOf` and `pathOf` are the one place that knows which URL is which view — the shell, the
 * pages and the guard all go through them — so no component holds a path of its own.
 */
import type { ProvisionResult } from "./api.ts";
import type { Page } from "./Sidebar.tsx";

/** The views, switched by state: a router library would add a dependency to save nothing. */
export type View =
  | { name: "home" }
  | { name: "new" }
  | { name: "actions" }
  | { name: "ext-page"; id: string; extension: string }
  | { name: "settings" }
  | { name: "change"; id: string; page: Page; provision?: ProvisionResult[] };

/** The URL is the view: /new, /changes/<id>[/<page>], /<page> for an extension's page,
 * everything else is home. The change's page segment is kept as it is — the core's `dashboard`
 * and `terminals`, or a tab an extension contributes — and ChangeView resolves an id nobody
 * offers to the dashboard, so a stale URL still renders something. The pages are the server's
 * (`/api/pages`), so a top-level path resolves only once they are known — until then it is
 * home, and the resolution is redone when they arrive. */
export function viewOf(path: string, pages: { id: string; extension: string }[] = []): View {
  if (path === "/new") return { name: "new" };
  if (path === "/actions") return { name: "actions" };
  if (path === "/settings") return { name: "settings" };
  const m = /^\/changes\/([^/]+)(?:\/([^/]+))?/.exec(path);
  if (!m) {
    // A top-level path that names a page the server offered: the extension's own view. A path
    // that is not a well-formed encoding was never a page, and is home.
    if (!path.slice(1).includes("/")) {
      const raw = path.slice(1);
      let id = raw;
      try {
        id = decodeURIComponent(raw);
      } catch {
        return { name: "home" };
      }
      const page = pages.find((p) => p.id === id);
      if (page) return { name: "ext-page", id: page.id, extension: page.extension };
    }
    return { name: "home" };
  }
  const page = m[2] ?? "dashboard";
  return { name: "change", id: decodeURIComponent(m[1]!), page };
}

export const pathOf = (view: View): string =>
  view.name === "new"
    ? "/new"
    : view.name === "ext-page"
      ? `/${view.id}`
      : view.name === "actions"
        ? "/actions"
        : view.name === "settings"
          ? "/settings"
          : view.name === "change"
            ? `/changes/${encodeURIComponent(view.id)}${view.page === "dashboard" ? "" : `/${view.page}`}`
            : "/";

/**
 * A page's leave guard: the view it guards, what it has unsaved, and the one save that ends it.
 * A page with a draft publishes one while it is mounted, and the shell consults it before any
 * navigation — clicks and Back alike. `view` is the guard's configuration: a held Back has
 * already moved the address bar, and the shell puts this view's URL back while the question is
 * pending, knowing no more than the view. `save` is the page's own save, so the prompt's "save
 * and leave" and the page's Save button cannot drift. It resolves to whether the edits were
 * written: on `false` the page explains itself and the user is still there.
 */
export type LeaveGuard = {
  readonly view: View;
  readonly dirty: boolean;
  readonly save: () => Promise<boolean>;
};
