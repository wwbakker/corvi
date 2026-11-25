/**
 * The kitty images a terminal has been sent, kept across the screen resets a reattach makes.
 *
 * A program that draws kitty graphics uploads an image once under an id and then places it by
 * that id (`a=p`) whenever it redraws — pi's fullscreen mode does. The page resets its xterm on
 * every attach to replay the server's screen, which has no images, and resets the image addon with
 * it — one xterm shows every session, so its store must hold only the shown session's uploads —
 * and that forgets the uploads: the program's next `a=p` would find nothing. So the uploads are
 * taken off the addon before the reset, kept per session, and given back when that session's
 * screen is shown again. They are the page's: a reload or another window starts without them.
 *
 * The addon has no public API for its upload store; the narrow cast follows the precedent of the
 * renderer's cell size in `TerminalPane.tsx`.
 */
import { createContext } from "react";
import type { ImageAddon } from "@xterm/addon-image";

/** One uploaded image, as the addon stores it. */
type KittyUpload = {
  readonly id: number;
  readonly data: Blob;
  readonly width: number;
  readonly height: number;
  readonly format: 24 | 32 | 100;
  readonly compression?: string;
};

type KittyStore = {
  readonly images: ReadonlyMap<number, KittyUpload>;
  readonly storeImage: (id: number, image: Omit<KittyUpload, "id">) => number;
};

const kittyStoreOf = (addon: ImageAddon): KittyStore | undefined =>
  (
    addon as unknown as {
      readonly _handlers?: ReadonlyMap<string, { readonly _kittyStorage?: KittyStore }>;
    }
  )._handlers?.get("kitty")?._kittyStorage;

/** How many sessions' uploads are kept: the panes most recently left. */
const KEPT_SESSIONS = 16;

/** The uploads of the sessions the page has shown, by host session id. Owned by the app root, so
 * a terminal pane that unmounts (another change's page) and mounts again keeps them. */
export class KittyImageShelf {
  readonly #kept: Map<string, readonly KittyUpload[]> = new Map();

  /** Take a session's uploads off the addon before its screen is reset. */
  keep(sessionId: string, addon: ImageAddon): void {
    const store = kittyStoreOf(addon);
    const uploads = store === undefined ? [] : [...store.images.values()];
    this.#kept.delete(sessionId);
    if (uploads.length === 0) return;
    this.#kept.set(sessionId, uploads);
    for (const oldest of this.#kept.keys()) {
      if (this.#kept.size <= KEPT_SESSIONS) break;
      this.#kept.delete(oldest);
    }
  }

  /** Give a session's uploads back to the addon after its screen was reset; answers how many. */
  restore(sessionId: string, addon: ImageAddon): number {
    const store = kittyStoreOf(addon);
    const uploads = this.#kept.get(sessionId) ?? [];
    if (store === undefined) return 0;
    for (const { id, ...image } of uploads) store.storeImage(id, image);
    return uploads.length;
  }
}

/** The app's shelf, for every terminal pane under it. */
export const KittyImageShelfContext = createContext<KittyImageShelf | null>(null);
