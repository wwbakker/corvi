# Terminals

![A change's terminal](../images/terminal.png)

Each change has a **Terminals** tab: one tmux session named `corvi-<change id>`, started in the
change directory on Corvi's own tmux socket (`-L corvi`), attached by a pty in the server
(`node-pty`) and drawn by xterm.js in the page itself.

A terminal outlives the server: tmux owns the session and the pty is only one of its clients, so
restarting Corvi — which is constant while working on Corvi itself — detaches and re-attaches without
costing you a shell. Completing a change is what ends a terminal for good.

The connection is made when a terminal is opened, and not before: a dashboard you glanced at
should not leave a session behind. The dashboard cards are unmounted while a terminal is in front —
otherwise their per-repository calls, which occupy every connection the browser allows per
origin, starve the window list's polling. Returning to the dashboard repaints from the cache and
refreshes.

The session's windows are listed in the navigation column, labelled by **where they are** — the
directory of the pane, which is the repository you are in — with **what is running there** in
brackets after it: `example-api`, `example-web - (vim)`. A plain shell adds nothing, so it is
left out. Rename a window (`ctrl-b ,`) and your name replaces the directory, because tmux stops
renaming it for you at that point and so do we.

A window running a **coding agent** says what the agent is doing — `example-api - (pi working)`,
`example-api - (pi waiting)` — instead of `node`, which says nothing. The agent reports that
itself, in the `@agent_status` **tmux pane option**, which the agents extension's presenter reads out
of the same `list-windows` call as everything else. The overview believes it over the process
waiting for you is not work in progress, though its process is very much running.

`pi/agent-state.ts` is that reporter for pi — `agent_start` sets `@agent_status working`,
`agent_settled` sets `waiting`, `session_shutdown` unsets it. Settled rather than ended, because
after `agent_end` pi may still retry, auto-compact or pick up queued messages, none of which are
"waiting for you".

```bash
bun run extension:install     # symlinks it into ~/.pi/agent/extensions/
bun run extension:uninstall
tmux display -p '#{@agent_status}'   # what the pane you are in says about itself
```

A symlink rather than a copy, so editing it here is editing the installed one and `/reload` in pi
picks it up; the script repoints whatever symlink is there, so installing from another branch or
worktree moves it, but leaves a real file at that path alone.

A pane option rather than the terminal title, because the title is shared: pi rewrites it
whenever the session name changes — right after a run, when it names the session from your first
message — and the shell rewrites it between commands, so a marker there would keep vanishing
seconds after it appeared. Nobody else writes `@agent_status`, and tmux drops it when the pane
dies, so a crashed agent leaves nothing stale behind. The option is read from each window's
**active pane**, so an agent left in the inactive half of a split is not seen.

A dot marks a window whose output arrived while you were looking elsewhere, and the strip's **new**
tab — or **cmd-t** (`ctrl-alt-t` on Linux, where the meta key is unreliable) — opens another. The
navigation column lists the windows a change has and nothing else: adding one is the strip's, right
there beside the ones you already have.

A new window starts **where the current one is**, not back in the change directory: a new tab is
almost always "the same place, another thing", and `#{pane_current_path}` is what tmux's own
`ctrl-b c` binding uses anyway. cmd-t works from inside the terminal too, where the keyboard
usually is: the injected key script cannot open a window itself, so it forwards the key to the
page around the frame. In a browser tab Chrome keeps cmd-t for itself; installed as an app it
reaches us — on Linux the chord is ctrl-alt-t for the same reason, and it works in a browser tab
too. The keyboard stays in the terminal throughout: the navigation column's entries refuse
the focus a mousedown would give them, and opening a terminal focuses it, so you can type straight
away. tmux stays the source of truth — the page calls `list-windows`, `new-window` and
`select-window`, so the keys keep working and a session attached from a terminal stays in step.

Windows and panes are yours to make with the usual tmux keys — the **tmux cheat sheet** button in
the terminal's own row lists them — which is also the answer to "how do I get more than one terminal":
tmux does that, Corvi does not duplicate it. Mouse mode is switched on for the session, so the wheel scrolls the
pane instead of walking through shell history; it is set with `-t`, so tmux sessions you started
yourself keep your own settings. A change needs no terminal at all some days and three in one
repository on others, so Corvi opens none for you: opening the terminal is what starts the session.

**Shift-Enter and Ctrl-Enter.** A browser terminal cannot encode these by itself: xterm.js sends a
carriage return for Enter whatever modifier is held — there is no legacy encoding for a modified
Enter, and it implements neither of the modern ones. So the page sends the CSI u sequence
itself instead (`ESC [13;2u` for shift, `;5` for
ctrl, `;6` for both). tmux is started with `extended-keys on`, which passes those through to
applications that ask for them — which is what an application means when it says *"tmux
extended-keys is off. Modified Enter keys may not work."*

Shift-Tab has always worked because it *does* have a legacy encoding (`ESC [Z`), which is the
difference between the two keys.

Copying out: the mouse belongs to tmux while mouse mode is on, and tmux hands its own copies to
the page as an OSC 52 sequence, which the terminal writes to the system clipboard — so a plain
drag (and a **double-click** for a word, a triple-click for a line) is all it takes; the tmux
buffer is separate (`ctrl-b ]` still pastes it). The browser's selection is one modifier away:
**option**-drag on macOS, **shift**-drag on Linux — the modifier xterm.js honours on each
platform, and the terminal turns on `macOptionClickForcesSelection` for the Mac one. On macOS
the browser's own shortcut copies that selection (**⌘C**; the app's Edit menu routes it, as
AppKit did). On Linux there is no menu to route a clipboard shortcut and Ctrl+C belongs to the
shell, so the page takes **Ctrl+Shift+C / Ctrl+Shift+V**, and **middle-click** pastes the
clipboard too; the cheat sheet button lists the keys for the platform you are on.

A terminal that comes up blank: the session is reachable from a normal terminal
(`tmux -L corvi attach -t corvi-<change id>` — the sessions live on Corvi's own socket, so the command
has to name it), which tells you quickly whether the problem is tmux or the browser. After
changing the manifest, reinstall the app — Chrome keeps the old one otherwise.

The socket is also what keeps a stray `tmux` command from reaching Corvi: a bare `tmux` — from a
script, a probe, a test run — resolves to the default socket and finds none of these sessions.
Inside a pane, though, `$TMUX` still names Corvi's server, so a `tmux kill-server` typed there ends
every Corvi terminal; outside a pane it finds nothing.

Completing a change kills its session and the ptys attached to it, since the change directory
moves into the archive underneath it.

