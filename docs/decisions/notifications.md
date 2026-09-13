# Decision: notifications when a window needs you

> **Kind:** decision · **Status:** accepted

*The hosts named below (WKWebView, WebKitGTK) were replaced by one Electron window; the behavior
decided here is unchanged, and the bridge it rides is now the preload's `window.iweHost`
(see [`electron-host.md`](electron-host.md) and [`node-server.md`](node-server.md)).*

IWE notifies you when a terminal window wants your attention — an agent that has stopped and is
waiting for you, and (later, out of scope) a generic process going idle. The implementation plan
and phase-by-phase detail are in
[`../plans/archive/notifications-plan.md`](../plans/archive/notifications-plan.md).

## What it does

The `notify` server-sent event fires on the edge into "wants you", decided by the window
presenter (`attention`), diffed keyed by tmux window id so reordering tabs does not fire. What
is sent is the moment itself, not state to refetch.

## Decisions taken (2026-09-10)

- **Suppression**: notify unless you are actually looking at it — its change, its terminals
  page, that window, and a document that is visible and focused. Backgrounded or elsewhere:
  notify.
- **No client connected**: nothing. There is no server-side OS notifier fallback.
- **Sound**: on by default, and configurable — `notificationSound` in the config file, a
  checkbox on the settings page's Notifications tab; only the decision to silence is written
  down.
- **Text**: the session's name, then the first sentence of the last answer (`@agent_say`,
  extracted by the pi extension, capped at 180 characters) or "waiting for you".
- **Many windows**: one notification each, with a stable identifier per change and window so a
  second one replaces its own rather than stacking.
- **Non-agent processes**: out of scope for now.

## Status

All phases are done. The macOS host (`scripts/app/IWE.swift`) and the Linux host
(`scripts/app/linux-window/iwe-window.py`, verified live on Arch/Wayland/Hyprland + quickshell on
2026-09-10) both carry the same `window.webkit.messageHandlers.iwe` bridge. Phase 5 (generic
process attention) remains deliberately out of scope. The implementation detail is in
[`../plans/archive/notifications-plan.md`](../plans/archive/notifications-plan.md).
