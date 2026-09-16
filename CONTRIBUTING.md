# Contributing

Corvi is a local dashboard for a *change*: the work spanning one or more repositories, plus the
worktrees, pull requests, tickets, builds and terminals around it. Issues and pull requests are
both welcome.

## Getting set up

You need Node 24+, [Bun](https://bun.sh), `git` and `tmux` (`tmux` is what the terminal tests
run against).

```sh
bun install
bun run dev        # http://127.0.0.1:4000
bun test           # the full suite
bun run typecheck
bun run lint
```

The suite starts real servers and whole tmux servers. If a run is aborted or times out, it can
leave them behind; `bun run test:clean` is the only sanctioned way to end them (see `AGENTS.md`
for why `pkill` is banned here).

## Before opening a pull request

- Run `bun test`, `bun run typecheck` and `bun run lint` — CI runs the same three.
- Keep a change to one thing, and say what it changes and why.
- Durable docs go in `docs/guides/`, decisions in `docs/decisions/` (immutable once accepted),
  and temporary plans in `docs/plans/`. `docs/README.md` explains the split.
- Code follows `docs/guides/style.md`; server-side code follows
  `docs/guides/effect-conventions.md`.

## Reporting a bug

Open an issue with what you did, what happened and what you expected. A screenshot of the page
helps; `bun run shot` writes one to `shots/`.
