# Architecture refactor

Status: planned. The documentation establishes the target; the code/package migration has not
started. This is the only architecture migration plan. Follow the [architecture](../guides/architecture.md)
and [API design](../guides/api-design.md), not the structure being replaced.

## Scope and invariants

Replace internal APIs and layout decisively. There are no external extensions to support and no
requirement to preserve an internal import or HTTP route solely for compatibility. Update first-party
consumers together. Preserve user workflows, resource ownership, and useful data; make any behavior
change or data migration explicit before implementation.

Removing out-of-tree extension loading is an approved scope reduction. It does not remove included
features, per-workspace enablement, notes, integration settings, or the Pi reporter. Do not rename
on-disk `extensions`/`extensionSettings` fields merely as a mechanical code cleanup.

Keep the current Effect 3 / React / Node/Electron / Git / tmux stack and file-backed storage. Do not
combine this work with an Effect major upgrade, database conversion, or new agent features.

## 1. Establish the executable baseline

- [x] Run and record the full typecheck, lint, and test baseline, including skips/platform gaps.
      `bun run typecheck`, `bun run lint` and `bun run boundaries` pass; the full suite is
      593 pass / 1 skip / 0 fail across 64 files (the skip is the Electron runtime test).
- [x] Identify behavior tests for creation/start, review, completion/cancellation, settings,
      documents, integrations, terminal survival, and process cleanup. The coverage map lives in
      docs/design/repositories-and-changes.md ("Existing coverage to preserve").
- [x] Separate behavior assertions from tests tied to global registries, private exports, and
      custom-extension loading. Plan replacement coverage before deleting coupled tests.
      The loader/registry is gone; selector tests assert the included integrations, and the pure
      rules (matchRoute, visibleChangeTabs, plannedCompletionSteps) carry the rest.
- [x] Author representative contracts and typechecked callers for repository queries, change
      associations/storage, working-directory resolution, and the lifecycle/terminal boundary.
      `packages/contracts` plus the design prototypes under docs/design/repositories-and-changes
      are the typechecked callers.
- [x] Owner review of the contracts, dependency graph, and deliberate behavior differences before
      moving files or starting package implementation. Reviewed and accepted by the owner.

The [repository/change design](../design/repositories-and-changes.md) is the step-1 deliverable.
It contains the behavior-test map and minimum next slice. Implementation baseline `3391c8d`:
typecheck and lint pass; full suite 489 pass, 1 skip (Electron binary absent), 0 fail, about 47s.
The design adds typechecked prototypes under `docs/design/repositories-and-changes/`, not
implemented Git/storage adapters or prototype tests. No production code or package manifests have
changed. Re-run the baseline before implementation if the checkout changes.

Deliverable: an agreed graph and readable interfaces, not a new collection of barrels around the
same implementation dependencies.

## 2. Establish workspaces and enforce boundaries

- [x] Configure `apps/*`, `packages/*`, and `integrations/*` workspaces, shared dependency versions,
      explicit package exports, and per-package TypeScript checks.
- [x] Add a checked dependency graph: no cycles, undeclared dependencies, deep imports, or bypass
      aliases. Include negative fixtures and type-only/dynamic import coverage.
- [x] Add browser import/bundle isolation and Node/Electron package-resolution smoke tests.
      Contracts bundle and Node resolution are covered in `test/contracts.test.ts`;
      `test/bundle.test.ts` builds the page and asserts no Node builtin reaches the browser
      bundle. Electron resolution remains the documented skip in `test/node-runtime.test.ts`.
- [x] Keep one root verification command running every package/app test with owned-resource cleanup.
      Change CI and the PR checklist to use the safe test wrapper rather than bare `bun test`.
- [x] Extract canonical shared boundary schemas without pulling runtime code into contracts.

Do not scaffold empty integrations or weaken current lint rules before replacement checks exist.

## 3. Build a reference capability slice

- [x] Extract worktree inspection/parsing behind `repositories`' public API.
- [x] Separate Git facts from change-directory selection and dashboard presentation.
- [x] Supply process/filesystem dependencies through Layers; no optional live fallback.
- [x] Extract the change-owned association projection/update and migrate association data explicitly
      before enabling directory-bound workflows. Created and adopted worktrees both retain a path;
      unresolved legacy ownership must not become automatic cleanup authority. The store writes a
      legacy-compatible record: `repositories` materializes on write, `repos`/`direct` stay in
      sync from it, and the legacy fields win when the old app edits them, so one record serves
      both readers. The legacy writer materializes the same links on its own writes (and strips
      them from its in-memory value), so the field is maintained whichever half touched the
      record; a terminal transition archives the directory. Enabling the new write paths is the
      remaining step.
