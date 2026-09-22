/**
 * The app window's bridge, as the page sees it.
 *
 * `apps/web/src/domain/host.ts` is the vocabulary both sides speak and `scripts/app/electron/preload.ts`
 * is the other end; this is the page's one reader of it. A real browser has no host, and every
 * caller has to answer for the absence: notifications fall back to the browser's own
 * (apps/web/src/app-root/notify.tsx), and there is no window chrome to lay the page's top row out as
 * (apps/web/src/domain/chrome.ts).
 */
import type { CorviHost } from "../domain/host.ts";

export const hostOf = (): CorviHost | undefined =>
  (window as unknown as { corviHost?: CorviHost }).corviHost;
