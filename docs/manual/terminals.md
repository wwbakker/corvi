# Terminals

![A change's terminal](../images/terminal.png)

## Sessions and attachment

Each change can have a tmux session named `corvi-<change id>`, started in its change directory on
Corvi's own socket (`-L corvi`). Corvi attaches through node-pty and renders it with xterm.js.

Opening a terminal starts or attaches the session. Opening a dashboard does not. Closing the
page or restarting Corvi detaches the client without losing shells: tmux owns the persistent
session. Completing or cancelling a change explicitly closes its session before archiving it.

This persistence is not a promise to restore processes after a machine reboot or to resume an
agent conversation. Those are separate planned capabilities.

## Windows and navigation

Windows appear under their change in the navigation column. A default label uses the active
pane's directory and running command, such as `example-web - (vim)`. A plain shell adds no
command suffix. Renaming a window with `Ctrl-b ,` keeps your chosen name.

The new-window control, **Cmd-T** on macOS, or **Ctrl-Alt-T** on Linux creates another window in
the current window's directory. In a normal Chrome tab, Cmd-T remains a browser shortcut; the
desktop app can deliver it to Corvi. Keyboard focus stays with the terminal while switching windows.

Use normal tmux commands for windows and split panes; the terminal's cheat sheet lists common
shortcuts. Mouse mode supports scrolling through terminal history. A dot indicates output that
arrived while you were looking elsewhere.

## Agent status and the reporter protocol

An agent can say what it is doing in its pane: **working** or **waiting** for you, who it is, what
the session is called, and the first sentence of its last answer. Corvi uses that instead of the
process name — `node` says nothing, and an idle agent is not counted as active work just because
its process still exists.

The facts are four tmux pane options — the reporter protocol. A reporter is a small plugin inside
the agent; the two included ones are `integrations/pi` and `integrations/opencode`. Only the
reporter in a pane writes these options on that pane, all writes are fire and forget, and tmux
drops the options when the pane dies, so a crashed agent leaves nothing stale behind. Status
belongs to the active pane; an agent in an inactive split is not shown.

| Option | Values | Meaning |
| --- | --- | --- |
| `@agent_status` | `working` \| `waiting` | working: a run is in flight or retrying. waiting: settled and idle — it wants you. |
| `@agent_name` | `pi` \| `opencode` | which agent reports from this pane. |
| `@agent_session_name` | free text | the session's own name, once the agent has one. |
| `@agent_last_message` | free text | the first sentence (at most 180 characters) of the last answer. |

Corvi's window strip reads the options: the session name becomes the window's label, the status
colours the icon and decides whether a notification is owed (the edge from working to waiting),
and the last sentence is the note beside the name. A window whose reporter has not spoken — an old
plugin, a plain shell — is presented as the terminal it plainly is. Anything else may read the
options too (`tmux display -p '#{@agent_status}'`): the protocol is stated here for the included
reporters, not as an extension mechanism for Corvi.

What marks each state, per reporter: pi's `agent_start` is working and `agent_settled` is waiting
(a retry or a compaction is not settled). For opencode, message activity and busy/retry are
working, and idle is waiting; a subagent's own child session says nothing about the window. For
both, an error that wants the user reads as `waiting`, and every option is cleared when the
agent's session ends.

The included reporters are installed into pi and opencode with:

```sh
bun run extension:install:pi         # or: bun run extension:uninstall:pi
bun run extension:install:opencode   # or: bun run extension:uninstall:opencode
```

These commands install Corvi's adapters into the agents; they do not install third-party code into
Corvi. The installation is a symlink to `integrations/pi/src/agent-state.ts` or
`integrations/opencode/src/agent-state.ts`. Installing from another checkout repoints the symlink,
so do not run it as an incidental test. A real file at the destination is left alone. pi picks a
changed reporter up with `/reload` or a new session; opencode takes a restart.

## Keyboard and clipboard

- Shift-Enter, Ctrl-Enter, and their combination are sent using extended key sequences for
  applications that support them. Shift-Tab also passes through.
- Plain mouse selection belongs to tmux. Its copies reach the system clipboard through OSC 52;
  `Ctrl-b ]` still pastes from tmux's own buffer.
- Option-drag on macOS or Shift-drag on Linux selects through the browser terminal instead.
- macOS uses Cmd-C for that selection.
- Linux uses Ctrl-Shift-C / Ctrl-Shift-V; middle-click also pastes. Ctrl-C remains the shell's
  interrupt shortcut.

## Attention notifications

A transition from working to waiting can notify you when you are not actively looking at that
window. Selecting the same change is not enough to suppress it if another view/window is active.
Notification sound is configurable. With no connected page, there is no server-side OS notifier.
Several waiting windows can notify separately; each uses a stable window identity.

## Troubleshooting and safety

To inspect a session from another terminal, name Corvi's socket explicitly:

```sh
tmux -L corvi attach -t corvi-<change-id>
```

A blank browser terminal with a working tmux attachment points to the connection or rendering
path rather than lost shells. Check the correct server's logs and the browser console.

`CORVI_TMUX_SOCKET` can select a specific socket for isolated tests. Never use the user socket as
a fixture. Inside a Corvi pane, inherited `TMUX` points at that server: an unqualified
`tmux kill-server` there would terminate every Corvi session. Follow the contributor
[resource-safety rules](../guides/testing.md#resource-safety) when diagnosing test leftovers.