- [x] Connect one existing dashboard use case through a workflow and typed endpoint/client contract.
      The read is served from the legacy projection, driven end to end by
      `test/repositoriesEndpoint.test.ts`, and consumed in the browser by the change page's
      `CheckoutsCard` (`test/pages.test.ts`).
- [x] Test pure rules, the real Git adapter, the API boundary, and the existing UI behavior. Pure
      rules, the file store, the workflows, the real Git adapter, the legacy projection, the client,
      and the server/client contract all have tests; the existing UI suite still passes.
- [x] Add concise package instructions and use this slice as the example for remaining extractions.

Start with inspection rather than deletion: prove the boundary without changing destructive policy.

## 4. Make construction and state ownership explicit

- [x] Replace import-time configuration reads and mutable exported configuration with a snapshot
      service. Preserve precedence, masking, workspace isolation, and immediate settings updates.
      `src/workspace/server/config.ts` no longer exports a mutable `config` or reads the file at
      import: it exposes `readConfig()`, `reloadInto(target)` and the migrator hook. The runtime
      (`src/capabilities/runtime.ts`) owns the one snapshot — `runtimeConfig()`, created on first
      use or installed via `setRuntime`, refilled in place by `reloadConfigSync`/`reloadConfig`
      so object identity survives and a settings write takes effect immediately.
      `workspace/server` re-exports the accessors, every reader (including the tests and
      `SettingsLive`, which now defers its read to layer construction) goes through the runtime,
      and precedence/masking/isolation/live-updates are pinned by `test/settings.test.ts` and
      `test/instances.test.ts`, both green.
- [x] Construct caches, integration instances, and registries inside Layers, not module singletons.
      **The cache and the config snapshot are instances the runtime owns**: `server.ts` constructs
      the cache, restores it, and installs it with `setRuntime`; the snapshot is created there and
      refilled in place on writes. `capabilitiesLayer` reads both through
      `runtimeCache()`/`runtimeConfig()`, and the holder is the assembly seam for plain-function
      call sites. Tests cover two cache instances sharing nothing, the installed cache being used
      by a request, and two server instances sharing nothing. **The included-integration list
      stays a static composition value** (`loaded` in `src/integrations/loaded.ts`): moving it
      through the runtime closed a cycle (runtime → loaded → extensions → the config accessor →
      runtime) and added no behavior; the explicit list is the composition step 6 retains, with
      no registry or factory to own.
- [x] Assemble runtime services and included integrations explicitly at the server entrypoint.
      `server.ts` constructs the cache, restores it, installs the runtime (which builds the config
      snapshot), composes every route table and the websocket wiring, and only then listens. The
      included integrations are the static composition in `src/integrations/loaded.ts` — ordinary
      imports, nothing discovered and nothing constructed at import time. Routes read the runtime
      through `runtimeCache()`/`runtimeConfig()`; threading it as a parameter instead is a further
      refactor this item does not require.
- [x] Separate notification/watch policy from event transport; scope and cancel all watchers.
      `src/capabilities/watch.ts` owns the policy: the sources (change files, tmux windows), the
      1.5s cadence, the dedup state, and the attention edges, exposed as `watch(sink)` and
      `forgetWatchedNews` for an action that changed the world itself. `src/capabilities/bus.ts`
      is the transport: connections, the 5s heartbeat, SSE framing, and the ref-count that forks
      the watch on the first listener and interrupts it on the last. `test/events.test.ts` pins
      the lifecycle — the watcher runs only while a page is listening and stops when it goes.
- [x] Separate terminal-session ownership from request/PTY attachment ownership.
      `src/terminals/server/tmux.ts` owns sessions: named per change, persistent, stopped only by
      the lifecycle's `TerminalSessions` port. `src/terminals/server/session.ts` owns one pty per
      connection: killed on socket close or a failed upgrade, and now registered with the
      attachment owner so the server's shutdown closes them (`closeAttachments()` from
      `server.ts`'s signal handler) while the tmux sessions and their shells survive. The module
      index deliberately does not re-export the socket bridge. `test/terminal.test.ts` pins the
      split: a terminal outlives the server (and after the restart its session has exactly one
      client), and closing the page detaches the pty but keeps the session.
- [x] Prove independent application instances and scoped shutdown in tests. `test/instances.test.ts`
      boots two servers with their own changes root, config, state and cache directories: a change
      written to one is invisible to the other, each reports its own config path, and stopping one
      leaves the other serving its own state. The remaining ownership work (snapshot, Layers,
      watchers, terminal sessions) is what the other step-4 items cover.

