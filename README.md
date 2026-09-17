# Corvi

[![CI](https://github.com/wwbakker/corvi/actions/workflows/ci.yml/badge.svg)](https://github.com/wwbakker/corvi/actions/workflows/ci.yml)

**An agent-ready development environment for a change.** Corvi is a local dashboard for a
*change*: the work spanning one or more repositories, plus the worktrees, pull requests, tickets
and builds around it — and the terminals where you and your agents do the work. Everything is
read live from the vendors' own CLIs, so Corvi stores no secrets and owns no copy of their data.

![The Corvi dashboard](docs/images/home.png)

A change begins as an **idea** — a title, a plan, and a conversation with an agent — and becomes
work when you start it: Corvi cuts a branch and worktree per repository and moves the ticket. Its
state lives in one directory per change (`~/corvi/changes/<id>/`), and the archive keeps the
finished ones.

## Install

Corvi runs on macOS and Linux. It needs `git`, `gh`, `az` and `tmux` for the integrations and the
terminals, and [Bun](https://bun.sh) plus Node 24+ to build the page.

```bash
git clone https://github.com/wwbakker/corvi.git
cd corvi
bun install
bun run app:install
```

`app:install` puts a real window on your machine — `~/Applications/Corvi.app` on macOS; a desktop
entry, an icon and a `corvi` launcher on Linux — that starts its own server on a fresh port and
stops it when the window closes. Quitting it never touches a server you started yourself.

To run it from the checkout instead:

```bash
bun run dev          # http://127.0.0.1:4000
```

There is no account and no cloud: Corvi is your machine, your CLIs and your credentials. The
first run has the settings page at `/settings` for the paths and integrations, and
[the manual](docs/manual/install.md) has the details.

## Documentation

- [Installing and running](docs/manual/install.md) — requirements, the app, Linux, uninstalling.
- [Configuration](docs/manual/configuration.md) — the config file, environment variables,
  settings, workspaces.
- [Changes](docs/manual/changes.md) — ideas, repositories, worktrees, states, completing.
- [The interface](docs/manual/interface.md) and [terminals](docs/manual/terminals.md).
- [Integrations](docs/manual/integrations.md) — Jira, Azure DevOps, GitHub, review.
- [Architecture](docs/guides/architecture.md) and the other [guides](docs/README.md), including
  the extension contract and the decisions behind the code.

Corvi grew up as *IWE* (Integrated Work Environment). This release renames everything after it —
environment variables, directories and the app itself — and records why in
[`docs/decisions/corvi-identifiers.md`](docs/decisions/corvi-identifiers.md).

## Development

```bash
bun run dev          # the server, rebuilding the page as you edit
bun test             # the suite (spawns real servers and tmux)
bun run typecheck && bun run lint
```

[`CONTRIBUTING.md`](CONTRIBUTING.md) and [`AGENTS.md`](AGENTS.md) hold the working rules;
[`docs/`](docs/README.md) explains how the documentation is split.

## License

MIT — see [`LICENSE`](LICENSE).
