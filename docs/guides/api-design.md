# API design

Status: accepted target. Examples describe intended contracts, not existing exports.

## Design capabilities, then compose use cases

A capability owns a coherent subject and exposes its meaningful operations. A workflow composes
capabilities into an application operation. `completeChange` is a valid workflow; it does not
justify teaching a Git adapter about Corvi changes or inventing a universal workflow engine.

Prefer APIs useful independently of their first screen or caller:

- A worktree service accepts repository identity, branch/base, and destination; it returns
  worktree facts. It does not accept a whole Change, write change records, or return card rows.
- A change store retrieves and updates records and documents. It does not launch tools.
- A provider returns issue/build/pull-request facts. Presentation decides labels and colors.

Do not generalize beyond demonstrated semantics. Use one realistic caller and, where relevant,
another existing or planned caller to review an API. A capability does not need two implementations
to be a useful boundary.

## Public surface

- Use descriptive operation names: `inspectWorktree`, `assessWorktreeRemoval`, `resumeAgentSession`.
  Avoid ambiguous names such as `run`, `handle`, `of`, or `process` without a clear subject.
- Declare explicit parameter and return types, service interfaces, error unions, and Layer types.
  Contextually typed callbacks need not repeat an already explicit type.
- Expose readonly records and collections. Use named input records instead of positional booleans
  or long parameter lists. Model alternatives with discriminated unions, not invalid combinations
  of optional flags.
- Use branded identifiers and validated paths where confusion is costly. A brand alone does not
  validate a path, establish confinement, or authorize access.
- Use `Option` for expected absence in internal APIs; required lookups fail with a named error.
  At wire boundaries choose an explicit encoded representation. Do not mix null, undefined, and
  empty strings for the same absence semantics.
- Keep DTOs, interfaces, constructors, and adapter Layers identifiable. Importing the public
  service definition must not acquire its implementation's resources.

The [repository/change design](../design/repositories-and-changes.md) provides concrete,
typechecked interfaces and callers. It distinguishes discovering a worktree from verifying an
established reference and inspecting its files. A required worktree that disappeared is a typed
failure; a revision that has no commit can be expected absence.

The layer captures required I/O services. Names and types are not sufficient alone: a future
`removeWorktree` contract must specify which safety facts it rechecks, what acknowledgement permits,
and what happens to an unmerged branch. An earlier assessment is not authorization to delete
against stale state. Make those guarantees short contract comments and test them.

## Schemas and representations

Shared boundary values have one canonical executable schema. Derive the matching TypeScript type
from it rather than maintaining an independent shape. Reexport the same schema value when an
owner offers a domain facade; do not create a second identity for generation convenience.

Contracts are browser-safe. Effect Schema and pure data utilities are allowed; OS access, runtime
construction, application registries and global configuration are not. Organize contracts by domain
and expose specific entrypoints. Do not move private runtime types there just to make them shared.

Validate untrusted data at boundaries: requests, persisted files, provider responses, process
output, and desktop IPC. `as T` and caller-selected response generics do not validate data.
Preserve codec encoded/decoded types instead of erasing transformations with a broad annotation.

Sharing semantics does not mean sharing every representation. A persistence format, provider
payload, domain value, and public response may differ. Keep their codecs and explicit conversions
with the owner. In particular, provider SDK classes and credentials must not become public DTOs.

## Errors and outcomes

Define small tagged error unions with meaningful fields in the owning domain. For example,
`WorktreeContainsUncommittedChanges` can carry a worktree reference, rather than a message a caller
must parse. Pure fallible calculations can return `Either`; effectful operations use the E channel.

Do not force every failure into NotFound/BadRequest/Conflict. Translate infrastructure failures to
capability errors, and domain failures to public transport errors at the appropriate boundary.
Keep causes for diagnostics without exposing secrets, commands with credentials, or raw stacks.

A valid business outcome is not necessarily a failure. A completion assessment may be `Ready`,
`AcknowledgementRequired`, or `Blocked`. A dependency that could not be inspected is not the same
as "nothing exists" or "safe to remove". Make the distinction explicit.

## Application and network APIs

A route is a transport adapter: decode, invoke an application operation, map its result/errors,
encode. Business orchestration belongs in workflows and is callable without HTTP.

The client exposes named, typed operations such as `client.changes.complete(input)`. Input and
response types come from the endpoint contract, not `api<T>(arbitraryPath)`. Test that the server
and client agree on encoding and failure shapes. A generator is optional; a parallel handwritten
schema model is not. Do not build a custom generator before its value is demonstrated.

Use a Promise-facing network client for React initially. Effect belongs behind the backend service
interfaces; shared schemas may still validate browser data. Promise failures need typed narrowing
and consistent classification. Document whether streams are live or replayable, their cancellation,
buffering, and reconnection semantics. A live invalidation event is not durable history.

## Storage and concurrency contracts

A store documents its consistency guarantees. Serialize or otherwise protect read-modify-write
operations on one change; rereading immediately before writing is not an atomic update. Define
file-write atomicity, interruption behavior, and any conflict/revision policy explicitly.

Likewise, an execution API states whether a retry duplicates work, joins it, or is rejected.
Recording progress does not make external side effects exactly once. Do not retry destructive
operations automatically without an idempotency or reconciliation design.

## API review checklist

Before implementation or a public API change, provide:

1. Owner and non-responsibilities.
2. Exported signatures, readonly input/output models, and expected error union.
3. Construction dependencies and state/resource lifetime.
4. A realistic call site that does not inspect implementation details.
5. Cancellation, consistency, and retry guarantees where relevant.
6. The adapter/presentation details kept private.
7. Compatibility or data-migration impact and the tests that establish the contract.

A short proposal in the task is enough. Request owner review for new boundaries or changed
architectural rules; do not create a permanent design essay for every function.
