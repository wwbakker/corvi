# @corvi/agents

## Owns

Corvi-facing agent vocabulary and models: subagent profiles and instances, harness profiles,
scoped discovery, chain resolution, and the Pi agent-directory generator. Pure modules are
browser-safe; OS access stays behind `src/node/**`.

## Does not own

Terminal mechanics (that is `@corvi/terminals`), server wiring or HTTP (apps/server), the
browser page (apps/web), or an agent's SDK types. A harness profile's fields are the contract;
the generator writes the files, the server decides when.

## Public entrypoints

- `./subagent-profile`, `./fields`, `./subagent-profile-discovery`: subagent profiles and their
  documentation
- `./harness-profile`, `./harness-profile-fields`, `./harness-profile-discovery`: harness-profile
  vocabulary, discovery, chains and warnings
- `./environment-generation`: the pure plan (settings, mcp, AGENTS.md, symlinks, resolved view)
- `./harness`, `./instance`, `./presenter`, `./transcripts`: the program launcher and derived state
- `./node`: profile readers, the instance store, transcripts and the generator's I/O

## Invariants

- Parsing is pure and total; discovery skips a malformed file with its reasons.
- Built-in harness-profile ids are chain ends and cannot be replaced by a user file.
- `harness:` names the program; `basedOnHarnessProfile:` names the profile. One key, one meaning.
- The generated plan is the single answer the launch writes and the page shows; names and
  paths resolve against the base agent directory and `~/.agents/skills`.
- Writes are atomic per file and symlinks are swapped by rename.

## Verification

`bun run typecheck`, `bun run lint`, `bun run boundaries`, `bun run test`.
