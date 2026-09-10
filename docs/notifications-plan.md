# Notifications when a window needs you: plan

> Phase 0 verified on macOS; phases 1–3 implemented (server detection, page decision, macOS
> host). Phase 4 (Linux host) needs a Linux machine; phase 5 (non-agent processes) is
> deliberately skipped. The decisions taken are recorded at the end.

## What it does

When a window that can say "I need you" stops working — pi finishing a turn, eventually a long
command finishing — IWE shows a native notification on macOS (the `.app`) and on Linux (the
WebKitGTK window). Not for the window you are already looking at. Clicking the notification
activates IWE, opens the change, and shows that tmux window.

## The shape: server detects, client decides, host displays

Three jobs, deliberately in three places:

1. **Detect** (server). The watcher already polls tmux every 1.5 seconds and already reads
   `@agent`. A transition is one place to get right, and it works for every connected client.
2. **Decide** (page). Only a client knows what is on screen — which change, which window, whether
   the document is even visible. Suppression belongs here, per client.
3. **Display** (host). WKWebView has no Web Notification API (Safari does; an embedding app does
   not), so on macOS the only real path is a script-message bridge into `IWE.swift`. WebKitGTK has
   the same bridge shape, which keeps one protocol across both.

Detection without a connected client does nothing. That is the accepted v1 limit: the app's own
server only runs while the app does, and the app's page is always connected.

## Phase 0 result: verified on macOS (2026-09-10)

A throwaway bundle (`dev.iwe.notify-spike…`, built with `swiftc` exactly like the app, ad-hoc
signed) proved the whole macOS chain:

- the permission prompt appears, and once the right System Settings entry is on,
  `authorizationStatus` reads 2 and `requestAuthorization` grants;
- `add` → `willPresent` shows a banner while the app is frontmost; clicking it delivers
  `didReceive` with `userInfo` intact;
- `didReceive` → `NSApp.activate` → `evaluateJavaScript("window.iwe.openWindow(change, window)")`
  reaches the page, which runs it and posts back through `window.webkit.messageHandlers.iwe`.

Findings worth keeping in mind while building this:

- **Location matters for a spike.** The same bundle run from `/tmp` was refused with
  `UNErrorDomain Code=1 "Notifications are not allowed for this application"` and never prompted;
  from `~/Applications` it prompts normally. The real app already lives in `~/Applications`.
- **Permission is per bundle id and lives in System Settings.** Rebuilding the spike under a new
  id created a second "IWE Notify Spike" entry, and enabling the old one changed nothing;
  `app:install` must keep `dev.iwe.app` stable, and a denied prompt can only be undone in System
  Settings (there is no second prompt).
- `swiftc`'s ad-hoc signature is enough — no team id, no notarisation needed for notifications.
- The `iwe` message-handler name and the `window.iwe.openWindow(change, window)` contract work as
  designed; the notification delegate must be set before the app finishes launching.

Still open on Phase 0: the WebKitGTK half (script-message handler + `Gio.Notification`), which
needs a Linux machine. Nothing in it changes the macOS design.

## 1. A presenter can ask for attention (server vocabulary)

The core never parses `@agent`; the agents extension owns that vocabulary and answers through its
presenter. The same place should say "this window wants the user":

- `WindowPresentation.attention?: boolean` in `src/extensions/api.ts` — "needs you now".
- `TerminalWindow`/`PresentedWindow` gain `attention: boolean` (default false) and
  `merged()` / `presentWindow()` thread it through, exactly like `state` and `busy`.
- `src/extensions/agents/index.ts` sets `attention: agent === "waiting"`.
- Later, other presenters can ask too (a pipeline card, a long build) without the core learning
  their vocabulary.

## 2. The watcher detects edges (server, `src/events.ts`)

Today the pipeline serializes `allWindowsEffect()` per tick and dedupes on the JSON to decide
whether to send the `windows` event. Notifications need the previous *value*, not the previous
string:

- Read the windows once per tick, then derive two things from it: the existing `windows` event
  (dedupe as now) and attention edges — `attention: false → true` for a window that was seen
  before and is seen again.
- **First snapshot is silent.** A fresh watcher (server start, first client) has no previous look;
  everything would otherwise notify on connect. The existing `last.clear()` reasoning applies.
- **Diff by window id, not index.** The tabs can be reordered (drag), and indices change under a
  swap; a window that moves onto a waiting window's old index would otherwise look like a new
  notification. Add `#{window_id}` to the tmux FORMAT and a stable `id` to `TmuxWindow` →
  `PresentedWindow` → `TerminalWindow`. The id also makes the click-through robust: the client
  resolves the current index from the id at click time rather than trusting a stale one.
