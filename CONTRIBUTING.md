# Contributing

Corvi is a local development application organized around a change and its repositories,
terminals, and integrations.

## Setup

Use Node 24+, Bun, Git, and tmux. Browser tests also need Playwright's Chromium.

```sh
bun install --frozen-lockfile
bunx playwright install chromium
bun run dev
```

Development serves the app at `http://127.0.0.1:4000`. Do not use the installed app for testing.
Read [AGENTS.md](AGENTS.md) and the [documentation index](docs/README.md) before making changes.

## Design and scope

The [architecture](docs/guides/architecture.md) is the accepted refactor target; adoption is tracked
in the [plan](docs/plans/architecture-refactor.md). Public API changes need an explicit contract,
not just an implementation that satisfies one caller. Keep behavior changes identifiable and
request approval for changes to ownership or dependency rules.

Internal interfaces can change. Preserve user-facing behavior and data unless a change or
migration is explicitly agreed. Tests tied to replaced internals may change; behavioral coverage
must not disappear with them.

## Before reporting completion

```sh
bun run typecheck
bun run lint
bun run boundaries
bun run test
```

Run the complete suite through the script: it isolates data and cleans up owned resources.
For aborted runs, follow [test cleanup](docs/guides/testing.md#resource-safety); never kill by
process name or port. Include failures, skipped platform/browser checks, and reproduction steps
in the report. Check documentation links and keep the manual accurate for any changed behavior.

## Reporting bugs

Describe what you did, expected, and observed. Include the relevant platform and screenshots for
UI issues. Redact credentials, customer data, and private repository details from logs.
