# Architecture decisions

Status: accepted target; implementation is tracked in the [refactor plan](../plans/architecture-refactor.md).

| Decision | Reason and boundary |
| --- | --- |
| Build a modular application, not an extension platform | Included functionality needs good APIs and explicit dependencies, not a third-party plugin host. Remove out-of-tree loading and its public contract. External extensibility is a separate future decision. |
| Use Bun workspaces for package boundaries | Manifests and explicit exports make dependencies inspectable. Enforce the graph with tooling; workspaces alone do not prevent source-path imports. Bun remains the toolchain, not the server runtime. |
| Organize backend packages by capability | Changes, repositories, terminals, and agents own distinct concepts. Workflows compose them. A screen or first caller does not define a lower-level API. |
| Make integrations ordinary packages | They may build on other approved capabilities or integrations. They are not restricted to a privileged core API. External-system implementations remain outside application policy. |
| Organize the browser by feature | Keep a feature's views, state, and UI logic together. The browser consumes typed network operations; it does not import backend internals, even as types. |
| Use Effect for explicit I/O and resource ownership | Layers construct services, Effects describe work, and scopes own cleanup. Pure transformations remain ordinary functions. No import-time application initialization or hidden live-service fallback. |
| Use canonical executable boundary contracts | Reuse shared schemas and derive their types. Validate untrusted input. Domain, wire, persistence, and provider representations may differ intentionally. |
| Keep recoverable errors domain-specific | A small global HTTP-shaped error set erases useful information. Translate errors where the transport or UI needs them. |
| Separate terminal sessions, agent sessions, and actions | Attaching a running terminal, recreating a process, and resuming a conversation are different operations. Typed actions may be invoked from buttons or status-transition workflows. |
| Preserve behavior while replacing internals | Existing user workflows and safety matter more than internal API compatibility. Explicitly remove obsolete plugin behavior and its tests; name other behavior changes before implementation. |
| Retain the current technology baseline | Keep Effect 3, React, Node/Electron, Git, tmux/node-pty/xterm.js, and file-backed storage during the structural refactor. Major upgrades and storage changes are separate decisions. |

## What is not being built

- A public extension SDK, marketplace, dynamic discovery, or hot-reloadable plugin system.
- A distributed workflow engine, event-sourced application, or exactly-once execution system.
- A custom dependency-injection framework above Effect Layers.
- A generic provider interface that pretends every vendor supports identical operations.
- An OpenCode fork, or a switch to Effect 4 beta to resemble its implementation.

OpenCode informs the separation of schemas, services, transports, integrations, and lifetimes,
and the use of executable boundary tests. Its package count, migration compatibility layers,
and custom runtime infrastructure are not templates for Corvi.

## Decisions still required before related features

1. **Terminal resume:** reattach a live session, recreate one after termination/reboot, or resume
   its agent conversation? These remain separate capabilities even if one button composes them.
2. **OpenCode support:** interactive terminal integration, programmatic control, or both?
3. **Status-triggered actions:** failure reporting, retry/duplicate policy, ordering, and whether
   any action is a precondition for a transition. Do not hide these choices in event handlers.
4. **Skills:** define the needed Pi/OpenCode behavior before introducing a shared skill model.

These gates do not block package extraction. They do block inventing behavior for future features.