- **A window that disappears resets**: tmux drops the pane option when the pane dies, so a window
  that comes back starts at `attention: false` and can notify again.

The event carries data — the SSE client already supports `send(event, data)`:

```ts
// event: "notify"
{
  change: "PROJ-1681",      // the change id
  window: "@7",            // tmux window id, stable across reorder
  label: "Build PROJ-1681", // what the tab calls it (session name, or the composed label)
  waiting: true            // the state that asked; only "waiting" for now
}
```

Text is not in the payload: the client composes the title and body, so the server keeps carrying
data rather than presentation.

Dedupe/coalescing server-side is kept minimal; the client handles "already told you".

## 3. The page decides and displays (`src/web`)

- `src/web/events.ts`: `"notify"` joins the event names, and a listener may receive the event's
  data. `changes` and `windows` stay payload-free ("something moved; refetch").
- A `useAttentionNotifications` hook (or a small `<Notifier>` in `App`, which already holds
  `view`, `windows` and `terminals`) subscribes to `notify` and applies the suppression rule:

  **Suppress only when you are actually looking at it**: the view is this change, the page is
  `terminals`, the notified window is the active one, and the document is visible *and* focused.
  If the app is in the background or the page is another change, notify — that is the case the
  feature exists for. (This is the one rule worth confirming before building; the alternative is
  the stricter "never notify for the active tab even if the app is unfocused", which would stay
  silent exactly when a notification helps.)

- Delivery ladder:
  1. `window.webkit?.messageHandlers?.iwe` — the host bridge, on macOS and Linux alike:
     `postMessage({ kind: "notify", id, title, body, change: "PROJ-1681", window: "@7" })`.
  2. `"Notification" in window` — a real browser (the `bun run dev` window): `new Notification`,
     click navigates, permission requested lazily and denied → fall through.
  3. In-app fallback, always available: a toast plus a dot in `document.title`; click navigates.

- Click-through entry point, registered once by `App`:

  ```ts
  window.iwe = {
    openWindow: (change: string, windowId: string) => {
      // resolve the window's current index from the live list, then
      setWantsTerminal(true);
      setView({ name: "change", id: change, page: "terminals" });
      terminals.select(change, index);
    },
  };
  ```

  A host calls `window.iwe.openWindow(...)` after activating the window; the app retries once
  after a navigation if the function is not there yet (page still loading).

- Optional finishing touch: the tab/sidebar entry for a waiting window gets the `attention`
  state from the window list too, so a missed notification still reads as "needs you" on arrival.

## 4. macOS host (`scripts/app/IWE.swift`)

- In `buildWindow()`: `WKUserContentController`, `add(self, name: "iwe")`, set on the
  configuration. `App` conforms to `WKScriptMessageHandler` (`userContentController(_:didReceive:)`).
- On `kind === "notify"`: request authorisation once
  (`UNUserNotificationCenter.requestAuthorization(options: [.alert, .sound])`), build
  `UNMutableNotificationContent` with title/body and `userInfo` (`change`, `window`), and add a
  request with a **stable identifier** (`iwe-<change>-<windowId>`) so a repeat replaces rather
  than stacks, `threadIdentifier` per change.
- `UNUserNotificationCenterDelegate`:
  - `willPresent` → `[.banner, .sound]` (the page already suppresses when focused; this is the
    second belt).
  - `didReceive(response)` → `NSApp.activate(ignoringOtherApps: true)`,
    `window.makeKeyAndOrderFront(nil)`, then
    `web.evaluateJavaScript("window.iwe && window.iwe.openWindow('<change>', '<window>')")`.
- Optional: `NSApp.dockTile.badgeLabel` with the count of waiting windows, cleared on activate.
- Requires `bun run app:install` again.

**Phase 0 was a spike, and it passed on macOS** (see the result section above): the ad-hoc-signed
bundle in `~/Applications` prompts, delivers a banner, and hands the click back to the page. The
fallback (`terminal-notifier`, `osascript`) is only worth keeping in mind if Linux or a future
macOS changes that. The parts that still need care: a stable bundle id across rebuilds, and no
second prompt after a denial — System Settings owns that.

## 5. Linux host (`scripts/app/linux-window/iwe-window.py`)

- Register the same handler:
  `WebKit2.UserContentManager.register_script_message_handler("iwe")` on the view's content
  manager, connect `script-message-received::iwe`. (Check the API name against the installed
  WebKitGTK; the older `register_script_message_handler` and the newer reply-capable variant
  differ.)
