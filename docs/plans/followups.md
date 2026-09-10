# Follow-ups: second cleanup pass

> **Kind:** plan · **Status:** active

The comments from the second review, as a checklist.

| # | Item | State |
|---|---|---|
| 1 | Rename the agent pane options (`@agent_status`, `@agent_session_name`, `@agent_last_message`) | done |
| 2 | Rewrite comments and docs that narrate history into the invariant they protect | pending |
| 3 | Explicit return types everywhere, enforced by typescript-eslint | done |
| 4 | Remove the last Promise facades, then drop the `Effect` suffix (sync siblings get `Sync`) | pending |
| 5 | Add the Effect language service (`@effect/language-service`) | done — `bun run effect:lint`; its findings are a further follow-up |
| 6 | Remove `migrateWorkspaceSettings` and the dead `workspace.jira` field | done |

For item 3, the rule set is `@typescript-eslint/explicit-module-boundary-types` plus
`@typescript-eslint/explicit-function-return-type` with `allowExpressions`,
`allowTypedFunctionExpressions` and `allowConciseArrowFunctionExpressionsStartingWithVoid`; that
is 51 violations today (src 23, test 25, scripts 1, pi 2). Variable-level annotation
(`@typescript-eslint/typedef`) is deliberately not enabled: it fights inference and buys little.

For item 2, the rule is: a comment states the invariant, not the history. "A timed-out CLI is
exit code 124" stays; "the Result-branching contract of the old `sh()`" goes. Migration history
belongs in `docs/decisions/`, not beside the code.