## 5. Extract remaining capabilities and workflows

| Current area (migration locator only) | Destination/responsibility |
| --- | --- |
| `domain/*`, shared `model.ts`, route DTOs | Canonical public contracts; private models stay with owners |
| `workspace/server`, `settings/server` | Configuration/workspace capability; HTTP/UI stay in apps |
| `change/server/store`, schema, plan/notes storage | Changes capability with explicit consistency and codecs |
| `change/server/create`, start, complete, cancel, description | Pure change rules plus application workflows; no provider I/O in the store |
| `vendors/git`, repository review operations | Repository/worktree capability, pure parsing, Git adapter |
| `terminals/server` | Terminal capability and isolated tmux/PTY adapters |
| `vendors/github`, `vendors/stacks`, included vendor code | GitHub/Jira/Azure integrations, with provider ports supplied by composition |
| `dashboard/server`, lifecycle contribution orchestration | Workflow/read-model composition, not a generic plugin host |
| `app-root`, feature clients, extension clients, wizard | Web shell and feature directories consuming the typed client |
| `server.ts`, routes, SSE/socket hosting | Server application; transport adapters call workflows |
| `scripts/app/electron`, platform installers | Desktop host and packaging scripts |
| `pi/agent-state.ts`, agent presentation | Pi integration and agent status contracts; keep actual reporting behavior |

- [x] Replace HTTP-shaped internal errors with domain errors and boundary mapping.
      `packages/*` construct none — `@corvi/changes` and `@corvi/workflows` use their own tagged
      domain errors. In the app, creating and hand-editing a change now fail with
      `src/change/errors.ts`'s `InvalidChangeDraft` / `ChangeAlreadyExists` / `InvalidChangeEdit`,
      and `src/change/routes.ts`'s `changeError` is the one place their status is decided (409 for
      a taken id and for an edit against where the change stands, 400 otherwise). The remaining
      taxonomy constructions in `src/change/server/*` are boundary mappers for the lifecycle's
      typed `Readiness`/`Transition` values and provider failures (`CliError`), where a CLI/HTTP
      error is the honest shape. The two internal "could not be read back" invariants now fail
      `InternalError` (500), not a 400.
- [x] Protect concurrent change updates and interrupted file writes; test guarantees explicitly.
      Interrupted file writes: `writeAtomic` uses a unique temp per write and cleans it up on
      failure; the legacy change record now writes through it too, and `test/files.test.ts` pins
      both guarantees. Concurrent updates: the record carries a `revision` (in the wire schema
      and the domain type), the new store's `patch` compares the caller's `expectedRevision`
      under its lock and fails `ChangeConflict` rather than overwriting, `ChangeService` passes
      the revision it read, and the legacy store bumps the revision on every write so a
      transition that raced an edit conflicts instead of clobbering it. Tested in
      `packages/changes/test/store.test.ts` (stale writer, four concurrent transitions → one
      winner) and `test/changes.test.ts` (revision moves on a legacy write). Caveat, recorded in
      the store comment: two concurrent legacy edits remain last-writer-wins, and there is no
      cross-process locking.