- On `kind === "notify"`: send a `Gio.Notification` through the `Gtk.Application`
  (`send_notification`) or libnotify, with a default action that calls
  `self.window.present()` and `self.web.evaluate_javascript("window.iwe && window.iwe.openWindow(...)")`.
- Alternative, if the message handler proves awkward: handle the page's standard
  `Notification` API through the `show-notification` signal. The bridge is preferred, because
  then macOS and Linux run the same client code path.

## 6. Tests

- **Presenter**: the agents presenter sets `attention` only while `waiting`
  (`test/provision.test.ts`, next to the existing `@agent` cases).
- **Edge detector**: pure function tests — first snapshot silent, `false → true` fires,
  `true → true` silent, window gone and back fires again, reorder does not fire
  (id-keyed). A new `test/attention.test.ts`, or beside the events tests.
- **The event end to end**: with a real server and terminal session, an SSE reader sees `notify`
  with the right change/window after `tmux set -p @agent working` then `waiting`; nothing on the
  session's first snapshot; nothing on a reorder. `test/events.test.ts` already drives a server
  and the stream.
- **The page's decision and bridge**: in `test/webkit.test.ts`, inject a stub
  `window.webkit.messageHandlers.iwe` (the CSI-u test already stubs `WebSocket` this way), drive
  `@agent` transitions through tmux, and assert: a message posted when the page is on the
  dashboard; none while that window is the one on screen; none on first load. Click-through is
  testable without a host too: call `window.iwe.openWindow(...)` directly and assert the URL, the
  terminals page and the selected window.
- **Hosts** are not unit-testable in this harness: a short manual checklist per platform
  (notify while backgrounded, permission prompt once, click focuses and navigates, repeat
  replaces the old banner).

## 7. Order of work

| Phase | What | Done when |
|---|---|---|
| 0 | ~~Spike~~ **Done on macOS (2026-09-10)**: prompt, grant, banner, click → `openWindow` verified. WebKitGTK half needs a Linux machine | macOS: verified; Linux: pending |
| 1 | **Done**: `attention` on the presentation, the agents presenter sets it while `waiting`, `@agent_say` published by the extension, window-id-keyed diff in `src/events.ts`, `notify` event | a test sees the event on working→waiting |
| 2 | **Done**: `Notifier` (suppression, delivery ladder, toast), `window.iwe.openWindow`, `notificationSound` setting | a browser notification and a toast, suppressed while looking |
| 3 | **Done in `IWE.swift`** (compiles; needs `bun run app:install` to be in the running app): bridge, authorisation at launch, banner, click → activate + open | manual checklist on the `.app` |
| 4 | **Pending**: Linux host — message handler, `Gio.Notification`, click | manual checklist on the Linux window |
| 5 | **Skipped by decision**: generic process attention (busy → idle) | — |

Phases 1–2 ship a useful thing on their own (in-app and browser notifications); the native
notifications are additive on top.

## 8. Open decisions

- **Suppression rule**: the "visibly looking at it" rule above, or the strict "never when that tab
  is the active tab", even unfocused. The plan assumes the former.
- **No client connected**: do nothing (v1), or have the server fall back to an OS notifier for
  `bun run dev` with no page open.
- **Sound**: on by default, or silent banners.
- **Text**: "waiting for you" for both "finished" and "needs input" — with pi they are the same
  state. A presenter-driven body (if an extension ever wants to say more) is a later hook.
- **Several windows at once**: one banner per window (with stable identifiers so they replace
  their own kind) versus an aggregate; v1 is one per window.
- **Minimum duration for generic processes**: `busy: false` alone would notify for every `ls`;
  phase 5 needs "was busy for more than N seconds" tracked server-side.

## Decisions taken (2026-09-10)

- **Suppression**: notify unless you are actually looking at it — its change, its terminals page,
  that window, and a document that is visible and focused. Backgrounded or elsewhere: notify.
- **No client connected**: nothing. There is no server-side OS notifier fallback.
- **Sound**: on by default, and configurable — `notificationSound` in the config file, a checkbox on
  the settings page's Notifications tab; only the decision to silence is written down.
- **Text**: the session's name, then the first sentence of the last answer (`@agent_say`, extracted
  by the pi extension, capped at 180 characters) or "waiting for you".
- **Many windows**: one notification each, with a stable identifier per change and window so a
  second one replaces its own rather than stacking.
- **Non-agent processes**: out of scope for now.
