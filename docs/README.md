# Documentation

Corvi's documentation is split by **how long it stays true**, so a reader (or an agent) can tell
at a glance what is authoritative and what is work in progress.

- **[`guides/`](guides/)** — durable. How the system is put together and which way to do things.
  Read these to understand the codebase or to make a change.
- **[`manual/`](manual/)** — the product manual: how to install, configure and use Corvi.
- **[`decisions/`](decisions/)** — durable and immutable. Why a thing was chosen. A later
  decision supersedes an earlier one; an accepted record is not rewritten.
- **[`plans/`](plans/)** — temporary. Active work: plans, reviews, migration runs. When a plan
  completes, its durable parts are extracted into `guides/` or `decisions/` and the plan is
  deleted — git keeps the history, the tree does not.

Every doc starts with a status header:

```
> **Kind:** guide | decision | plan | review · **Status:** active | accepted | implemented | superseded | historical
```

## Manual

| Document | What it covers |
|---|---|
| [`manual/install.md`](manual/install.md) | Requirements, running from the source, the installed app, Linux, the move from an older install |
| [`manual/configuration.md`](manual/configuration.md) | The config file and `CORVI_*` variables, the settings page, workspaces |
| [`manual/changes.md`](manual/changes.md) | Ideas, repositories, worktrees, states, actions, completing and cancelling |
| [`manual/interface.md`](manual/interface.md) | Navigation, the dashboard and what the page shows |
| [`manual/terminals.md`](manual/terminals.md) | The Terminals tab, tmux, agents |
| [`manual/integrations.md`](manual/integrations.md) | Jira, Azure DevOps, GitHub, review, notes |

## Guides

| Document | What it covers |
|---|---|
| [`guides/architecture.md`](guides/architecture.md) | The layers, where a feature's code lives, the dependency rules |
| [`guides/style.md`](guides/style.md) | The winning style on each axis, so a change does not have to pick |
| [`guides/extensions.md`](guides/extensions.md) | The extension contract: every surface an extension can contribute to |
| [`guides/effect-conventions.md`](guides/effect-conventions.md) | The standing contract for server-side code |

## Decisions

| Document | Decision |
|---|---|
| [`decisions/azure-devops-extension.md`](decisions/azure-devops-extension.md) | `ci` retires into `github` + `azure-devops`; `deployments` merges into `azure-devops` |
| [`decisions/effect-migration.md`](decisions/effect-migration.md) | Server-side `src/` is Effect, behaviour-preserving |
| [`decisions/electron-host.md`](decisions/electron-host.md) | Electron replaces the Swift and Python windows; one host, one engine |
| [`decisions/corvi-identifiers.md`](decisions/corvi-identifiers.md) | The rename from IWE: one clean break, the name in one file, no migration code shipped |
| [`decisions/host-context-menu.md`](decisions/host-context-menu.md) | The right-click menu: a setting, the host's menu in the app, the page's suppression in a browser |
| [`decisions/directory-browser.md`](decisions/directory-browser.md) | One `repositoriesDirectory`; the browser is unbounded, and the settings picker is its own listing |
| [`decisions/window-titlebar.md`](decisions/window-titlebar.md) | The page's own first row is the window's title bar; the main process keeps only the traffic lights |
| [`decisions/node-server.md`](decisions/node-server.md) | The server runs on Electron's Node; Bun is the development toolchain |
| [`decisions/node-pty-terminal.md`](decisions/node-pty-terminal.md) | node-pty + xterm.js replace ttyd; the dev server runs on Node too |
| [`decisions/tmux-socket.md`](decisions/tmux-socket.md) | Corvi's terminals live on their own tmux socket, named by one builder; every tmux command names its socket |
| [`decisions/terminal-clipboard.md`](decisions/terminal-clipboard.md) | tmux's own copies reach the system clipboard; the page handles OSC 52, middle-click pastes it |
| [`decisions/node-pty-prebuild.md`](decisions/node-pty-prebuild.md) | node-pty is pinned to the 1.2.0 beta: 1.1.0's macOS prebuild ships a spawn-helper without the execute bit |
| [`decisions/linux-native-window.md`](decisions/linux-native-window.md) | WebKitGTK + PyGObject for the Linux window (superseded by electron-host.md) |
| [`decisions/wt-on-linux.md`](decisions/wt-on-linux.md) | `wt` is Worktrunk; no Linux-specific work needed |
| [`decisions/notifications.md`](decisions/notifications.md) | When a window needs you: suppression, sound, text, batching |
| [`decisions/ideation-stage.md`](decisions/ideation-stage.md) | An idea before a change: `Ideation`, a real `start`, `PLAN.md` |

## Plans

| Document | Status |
|---|---|
| [`plans/notes-widget.md`](plans/notes-widget.md) | notes back on the dashboard as a client-drawn widget |
| [`plans/archive/review-1.md`](plans/archive/review-1.md) | input to the refactor plan (now archived) |
| [`plans/archive/review-2.md`](plans/archive/review-2.md) | input to the refactor plan (now archived) |
| [`plans/archive/`](plans/archive/) | completed or superseded, including the refactor plan, the extension slices and their follow-ups |

## Not documentation

`README.md` at the repository root is the front door — what Corvi is and how to install it; the
manual behind it is in [`manual/`](manual/). `AGENTS.md` is the rules for working in this
repository. Neither is part of the split above.