- [x] Migrate create/start/complete/cancel as callable workflows, preserving step ordering and
      partial-failure reporting. Keep force/acknowledgement and dirty-worktree protections.
      `ChangeLifecycle` exists in `@corvi/workflows/lifecycle` with scripted-port tests, and
      **cancel and complete now run through it** in the app: `src/change/server/cancel.ts` and
      `src/change/server/complete.ts` map the HTTP shapes (force question, veto, loose ends,
      after notices, the `completion.json` progress bridge) onto the workflow through the cutover
      adapters in `src/change/lifecycle-layer.ts`; the existing cancel/ideation/completion tests
      pass; **start now runs through it too** (`src/change/server/start.ts` maps the HTTP shape,
      drops browse links, copies tooling, and calls the Jira ticket move through the named
      `moveIssueOnStart` export, gated on the workspace's Jira enablement). **Create provisioning
      is explicit as well** (`src/change/provisioning.ts` replaces the git `change:created`
      hook), and the completion plan/run and loose-end lookups call named integration functions
      (`planIssueCompletion`/`moveIssueOnComplete`/`jiraLooseEnds`, `planIssueClose`/
      `closeIssueOnComplete`, `prLooseEnds`). A single `plannedCompletionSteps` in the adapters
      plans for both the workflow port and the app journal, so the two cannot disagree about
      which steps exist. **The lifecycle hook contract is gone**: the `events`,
      `completionSteps` and `looseEnds` extension fields, `applyCreatingHooks`/`beforeChange`/
      `afterChange`/`provision`/`startWork` and their selectors were removed, along with the
      built-ins' declarations and the coupled tests. The included integrations are the whole
      lifecycle surface. The contributor surfaces followed: `titleSources`, `descriptionSections`,
      `summaryContributions` and `windowPresenters` are gone from the contract too, and
      `src/integrations/overview.ts` composes the included jira/github-issues/github/azure-devops
      contributors explicitly (enablement-gated, in load order); the terminal presenter is the
      agents integration's direct import. **The host is gone too**: the surfaces live on the
      included integrations' fields (`src/integrations/included.ts`), the registry is a fixed
      normalization of that list, discovery/factories/client-chunks/`extensionPaths` and the
      out-of-tree tests were deleted, and `src/integrations/types.ts` holds the surface types
      (no public contract). All four operations run through the workflows; the cutover adapters
      in `src/change/lifecycle-layer.ts` are the included integrations' port implementations.
- [x] Replace caller-selected `api<T>` casts and route-body casts with authoritative codecs and
      named client methods. Generated clients are optional; duplicate schemas are not.
      **Route bodies are decoded** (`bodyAs` in `src/capabilities/effect/body.ts`; create, patch,
      plan, repos, cancel, complete, card actions, notes, review, azure deploy, terminal windows,
      settings) with no `as` casts left, and the create/force bodies are the canonical contract
      schemas. **Every browser call is a named method**: `packages/client` exposes the change
      reads and writes (`create`/`start`/`complete`/`cancel`/`rename`/`setRepositories`/
      `cardAction`/`cardRepoAction`/`windowAction` included), settings, workspaces, terminals,
      wizard, pages and the directory browser — all decoded against contract schemas, with
      `ClientError.body` carrying a structured 409 so the dialogs read server truth. Extension
      browser halves own their DTO schemas (notes, leftovers, github-issues, jira, review, azure)
      and use `makeWireClient` for the same transport classification. No `api<T>`/`post<T>` call
      site remains outside the retired generic helpers in `src/app-root/api.ts`.
- [ ] Move UI to feature ownership; keep host access behind a typed platform interface.
      Feature halves exist and the host is gone: each included integration ships its client half
      (`src/extensions/*/client.tsx`) next to its server half, the change page/settings/wizard
      own their components, and browser network access goes through `@corvi/client`'s typed
      operations. The owner-package extraction has started: `@corvi/terminals` now owns the pure
      keyboard model (`./model`), the tmux operations over an app-supplied host (`./tmux`), and
      the pty attachment lifecycle over an app-supplied spawner (`./session`); the terminal wire
      types (`TmuxWindow`, `WindowPresentation`, `TerminalPresenter`) live in
      `@corvi/contracts/terminal`. `@corvi/configuration` owns the config vocabulary (`./config`:
      `Workspace`, `Config`, the file shape and defaults) and the settings precedence chain
      (`./settings`); the app keeps the file I/O, the path defaults, the override variable names,
      the migrator and the runtime snapshot. `@corvi/agents` owns the agent window presenter
      (`./presenter`: the pi pane options and their status vocabulary) and the briefing fill
      (`./prompt`). The app keeps the presenter merge, the pty spawner and its environment
      policy, and the routes. What is not done is the target guide's `apps/server`, `apps/web`
      and `integrations/*` split, so this stays open until the application packages exist (see
      7.222 for the gate).
- [x] Remove obsolete comments and exports as each implementation is replaced.
      The legacy `stepsFor` planner, the phase-only `startChange`, `looseEnds`, and the generic
      browser helpers (`api`/`post`/`put`/`patch`/`del`/`ApiError`) are gone; the helpers'
      transport behaviors moved into `ClientError` (structured error body, status-text fallback,
      the non-JSON "older code" message) and their tests moved to the client package. The cache's
      module-level `ageOf`/`loadCache`/`saveCache` exports went the same way: they are
      `CacheStore` methods now, and the tests ask an instance (or `defaultCache`).

## 6. Remove the extension platform

- [x] Remove out-of-tree path discovery, factories/loader machinery, and custom-module installation.
      Discovery and `install`/`installFactory` are gone;
      `src/integrations/included.ts` is the explicit list and `src/integrations/loaded.ts`
      normalizes it. The host directory itself is renamed away: `src/extension-host/**` was
      moved to `src/integrations/**` (`client.tsx`, `routes.ts`, `selectors.ts`, `effects.ts`,
      `services.ts`, `dispatch.ts`, `migrate.ts`).
- [x] Remove arbitrary client-chunk builds, dynamic UI imports, and vendor import-map support that
      exists only for external extension code. Preserve normal application bundling.
      `clientChunks.ts`, `vendor-jsx.ts`, the `/extensions/*/client.js` and `/vendor/*` routes and
      the page's import map are gone; `src/integrations/client.tsx` imports the included client
      halves directly.
- [x] Replace the public extension contract/host registry with explicit included-module composition.
      No `Extension` type, no loader: the modules import `src/integrations/types.ts`, the list is
      fixed in composition order, and a workspace's `extensions` list still gates a workspace's
      surfaces. The type barrel holds surface types only — capabilities and errors are imported
      from `src/capabilities/` — and an unknown name in a workspace's list is named at startup.
- [x] Replace generic card/hook/page plumbing where ordinary feature APIs and composition suffice.
      Hook and overview-contributor plumbing are removed; cards, pages, tabs, widgets and wizard
      steps stay as declarative fields on the included integrations, which is the retained list.
- [x] Remove external-loader settings/UI and obsolete tests; retain included-integration coverage.
      The settings page's extension-paths tab, `CORVI_EXTENSION_PATHS`/`extensionPaths`, and the
      discovery tests are removed; the selector semantics are tested against the included
      integrations.
- [x] Migrate provider metadata/documents safely if their stored layout changes. Confirm notes,
      archived documents, ticket references, and secrets remain available. The notes sidecar
      migration (`readSidecar`), archive readability (`test/changes.test.ts`), ticket keys
      (`test/extensions.test.ts`, `test/jira.flows.test.ts`) and secret masking
      (`test/settings.test.ts`) are all covered.
- [x] Keep the Pi-side reporter installation unless its integration is replaced deliberately;
      it is not an out-of-tree Corvi plugin. `scripts/extension.ts` and `test/extension.test.ts`
      remain as they were.

## 7. Finish and verify

- [x] Remove unused code, dependencies, temporary adapters, and old paths. An adapter that remains
      must have an owner, a concrete removal condition, and no new consumers.
      Dependencies audited: every declared dependency of the root and of `packages/*` is imported
      somewhere in its owner. The old paths are gone (extension host and loader, client chunks,
      `extensionPaths`, the extension-paths settings UI), and the adapters that remain
      (`src/change/lifecycle-layer.ts`, `src/change/provisioning.ts`) are the final port
      implementations for the included integrations, owned by this plan. The dead-file sweep was
      inconclusive by static pattern, so nothing was deleted on that basis.
- [ ] Check every public entrypoint against the API checklist and actual dependency graph.
      The extracted packages' entrypoints match their `AGENTS.md` and the guide's ownership
      table (contracts, configuration, changes, repositories, terminals, agents, shell,
      workflows and client). The interface the application and integration split needs is in
      place: `@corvi/contracts/errors` owns the failure vocabulary (the app's module is gone,
      every importer swept), `@corvi/contracts/workspace` owns the request-scoped `Workspace`
      tag, and `@corvi/shell` owns the `Shell` capability with its Node adapter under
      `./node` (the app constructs it with its environment, limits and tracing). What is left is
      the integration contract move (the declaration types and the remaining tags:
      `Cache`, `Settings`, `Bus`, `ExtensionStore`, `Changes`) and then the application and
      integration split: `apps/server`, `apps/web`, `apps/desktop`, and the five
      `integrations/*` packages. The Node rule for applications is answered — rules may carry
      `"node": true`, and `@corvi/server`/`@corvi/desktop` do, while `@corvi/web` stays
      browser-only. Until the app packages exist, `bun run boundaries` keeps enforcing the
      declared graph among the workspaces that exist.
- [x] Run the full suite, typecheck, lint, boundary checks, browser flows, and runtime smoke tests.
      Report skipped platforms and any baseline failures; do not hide them with weaker tests.
      `bun run test` (which owns and cleans its resources) runs 593 pass / 1 skip / 0 fail, and
      the browser flows are part of it.
- [x] Update commands/manuals for actual behavior and package instructions for implemented ownership.
      Every `bun run` command used in `README.md` and `docs/manual/*.md` exists in
      `package.json` (checked against all 20 scripts). The manual's configuration and integration
      pages already describe included features and the workspace `extensions` list rather than
      external plugin installation, and the only `extension:*` entries are the deliberately kept
      Pi reporter.
- [ ] Remove target-status caveats only once the described checks and layout exist. Delete this plan
      when complete; do not create an archive of intermediate agent reports.

## Future feature gates

After the foundation is in place, decide the [open product questions](../decisions/architecture.md#decisions-still-required-before-related-features)
for resume, OpenCode control, action failures/retries, and skills. Do not implement speculative
provider methods or automation semantics as part of extraction.
