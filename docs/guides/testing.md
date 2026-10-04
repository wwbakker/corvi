# Testing and verification

## Current commands

Run from the repository root:

```sh
bun run typecheck
bun run lint
bun run boundaries
bun run test
```

`bun run test` is the complete suite and runs in two passes: the non-browser files across workers
(a few seconds), then the browser end-to-end files one at a time, server-and-browser each (about
two minutes). Allow five minutes for `bun run test`.

For a focused run, the wrapper's modes are available as scripts:

```sh
bun run test:unit         # the non-browser files, across workers
bun run test:e2e          # every browser end-to-end file, one at a time
bun run test:e2e:terminal # the browser end-to-end files named test/terminal*.test.ts
bun run test:e2e:rest     # every other browser end-to-end file
```

`test:e2e:terminal` and `test:e2e:rest` partition `test:e2e`, so together they cover exactly the
same files. The terminal group is a naming convention, not a semantic one: browser files that
merely drive terminal UI (pages, the subagent change page) stay in the rest group. A named group
whose files are all missing fails with exit 3 rather than falling through to the whole suite.

`bun run boundaries` checks the workspace dependency graph declared in `architecture.json`:
decoded imports, declared dependencies, deep imports, relative escapes, and cycles for extracted
packages. Negative fixtures for it live in `test/architecture.test.ts`.

Use the **complete suite** through `bun run test`. The wrapper isolates the changes root,
archive, configuration, and state directory and runs owned-resource cleanup on exit. A focused
test can help development, but is not completion verification. Bare `bun test` does not provide
all wrapper safeguards; do not use it as the final check.

Every `bun test` run is isolated from the real config and change directories either way:
`scripts/test-isolation.ts` (wired in `bunfig.toml`) fills the changes root, archive,
configuration and state directory with a per-run temp root whenever the wrapper has not already
— the same four the wrapper exports, and no more (sockets and caches stay the fixtures' job) —
so a lone `bun test test/foo.test.ts` cannot write `~/.config/corvi/config.json`
(`test/isolation.test.ts` is the tripwire). What a bare run still lacks is the wrapper's shared
per-run root and its cleanup trap.

Install dependencies with `bun install --frozen-lockfile`. Browser tests need
`bunx playwright install chromium`. Report skipped browser/native/platform checks separately from
passes. Do not claim macOS coverage from a Linux run.

One environment trap around the page tests. The bundle one no longer fails silently: page tests
serve the built bundle, so a bare `bun test` after an edit runs `apps/web/dist` as it was — the
page tests refuse a stale bundle (`requireFreshWebBundle`) and name the build that fixes it
(`bun run build:web`; `bun run test` builds).

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

- An idea gets its checkouts at creation and still moves no ticket before work starts.
- Dirty worktrees cannot be removed by confirmation or force; unpushed work is acknowledged and
  its branch retained unless integration into the base is proven. In-place checkouts are not deleted.
- Destructive operations use fresh relevant facts, not stale dashboard answers.
- Completing/cancelling a change retains readable records/documents and reports partial failure.
- Browsing a dashboard starts no terminal. Detaching/restarting the server preserves host sessions;
  an explicit completion/cancellation stops only its owned session.
- Workspace configuration, credentials, and cached results do not cross contexts.
- Secrets are masked in client responses and logs; config writes retain owner-only permissions.
- The local HTTP and socket surfaces retain origin/host protections.
- Configuration and data migrations do not silently discard user content.

Add concurrent-update and interrupted-write tests when replacing the store. A read immediately
before a write does not prove atomicity. Treat retry safety and crash recovery as explicit contracts.

## Resource safety

Only ownership authorizes cleanup. Never use `pkill`, kill by port/process name, or a broad signal
to a process you did not start. Do not stop or automate the user's installed app to verify a change.

Current fixtures live in `test/helpers.ts`:

- `testRun()` gives a validated run token: two lowercase base36 words separated by a dot.
- `testTempDir(label)` allocates paths the cleaner can attribute to that run.
- `serverEnv(...)` isolates data/cache/config for a spawned server.
- `requireFreshWebBundle()` refuses a page run whose built bundle is older than the sources it
  is built from — the silent trap above, made loud; `test/webBundle.test.ts` pins both directions.
- Spawn a test server as Node plus `apps/server/src/server.ts` and `--corvi-test-run=${testRun()}`; preserve
  the ownership marker when the entrypoint moves. Normal app/dev servers have no test marker.

Do not invent unrelated paths under the reserved `$TMPDIR/corvi-` prefix: only
`bun run test:clean --prune --all` treats unowned entries there as leftovers; the default leaks
them rather than guess whose they are.

Inspect first, then clean only the known run:

```sh
bun run test:clean
bun run test:clean --kill --run="$CORVI_TEST_RUN"
bun run test:clean --prune --run="$CORVI_TEST_RUN"
```

Use a nonempty token actually recorded by the run; do not manufacture one to claim ownership.
A bare `--prune` removes nothing — only an explicit `--run="…"` removes that run's leftover paths,
and `--all` is the broad escape hatch. Broad cleanup options are not a substitute for knowing
which resources belong to a run.

## Documentation checks

For documentation changes, check relative links and references to deleted files, inspect the diff,
and run the full verification commands. Proposed paths are code examples, not broken links.
Manuals describe current behavior; architecture guides describe the target until migration is done.
