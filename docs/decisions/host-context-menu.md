# The right-click menu is the page's setting, drawn by the host

> **Kind:** decision · **Status:** accepted

## Context

The page is opened two ways: in the app's window (Electron) and in a plain browser. A browser shows
its own right-click menu; Electron has none of Chromium's — the host has to draw one — so the same
gesture did two different things, and neither was the page's to decide. The terminal is the third
case, and the one that shaped this: a right-click there is tmux's, which the page arranges by
cancelling the event so tmux can draw its menu in the grid
(`~/changes/make-iwe-content-part-of-title-bar/PLAN.md`).

## Decision

**One setting, `contextMenu`, in the config file, and each side does what it can.** In the app the
host pops a menu — the editing roles where the click landed in a field or on a selection, the link
out of the app through the browser, and the inspector while running from a checkout — and the page
tells the host what the setting says, because the setting lives in the server's config and this
process does not read it (`src/domain/host.ts`; one-way, like the notification bridge). In a browser
the page can only take the menu away, which is what "no" means there; "yes" leaves the browser's own
menu untouched.

**A page that handled its own right-click is untouched in both worlds.** Cancelling the DOM event is
what stops Chromium from asking the browser process for a menu at all, so the host's handler never
fires for the terminal — which is why tmux's menu is not joined by another one. The two menus
therefore cannot appear together, on either platform.

## Consequences

- The setting is one boolean in a file, and it is the *page* that behaves by it, so the two worlds
  agree by construction: the checkbox says "the browser's own menu", and it means the same thing in
  each.
- The host's menu is small on purpose. It is not Chromium's — there is no API for that — so it offers
  the editing roles and, from a checkout, the inspector, rather than pretending to be the browser's
  whole menu. A right-click somewhere with nothing to offer shows nothing, which is also how a
  cancelled click looks.
- The bridge method is called defensively, unlike `notify`: an installed app bundle carries its own
  preload while the page comes from the checkout it was installed from, so a checkout ahead of the
  bundle is a real configuration. There, a missing menu is a better failure than a page that throws
  on mount.
