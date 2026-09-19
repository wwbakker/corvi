# Effect conventions

Status: accepted target. Use Effect **3** APIs from the installed version; OpenCode's Effect 4
beta examples are architectural references, not compatible API recipes.

## Purity and execution

- Keep pure calculations synchronous. Use immutable data and explicit inputs; use `Either` or
  another explicit result for expected validation failures.
- Effectful operations return descriptions of work. Constructing an Effect must not already
  start I/O; suspend eager Promise/native calls inside the appropriate Effect constructor.
- Importing a module does not read files/environment configuration, start timers, install
  integrations, run Effects, or allocate mutable application registries.
- `Effect.run*` and `ManagedRuntime` belong at application entrypoints, test harnesses, or explicit
  foreign-callback adapters. Domain code composes Effects instead of executing them.
- Promise adapters are legitimate at browser/native/library boundaries, not duplicate backend
  APIs maintained for tests.

## Services and Layers

Define an explicit service interface and an Effect 3 `Context.Tag`. Export model/service entrypoints
separately from concrete adapter Layers. Give Layers explicit output, error, and requirement types.

Acquire stable dependencies while constructing a service and capture them in its implementation.
Operations then require only genuine per-call context; construction requirements remain visible in
the Layer type. Use parameters for operation-specific values such as a workspace or repository ref.

Missing required services must not fall back to real processes, the filesystem, or a default
workspace. `Effect.serviceOption` is only for genuinely optional behavior. Supply defaults explicitly
at composition. Tests replace services through Layers, never ambient lookup tricks.

Use ordinary Layers and a small number of runtime roots. Shared instances are explicit in the
composition. Do not create per-function runtimes or a custom dependency graph framework.

## State and configuration

Application state is allocated when its owner is constructed. Use `Ref`, `SubscriptionRef`, caches,
or private mutable structures as appropriate. Do not export mutable maps, arrays, or configuration
objects for consumers to refill or reset.

Configuration services return immutable snapshots and explicit updates/streams. Decide whether an
operation captures a snapshot or observes updates; do not change credentials midway through an
operation by mutating a shared object. Workspace identity participates in cache/service identity
where environments or credentials affect the answer.

Use Effect time services for time-dependent behavior and tests. Capture environment/configuration
at a defined boundary, not through scattered `process.env` reads in domain operations.

## Resource lifetimes

Declare an owner for every process, listener, subscription, timer, attachment, and background fiber.
Acquire resources with `Effect.acquireRelease`/scoped Layers and register finalizers immediately.
Use scoped fibers for background work; the owning scope controls their cancellation.

An application owns its listeners, caches, and integration instances. Requests and PTY attachments
have narrower scopes. A tmux session intended to outlive Corvi is not an attachment-owned resource:
closing a socket releases the PTY client, not the persistent session.

Adapt callbacks once, capturing the necessary runtime/services and cancellation. Unregister native
listeners on cleanup. Do not restore ambient request context with undocumented globals.

## Failure and interruption

- Expected failures use domain-specific tagged errors. Prefer `catchTag` and explicit error mapping.
- `never` in the E channel does not mean a computation cannot defect or be interrupted.
- Do not use `orDie` to hide ordinary I/O failures a caller needs to handle. Unexpected invariant
  failures may remain defects; diagnose them at the application boundary.
- Never convert interruption to a successful empty result or ordinary business rejection with
  a broad cause/defect catch. Preserve cancellation through adapters and workflows.
- Fallbacks name a specific tolerated failure and its behavior. Missing data, unavailable data,
  invalid data, and an empty value are distinct unless the contract deliberately says otherwise.

A timeout must cancel owned work, not merely stop awaiting it. Process adapters must specify
termination, bounded shutdown, and output-drain behavior. They must never terminate unrelated
processes or a persistent terminal session just because a client detached.

## Composition and concurrency

Use `Effect.gen` for sequential orchestration and pipelines for small transformations. Name
important effectful operations for tracing using the installed version's APIs. Bind services to
named values before invoking them; avoid nested service yields.

Choose concurrency explicitly. Bound process/network fan-out, serialize conflicting mutations,
and use Effect synchronization primitives instead of ad hoc Promise queues. Restrict
uninterruptible regions to small state/finalizer transitions, never long network or CLI operations.

A cache's freshness policy is part of its contract. Destructive decisions revalidate the relevant
facts; stale display data must not authorize removal, merging, or deployment. Log recoverable
background failures without losing the last good value where that is the documented policy.

## Foreign APIs

Prefer suitable Effect platform services to new wrappers for filesystem, process, and HTTP I/O.
Use the build tool to install and inspect a dependency before adopting its API. Keep unavoidable
Promise/event-native adapters at the boundary. Runtime selection and native dependency loading
belong in adapter entrypoints, not in pure models or service definitions.
