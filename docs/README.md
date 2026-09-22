# Documentation

## Architecture and implementation status

The guides define Corvi's accepted architecture, and the implementation now matches it: the
application lives in `apps/*`, shared capabilities in `packages/*`, provider integrations in
`integrations/*`, and `bun run boundaries` enforces the declared dependency graph. The
[architecture decisions](decisions/architecture.md) state the selected direction and its limits.
There is no external extension API; the retired custom-extension machinery is gone.

## For contributors and agents

Start with [AGENTS.md](../AGENTS.md) and [CONTRIBUTING.md](../CONTRIBUTING.md).

| Guide | Owns |
| --- | --- |
| [Architecture](guides/architecture.md) | Package responsibilities, dependency direction, runtime and UI composition |
| [API design](guides/api-design.md) | Public capabilities, schemas, errors, examples, review checklist |
| [Effect conventions](guides/effect-conventions.md) | Service construction, execution, state and resource ownership |
| [Style](guides/style.md) | Naming, typing, module organization, comments |
| [Testing](guides/testing.md) | Verification, architecture checks, fixtures and process safety |

Read architecture and API design before changing a public surface. Read local package instructions
when they exist. Historical implementation choices do not override these rules.

## Repository and change contracts

[Repository capabilities and change workflows](design/repositories-and-changes.md) documents the
contracts as implemented: links owned by `changes`, checkout work in `repositories`, the read and
start workflows, the transport contract, and the behavior-test map.

## For users

The manual describes existing user behavior, commands, and file formats. Names such as
`extensionSettings` are current configuration keys, not an architectural endorsement of a plugin
system. Update the manual when behavior changes, not when a target is merely proposed.

- [Installing and running](manual/install.md)
- [Configuration and workspaces](manual/configuration.md)
- [Changes and worktrees](manual/changes.md)
- [Interface](manual/interface.md)
- [Terminals](manual/terminals.md)
- [Integrations and included features](manual/integrations.md)

## Maintaining documentation

- **Guides** are the current rules. Each rule has one authoritative home.
- **Decisions** record a current choice and a short rationale, not a transcript. Owner approval
  is required to change architectural policy; update the relevant guide in the same change.
- **Designs** specify concrete contracts pending implementation. Typecheck examples, link their
  owner, and retire prototypes when the implemented public APIs become authoritative.
- **Plans** contain unfinished implementation work and explicit decision gates. Delete completed
  plans after retaining any necessary current guidance. Git retains history; do not archive it here.
- **Manuals** describe the product, not internal modules or migration strategy.
- **Code comments** explain contracts and non-obvious constraints, not the history of the code.

Use real local links for existing documents. Put proposed paths and API names in code formatting
rather than linking to files that do not exist. Verify links when moving or deleting documentation.
