# @corvi/markdown

## Owns

The Markdown-as-a-document vocabulary the action and subagent-profile files share: a YAML
frontmatter block and the body below it, parsed totally (`splitFrontmatter`).

## Does not own

The fields a particular document kind knows, its validation, or its rendering. `@corvi/actions`
and `@corvi/agents` own their vocabularies; this package only splits the file.

## Public entrypoints

- `@corvi/markdown/frontmatter`: `splitFrontmatter`, `Frontmatter`

## Dependencies

`yaml`. No Effect, no Node built-ins, no application state.

## Verification

`bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run boundaries`, `bun run test`.
