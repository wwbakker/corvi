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

- [ ] Run and record the full typecheck, lint, and test baseline, including skips/platform gaps.
- [ ] Identify behavior tests for creation/start, review, completion/cancellation, settings,
      documents, integrations, terminal survival, and process cleanup.
- [ ] Separate behavior assertions from tests tied to global registries, private exports, and
      custom-extension loading. Plan replacement coverage before deleting coupled tests.
- [ ] Author representative contracts and typechecked callers for repository queries, change
      associations/storage, working-directory resolution, and the lifecycle/terminal boundary.
- [ ] Owner review of the contracts, dependency graph, and deliberate behavior differences before
      moving files or starting package implementation.

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
- [ ] Add browser import/bundle isolation and Node/Electron package-resolution smoke tests.
      Contracts bundle and Node resolution are covered in `test/contracts.test.ts`; app bundles and
      Electron resolution come with those packages.
- [x] Keep one root verification command running every package/app test with owned-resource cleanup.
      Change CI and the PR checklist to use the safe test wrapper rather than bare `bun test`.
- [x] Extract canonical shared boundary schemas without pulling runtime code into contracts.

Do not scaffold empty integrations or weaken current lint rules before replacement checks exist.

## 3. Build a reference capability slice

- [x] Extract worktree inspection/parsing behind `repositories`' public API.
- [x] Separate Git facts from change-directory selection and dashboard presentation.
- [x] Supply process/filesystem dependencies through Layers; no optional live fallback.
- [ ] Extract the change-owned association projection/update and migrate association data explicitly
      before enabling directory-bound workflows. Created and adopted worktrees both retain a path;
      unresolved legacy ownership must not become automatic cleanup authority. The store now writes
      a legacy-compatible record: `repositories` materializes on write, `repos`/`direct` stay in
      sync from it, and the legacy fields win when the old app edits them, so one record serves
      both readers. A terminal transition archives the directory. Enabling the new write paths is
      the remaining step.
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

- [ ] Replace import-time configuration reads and mutable exported configuration with a snapshot
      service. Preserve precedence, masking, workspace isolation, and immediate settings updates.
- [ ] Construct caches, integration instances, and registries inside Layers, not module singletons.
- [ ] Assemble runtime services and included integrations explicitly at the server entrypoint.
- [ ] Separate notification/watch policy from event transport; scope and cancel all watchers.
- [ ] Separate terminal-session ownership from request/PTY attachment ownership.
- [ ] Prove independent application instances and scoped shutdown in tests.

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

- [ ] Replace HTTP-shaped internal errors with domain errors and boundary mapping.
- [ ] Protect concurrent change updates and interrupted file writes; test guarantees explicitly.
- [ ] Migrate create/start/complete/cancel as callable workflows, preserving step ordering and
      partial-failure reporting. Keep force/acknowledgement and dirty-worktree protections.
      `ChangeLifecycle` now exists in `@corvi/workflows/lifecycle` with scripted-port tests
      (ordered steps, fact-fingerprinted acknowledgements, recheck-before-removal, per-change
      serialization); the app routes and write-path migration remain.
- [ ] Replace caller-selected `api<T>` casts and route-body casts with authoritative codecs and
      named client methods. Generated clients are optional; duplicate schemas are not.
- [ ] Move UI to feature ownership; keep host access behind a typed platform interface.
- [ ] Remove obsolete comments and exports as each implementation is replaced.

## 6. Remove the extension platform

- [ ] Remove out-of-tree path discovery, factories/loader machinery, and custom-module installation.
- [ ] Remove arbitrary client-chunk builds, dynamic UI imports, and vendor import-map support that
      exists only for external extension code. Preserve normal application bundling.
- [ ] Replace the public extension contract/host registry with explicit included-module composition.
- [ ] Replace generic card/hook/page plumbing where ordinary feature APIs and composition suffice.
      Retain a declarative list only where it has a clear application responsibility.
- [ ] Remove external-loader settings/UI and obsolete tests; retain included-integration coverage.
- [ ] Migrate provider metadata/documents safely if their stored layout changes. Confirm notes,
      archived documents, ticket references, and secrets remain available.
- [ ] Keep the Pi-side reporter installation unless its integration is replaced deliberately;
      it is not an out-of-tree Corvi plugin.

## 7. Finish and verify

- [ ] Remove unused code, dependencies, temporary adapters, and old paths. An adapter that remains
      must have an owner, a concrete removal condition, and no new consumers.
- [ ] Check every public entrypoint against the API checklist and actual dependency graph.
- [ ] Run the full suite, typecheck, lint, boundary checks, browser flows, and runtime smoke tests.
      Report skipped platforms and any baseline failures; do not hide them with weaker tests.
- [ ] Update commands/manuals for actual behavior and package instructions for implemented ownership.
- [ ] Remove target-status caveats only once the described checks and layout exist. Delete this plan
      when complete; do not create an archive of intermediate agent reports.

## Future feature gates

After the foundation is in place, decide the [open product questions](../decisions/architecture.md#decisions-still-required-before-related-features)
for resume, OpenCode control, action failures/retries, and skills. Do not implement speculative
provider methods or automation semantics as part of extraction.
