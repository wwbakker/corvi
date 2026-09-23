/**
 * The tabs on a change's page, and which one a URL names. Pure, so the fallback rule can be
 * pinned without a renderer: an id that is not one of the core's pages, and not a tab an
 * extension offered, is the dashboard — a stale URL still shows something rather than a blank
 * page. "Review changes" is an extension tab now, so the URL follows the extension's enablement
 * rather than being core.
 */

/** A tab an extension contributes, as the server lists it for the change's workspace. */
export type ChangeTabInfo = { id: string; title: string; extension: string };

/** The core's page ids. A contributed tab may not shadow one: the core addressed it first. */
const CORE: ReadonlySet<string> = new Set(["dashboard", "plan", "terminals"]);

/** The tabs the nav shows: the core's Dashboard, then the change's Plan, then the extensions'
 * tabs in load order — the review extension's "Review changes" among them when it is enabled. A
 * contributed id that would shadow a core page is dropped. */
export const changeNav = (tabs: ChangeTabInfo[]): { id: string; title: string }[] => [
  { id: "dashboard", title: "Dashboard" },
  { id: "plan", title: "Plan" },
  ...tabs
    .filter((tab) => !CORE.has(tab.id))
    .map(({ id, title }) => ({ id, title })),
];

/** Which page of the change the URL names: a core page, an offered tab, or — anything else,
 * including a tab that has gone, such as review on a workspace that dropped the extension — the
 * dashboard. */
export type ResolvedChangePage =
  | { kind: "dashboard" | "plan" | "terminals" }
  | { kind: "tab"; tab: ChangeTabInfo };

export const resolveChangePage = (page: string, tabs: ChangeTabInfo[]): ResolvedChangePage => {
  if (page === "dashboard" || page === "plan" || page === "terminals") return { kind: page };
  const tab = tabs.find((t) => t.id === page);
  return tab ? { kind: "tab", tab } : { kind: "dashboard" };
};
