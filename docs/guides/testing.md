# Testing and verification

## Current commands

Run from the repository root:

```sh
bun run typecheck
bun run lint
bun run boundaries
bun run test
```

The test should take around 1 minute. Set timeout at 3 minutes.

`bun run boundaries` checks the workspace dependency graph declared in `architecture.json`:
decoded imports, declared dependencies, deep imports, relative escapes, and cycles for extracted
packages. Negative fixtures for it live in `test/architecture.test.ts`.

Use the **complete suite** through `bun run test`. The wrapper isolates the changes root,
archive, configuration, and state directory and runs owned-resource cleanup on exit. A focused
test can help development, but is not completion verification. Bare `bun test` does not provide
all wrapper safeguards; do not use it as the final check.

Install dependencies with `bun install --frozen-lockfile`. Browser tests need
`bunx playwright install chromium`; tmux tests need tmux. Report skipped browser/native/platform
checks separately from passes. Do not claim macOS coverage from a Linux run.

The node-pty dependency is pinned for working native prebuilds, including executable permission
on the macOS spawn helper. Before changing that pin, verify spawn, output, resize, and shutdown
under both Node and Electron's Node on the supported platforms. A successful install alone is
not a native-runtime test.

`bun run effect:lint` is available for Effect diagnostics. Do not suppress a diagnostic to hide
an incorrect dependency or error type. Record any existing blockers separately from new failures.

## Target test structure

As packages are extracted, keep unit/adapter tests with their owner and application integration
and browser tests with the apps. Retain one root command that runs **all** suites and preserves
resource isolation. Verify new packages are included in that command and in CI.

- **Pure rules:** validation, state transitions, parsing, safety assessments, and model projection.
- **Capability contracts:** expected failures, absence, cancellation, state isolation, and cleanup.
- **Adapters:** exercise real Git/file/PTY behavior with isolated fixtures; use recorded or fixture
  provider responses by default. Live network tests require explicit opt-in and credentials.
- **Workflows:** test ordered steps, partial failure, retries, conflicting requests, and progress.
- **Transport/client:** request and response encoding, error mapping, malformed input, SSE/socket
  disconnection, origin checks, and cancellation.
- **UI:** preserve current user flows in a real browser; do not substitute implementation snapshots
  for interaction assertions.

Use Layers to supply fakes. An unscripted fake operation fails visibly instead of returning empty
success or falling back to live infrastructure. Prefer Effect test clocks and readiness signals
(Deferred, events, received requests) to arbitrary sleeps. Keep Promise execution in a small test
harness; tests can compose Effects directly without publishing Promise wrappers from production.

## Required architecture checks

These are **refactor deliverables**, not checks already implemented by the current lint config.
`bun run boundaries` already enforces items 1 and 2 for extracted workspaces; the remaining
checks apply as the packages and apps are extracted:

1. Resolved imports obey the package graph, including types and dynamic imports.
2. Undeclared workspace dependencies, deep imports, bypass aliases, and package cycles fail.
3. Public service/model imports perform no application initialization or resource acquisition.
4. Browser/client bundles contain no Node, native, backend, or unintended integration code.
5. Canonical schemas retain identity where reexported; server/client codecs agree.
6. Application/service instances can be constructed twice without shared mutable state.
7. Scope closure releases owned processes, sockets, listeners, and fibers without stopping
   persistent sessions or unrelated resources.
8. Node and Electron's Node resolve the packaged entrypoints and native adapters successfully.

Add negative fixtures: a check that never rejects a forbidden edge is not evidence of enforcement.
Keep the existing lint protection until the replacement covers its boundary.

## Behavior that must remain protected

- An idea does not provision a branch/worktree or move a ticket before work starts.
- Dirty worktrees cannot be removed by confirmation or force; unpushed work is acknowledged and
  its branch retained unless integration into the base is proven. In-place checkouts are not deleted.
- Destructive operations use fresh relevant facts, not stale dashboard answers.
- Completing/cancelling a change retains readable records/documents and reports partial failure.
- Browsing a dashboard starts no terminal. Detaching/restarting the server preserves tmux sessions;
  an explicit completion/cancellation stops only its owned session.
- Workspace configuration, credentials, and cached results do not cross contexts.
- Secrets are masked in client responses and logs; config writes retain owner-only permissions.
- The local HTTP and socket surfaces retain origin/host protections.
- Configuration and data migrations do not silently discard user content.

Add concurrent-update and interrupted-write tests when replacing the store. A read immediately
before a write does not prove atomicity. Treat retry safety and crash recovery as explicit contracts.

## Resource safety

Only ownership authorizes cleanup. Never use `pkill`, kill by port/process name, or an unqualified
`tmux kill-server`. Do not stop or automate the user's installed app to verify a change.

Current fixtures live in `test/helpers.ts`:

- `testRun()` gives a validated run token: two lowercase base36 words separated by a dot.
- `testTempDir(label)` allocates paths the cleaner can attribute to that run.
- `serverEnv(...)` isolates data/cache/config and removes inherited `TMUX`/`CORVI_TMUX_SOCKET`.
- `tmuxTempDir()` keeps socket paths within the Unix socket length limit (103 bytes plus NUL on
  macOS). Every test tmux command names its private socket with `-S`.
- Spawn a test server as Node plus `apps/server/src/server.ts` and `--corvi-test-run=${testRun()}`; preserve
  the ownership marker when the entrypoint moves. Normal app/dev servers have no test marker.

Corvi's user sessions use `-L corvi` unless explicitly configured otherwise. The default tmux
socket is not a test fixture; inside a pane, inherited `TMUX` can point at the user's server.
Never use either for tests. Do not invent unrelated paths under the reserved `$TMPDIR/corvi-`
prefix: the cleaner treats unowned entries there as leftovers.

Inspect first, then clean only the known run:

```sh
bun run test:clean
bun run test:clean --kill --run="$CORVI_TEST_RUN"
bun run test:clean --prune --run="$CORVI_TEST_RUN"
```

Use a nonempty token actually recorded by the run; do not manufacture one to claim ownership.
`--prune` also removes that run's leftover paths. Broad cleanup options are not a substitute for
knowing which resources belong to a run.

## Documentation checks

For documentation changes, check relative links and references to deleted files, inspect the diff,
and run the full verification commands. Proposed paths are code examples, not broken links.
Manuals describe current behavior; architecture guides describe the target until migration is done.
