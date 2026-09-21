/**
 * The right-click menu, as the setting wants it (`docs/manual/interface.md`).
 *
 * Two worlds, one setting. In the app the host draws the menu — Electron has none of Chromium's own
 * — and the page tells it what the setting says, since the setting lives in the server's config and
 * the host does not read it. In a browser the page can only take the menu away, which is what "no"
 * means there.
 *
 * Neither touches a page that handles its own right-click: the terminal cancels the event so tmux
 * can draw its menu in the grid, and a cancelled event never reaches the host (nor the browser).
 */
import { useEffect } from "react";
import { hostOf } from "./host.ts";

export function useContextMenu(enabled: boolean): void {
  // The host is told on mount and whenever the setting changes — one-way, like the notification
  // bridge: nothing about a menu is worth the page waiting for. Both hops are optional on purpose:
  // an installed app bundle carries its own preload, so a checkout that has moved ahead of the
  // bundle would otherwise throw on mount and leave a blank window, and a missing menu is the
  // better failure.
  useEffect(() => {
    hostOf()?.setContextMenu?.(enabled);
  }, [enabled]);

  // A browser's own menu is the page's to suppress, and only while the setting says no. In the app
  // this also keeps the click from reaching the host at all, so the two agree by construction.
  useEffect(() => {
    if (enabled) return;
    const stop = (e: Event): void => e.preventDefault();
    document.addEventListener("contextmenu", stop);
    return () => document.removeEventListener("contextmenu", stop);
  }, [enabled]);
}
