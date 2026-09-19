# Code and documentation style

## Names and types

- Use descriptive domain names. `assessWorktreeRemoval` is preferable to `check` or `unsafe`.
  Avoid abbreviations unless they are established domain vocabulary.
- Declare explicit types for function parameters, return values, service interfaces, and
  exported constants whose type is part of the API. Contextually typed callbacks can use their
  declared context. Derive data types from canonical schemas instead of duplicating shapes.
- Prefer readonly records/collections, discriminated unions, and branded identifiers. Avoid
  `any`, unchecked assertions, and generic types that let a caller assert an arbitrary result.
- Effects describe I/O; do not add `Effect` to every operation name. Do not create a sync/async
  pair unless consumers actually need both contracts.

## Functions and modules

- Prefer pure transformations and `const`. Keep mutation private to a service or local algorithm
  when it improves correctness or clarity; do not mutate inputs or returned shared values.
- Use early returns and exhaustive handling of meaningful alternatives. Use named intermediate
  values where they make a decision readable; minimizing variable count is not a goal.
- Group related behavior by concept. A coherent file can contain several operations. Do not
  enforce one function per file or flatten an entire package into unrelated siblings.
- Extract a helper when it names a meaningful operation, clarifies a boundary, or removes actual
  duplication. Similar syntax alone does not justify a shared abstraction.
- Use standard ESM, explicit imports/exports, and `import type` for types. No TypeScript namespace
  blocks. Aliases are acceptable when they make distinct domain meanings clearer.
- Keep public entrypoints intentional and side-effect-free. Internal files import their local
  collaborators directly rather than their own public barrel.

See [architecture](architecture.md) for package placement and [API design](api-design.md) for
public contracts. A file's existing style does not authorize a new dependency exception.

## Browser code

Group UI code by feature, with shared primitives in a clearly named UI directory. Components
render view models and invoke feature actions; request hooks/adapters own typed client calls,
cancellation, and cache updates. Do not construct backend CLI commands in components.

Keep Electron access behind a typed host capability implemented by browser/desktop adapters.
Use named design tokens instead of inventing colors at call sites. Keep user-facing behavior
consistent across hosts; platform differences are deliberate adapter behavior.

## Comments and docs

- Let names and types explain what code does. Use short comments for safety constraints,
  lifecycle/consistency guarantees, intentional tolerances, and surprising external behavior.
- Do not narrate assignments, label every pure function as pure, or explain the history of a
  refactor. Preserve useful constraints when changing code; update them rather than deleting them.
- Do not claim guarantees the implementation does not establish. Put important guarantees in
  tests as well as contracts.
- Guides state current rules. Manuals describe current product behavior. The refactor plan owns
  temporary migration details. Do not duplicate the same rule across all three.
- A package's `AGENTS.md` should briefly list ownership, non-ownership, public entrypoints,
  allowed dependencies, non-obvious invariants, and verification. Link repository-wide guidance.
- TODOs name a concrete missing behavior or decision. Remove completed TODOs and plans instead
  of retaining a narrative archive.
