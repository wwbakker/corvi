# Documentation

IWE's documentation is split by **how long it stays true**, so a reader (or an agent) can tell
at a glance what is authoritative and what is work in progress.

- **[`guides/`](guides/)** — durable. How the system is put together and which way to do things.
  Read these to understand the codebase or to make a change.
- **[`decisions/`](decisions/)** — durable and immutable. Why a thing was chosen. A later
  decision supersedes an earlier one; an accepted record is not rewritten.
- **[`plans/`](plans/)** — temporary. Active work: plans, reviews, migration runs. When a plan
  completes, its durable parts are extracted into `guides/` or `decisions/` and the plan is
  deleted — git keeps the history, the tree does not.

Every doc starts with a status header:

```
> **Kind:** guide | decision | plan | review · **Status:** active | accepted | implemented | superseded | historical
```

## Guides

| Document | What it covers |
|---|---|
| [`guides/architecture.md`](guides/architecture.md) | The layers, where a feature's code lives, the dependency rules |
| [`guides/extensions.md`](guides/extensions.md) | The extension contract: every surface an extension can contribute to |
| [`guides/effect-conventions.md`](guides/effect-conventions.md) | The standing contract for server-side code |

## Decisions

| Document | Decision |
|---|---|
| [`decisions/effect-migration.md`](decisions/effect-migration.md) | Server-side `src/` was rewritten to Effect, behaviour-preserving |
| [`decisions/linux-native-window.md`](decisions/linux-native-window.md) | WebKitGTK + PyGObject for the Linux window |
| [`decisions/wt-on-linux.md`](decisions/wt-on-linux.md) | `wt` is Worktrunk; no Linux-specific work needed |
| [`decisions/notifications.md`](decisions/notifications.md) | When a window needs you: suppression, sound, text, batching |

## Plans

| Document | Status |
|---|---|
| [`plans/refactor-plan.md`](plans/refactor-plan.md) | active — prioritized structural cleanup |
| [`plans/extensions-migration-plan.md`](plans/extensions-migration-plan.md) | active — moving the rest of the core behind the extension API |
| [`plans/review-1.md`](plans/review-1.md) | active — architecture review, input to the refactor plan |
| [`plans/review-2.md`](plans/review-2.md) | active — architecture review, input to the refactor plan |
| [`plans/archive/`](plans/archive/) | completed or superseded; kept only until their durable parts are extracted |

## Not documentation

`README.md` at the repository root is the product manual, and `AGENTS.md` is the rules for
working in this repository. Neither is part of the split above.
