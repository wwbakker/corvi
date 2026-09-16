/**
 * The app window's bridge, as the page sees it.
 *
 * `src/domain/host.ts` is the vocabulary both sides speak and `scripts/app/electron/preload.ts`
 * is the other end; this is the page's one reader of it. A real browser has no host, and every
 * caller has to answer for the absence: notifications fall back to the browser's own
 * (src/app-root/notify.tsx), and there is no window chrome to lay the page's top row out as
 * (src/domain/chrome.ts).
 */
import type { CorviHost } from "../domain/host.ts";

export const hostOf = (): CorviHost | undefined =>
  (window as unknown as { corviHost?: CorviHost }).corviHost;
