# tmux's own copies reach the system clipboard

> **Kind:** decision · **Status:** accepted

## Context

The terminal is a tmux session with `mouse on`, so the mouse belongs to tmux: a plain drag is
tmux's own selection, and the browser's selection is a modifier away (`shift`-drag on Linux,
option-drag on macOS). Mouse mode cannot simply be turned off — the wheel scrolls tmux's history
*because* tmux owns the mouse; with it off xterm sends the wheel as arrow keys, so it walks the
shell's history instead, and click-to-focus-pane, the right-click menu and the status line stop
working. What was awkward was the second half of a copy: tmux's selection landed in a tmux
buffer, and the system clipboard needed a chord most people never learn.

Two measurements shaped the fix:

- tmux already sends its own copies to the outer terminal as an OSC 52 sequence
  (`ESC ] 52 ; ; <base64> BEL`) — on drag-end, double-click, triple-click and explicit copy
  commands — with the stock `set-clipboard external` as well as with `on`; only `off` suppresses
  it. tmux decides whether the client can take it from the client's terminfo `Ms` capability or
  from a matching `terminal-features` entry.
- xterm.js ignores OSC 52. The page was the missing half.

## Decision

**The page turns tmux's clipboard writes into system-clipboard writes.** `TerminalPane.tsx` loads
the official `@xterm/addon-clipboard` and writes `navigator.clipboard` from its OSC 52 handler.
tmux sends its copies with the selection field empty (`ESC ] 52 ; ; <base64>`), which the protocol
reads as the clipboard, but the addon's stock provider writes only for an explicit `c` — so the
page's provider maps the empty field to the clipboard too, and swallows a failed write (a denied
permission, a clipboard that will not answer) the way the page's own Ctrl+Shift+C already does:
the selection is still on screen, and the promise the addon returns goes back into xterm's
parser, so a failure must not break the input pipeline. No `allowProposedApi` is needed: in
xterm 6.0.0 the parser API is stable (the proposed-API gate covers `markers`, `unicode`,
character joiners and decorations, not `parser`).

**IWE's sessions ask for the clipboard explicitly.** `attachCommand` (src/terminals/server/tmux.ts)
sets `set-option -s set-clipboard on` — a server option, like the extended-keys pair, so the
behaviour does not depend on the user's tmux configuration. `on` rather than `external`: an
application in a pane (an editor's `"+y`, say) can set the host clipboard through tmux, which is
what a terminal that supports OSC 52 normally allows.

**A client whose terminfo lacks `Ms` still gets it.** Immediately after, the attach chain adds
the same feature the user's own tmux configuration adds:

```
if-shell -F '#{m/r:clipboard,#{client_termfeatures}}' '' 'set -as terminal-features ",*:clipboard"'
```

The guard reads the features the attaching client actually resolved, so the list cannot grow an
entry per attach. The append has to run after `new-session -A` (a client has to exist for
`client_termfeatures` to answer), which means it can only take effect from that client's next
attach — moot for IWE, whose pty says `TERM=xterm-256color`, a name tmux's own defaults already
cover.

**Middle-click pastes the system clipboard.** With mouse mode on, a middle click reaches tmux,
whose `MouseDown2Pane` pastes tmux's newest buffer — not the primary selection the README and
cheat sheet claimed. The page now intercepts `mousedown` with `button === 1` in the capture phase
on the terminal host, before xterm's own listener on the inner element, and pastes the clipboard
instead. The web clipboard API exposes no primary selection, so this is the system clipboard, the
same one Ctrl+Shift+V pastes.

The copy contract, in the README and the cheat sheet alike:

| Gesture | Result |
|---|---|
| drag | tmux selection, copied to the system clipboard on release |
| double-click / triple-click | word / line, copied to the system clipboard |
| shift-drag (option-drag on macOS), then ctrl-shift-c / ⌘C | xterm's own selection, copied by the page |
| ctrl-shift-v, or middle-click | paste the system clipboard |
| ctrl-b ] | paste tmux's newest buffer, still separate |
| wheel | tmux copy-mode scrolling, unchanged |

## Alternatives rejected

- **Turning tmux's mouse off** so a plain drag is xterm's selection. It would break the wheel
  (the alternate screen leaves xterm's viewport with nothing to scroll), lose click-to-focus-pane
  and the tmux menus, and need page-side wheel emulation of `copy-mode -e` to recover — more code
  and worse behaviour than one addon.
- **Parsing OSC 52 out of the socket stream** in `session.ts` instead of loading the addon:
  xterm's parser already handles escape sequences across chunk boundaries; a hand-rolled splitter
  is new failure surface for no gain.
- **`set-clipboard external`**, which would keep applications in panes from setting the clipboard.
  The point is a normal terminal's clipboard behaviour, and the user's own configuration already
  uses `on`.

## Consequences

- A copy made in tmux is on the system clipboard the moment the mouse is released; the cheat
  sheet no longer teaches a modifier for the common case.
- The OSC 52 read direction (`pd='?'`) makes the page read its clipboard only when tmux forwards
  a read request, which `get-clipboard` controls; the default does not, and the page's own paste
  chords already hold `clipboard-read`.
- The guarded `terminal-features` append is a no-op on tmux 3.7 with IWE's fixed `TERM`, and the
  fallback it provides for an uncovered client applies from that client's next attach.
- macOS is not measured here (this machine is Linux); the path is browser code plus these tmux
  options, and the guard covers a terminfo without `Ms`.
- `test/terminal.test.ts` drives both copy paths through a real browser: a plain drag and the
  modifier-drag chord, plus Ctrl+Shift+V and middle-click pastes.
