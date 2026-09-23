# Working on Corvi

Corvi is a modular application for a change, its repositories, terminals, and agents. It is not
an extension platform. Favor descriptive names, explicit types, immutable values, and APIs that
can be understood without reading their implementations.

## Read first

- [Architecture](docs/guides/architecture.md): ownership, package layout, allowed dependencies.
- [API design](docs/guides/api-design.md): capability contracts and boundary types.
- [Effect conventions](docs/guides/effect-conventions.md): dependencies, failures, lifetimes.
- [Style](docs/guides/style.md): code and documentation conventions.
- [Testing](docs/guides/testing.md): verification and resource safety.

These guides define the **accepted layout**, and the implementation matches it: the application
lives in `apps/*`, capabilities in `packages/*`, integrations in `integrations/*`, and
`bun run boundaries` enforces the graph. For repository/change work, also read the
[concrete contract design](docs/design/repositories-and-changes.md). Comments and tests are
evidence of behavior; they do not override the target architecture.

## Before implementation

1. Identify the owning package and read its public API. `bun run outline <file-or-directory>`
   prints the current exports without implementations.
2. For a new or changed capability, describe its signatures, errors, dependencies, lifetime,
   and a realistic caller before implementing it. Use the API design checklist.
3. Keep behavior changes separate from structural changes. Internal APIs may be replaced;
   preserve user workflows and safety. Identify data migrations explicitly.
4. Ask before changing package ownership, dependency direction, architectural rules, or
   unresolved product behavior. Do not approve your own exception by editing a guide.

## Non-negotiable boundaries

- Cross-package imports use declared dependencies and explicit public exports, including types.
  No relative imports into another package's source, wildcard internal exports, or package cycles.
- Capabilities own coherent domains; workflows compose them. Storage does not launch agents,
  Git adapters do not render cards, and UI components do not construct backend commands.
- Imports do not read configuration, load integrations, start processes, or initialize mutable
  application state. Layers and application entrypoints own construction and cleanup.
- Required services remain required. Never fall back to real I/O when a service was not provided.
- Domain failures are typed values. HTTP status codes belong at the transport boundary.
- Public values are readonly. Private mutable state has one explicit owner and lifetime.
- Included integrations are ordinary workspace packages. Do not add custom-extension discovery,
  a public plugin SDK, hot-loading, or a universal registry to deliver a feature.
- Do not export implementation helpers solely for tests or add speculative generic frameworks.

## Verification

From the repository root:

```sh
bun run typecheck
bun run lint
bun run test
```

Run the **full suite**, not only selected tests. Use `bun run test`, not bare `bun test`: the
script isolates data and cleans up owned test resources. Report failures and skips honestly.
For documentation changes, also check local links and remove references to deleted guidance.
Do not claim target boundary checks exist before they are implemented.

When the change affects the UI, look at it before calling it done: run an isolated instance and
capture the surfaces (`bun run shot` against it; `CORVI_HEADED=1` when shots come out stale).
Judge what you see as a user would — every control named, nothing truncated into a scrollbar —
and fix the UI when it does not read. A screenshot that contradicts the page is a capture
problem first: a window other windows cover stops painting, and the shot then serves an old
frame. Check the live DOM before distrusting it.

## Safety

- Tests must use isolated change/config/cache paths and a private tmux socket.
- Never stop processes by name, port, or resemblance to a test process. Never use `pkill` or
  an unqualified `tmux kill-server`. Only explicitly owned resources may be stopped.
- Inspect leftovers with `bun run test:clean`. Scope cleanup to the known run; see the testing guide.
- Do not invent paths with the reserved `$TMPDIR/corvi-` prefix; use the test fixtures.
- Do not restart, reinstall, or automate the installed Corvi app to verify a change. Use an
  isolated development/test instance. The installed app may be running from another checkout.
- Never commit unless explicitly asked.

## Documentation maintenance

Keep current rules in the guides and user behavior in the manual; migration work belongs in one
current plan, deleted when complete.
Do not accumulate session narratives, archived plans, or repeated explanations in code comments.
Add a short package-local `AGENTS.md` when a package is extracted: owns, does not own, public
entrypoints, dependencies, invariants, and verification. Link shared rules instead of copying them.
