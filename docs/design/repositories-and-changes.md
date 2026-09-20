# Repository capabilities and change workflows

Status: proposed step-1 design, ready for owner review. No workspace packages or production APIs
are implemented. This is the contract specification for the first slice, not another migration
plan; execution remains in the [architecture refactor plan](../plans/architecture-refactor.md).

## Read the interfaces

- [Repository values, services, and adapter requirements](repositories/api.ts)
- [Change associations and storage projection](changes/api.ts)
- [Workflow and terminal-port APIs](workflows/api.ts)
- [Two complete, typechecked caller examples](workflows/examples.ts)
- [Negative type checks](typechecks.ts)
- [Executable tests of the workflow examples](workflows/examples.test.ts)

These prototypes are included by the existing `bun run typecheck`. They use Effect 3 and have no
production imports. Declared schemas/Layers are signatures, not implementations; do not execute or
import the prototypes from application code. On extraction, implement canonical schemas and derive
model types from them, move the checks beside the packages, and remove these duplicate prototypes.
There is no separate handwritten runtime DTO model to keep in sync. Example tests execute the
composition against strict scripted services, not the proposed Git/storage implementations.

The authoring baseline is recorded in [step 1](../plans/architecture-refactor.md#1-establish-the-executable-baseline).
Local disposable Git fixtures (Git 2.55.0) additionally confirmed common-directory identity across
linked worktrees, unborn/detached status, NUL-separated unusual paths, bare entries, configured
missing upstream without ahead/behind counts, and a multi-commit squash with identical trees but
plus entries from `git cherry`. These checks inform the contract; they do not replace adapter tests.

## 1. Ownership and package edges

| Owner | Public surface for this design |
| --- | --- |
| `@corvi/contracts/paths`, `/git`, `/changes` | Canonical IDs, repository/worktree refs, observed values, and change association values shared across boundaries |
| `@corvi/repositories` | The single `Repositories` capability and its one `RepositoryError`; no native imports at this entrypoint |
| `@corvi/repositories/composition` | Query Layer and its adapter-only process/path requirements |
| `@corvi/changes/repositories` | Change-owned association projection, validation, and atomic updates |
| `@corvi/workflows/change-work` | Inspect a change's repository and resolve its working directory |
| `@corvi/workflows/change-lifecycle` | Start/complete/cancel orchestration, extracted after the read slice |
| `@corvi/contracts/api`, `@corvi/client` | Encoded workflow contracts and named network operations |
| Server composition and web presenters | Select workspace implementations; adapt facts to transport and display |

Edges: repositories -> contracts; changes -> contracts; workflows -> changes, repositories,
contracts; client -> contracts. Concrete integration adapters implement workflow-owned ports and
are supplied by server composition. Neither repositories nor changes imports the other one's
runtime. Shared WorktreeRef values are canonical contracts, not a type-only back door into services.

The capability exposes one **Repositories** service. Internally it stays separated into
repository, worktree, reference, and history modules (`api.ts`, `worktrees/`, `references/`,
`history/`, `git/`); remote HEAD is a reference query, not a special kind of branch. One service
does not mean one implementation file, and the low-level Git execution port stays
composition-only, never exported from the capability entrypoint. No custom Layer graph or
universal Git facade is needed. Mutation interfaces are not added to the query service merely for
future completeness.

## 2. Repository and worktree identities

A repository is one local Git object/ref store, identified by its canonical **common Git directory**.
All its worktrees share that identity. A remote URL is not its identity: two local clones remain
separate repositories. A bare repository is valid for repository/history operations.

A worktree is a directory associated with that repository. The main checkout and linked worktrees
share one model. Its identity is `{ repository, directory }`, never a branch. An attached HEAD has
a branch and an optional commit (None when unborn); a detached HEAD has a commit and no branch.

`resolveRepository` accepts a directory in a worktree or a Git directory. `resolveWorktree` accepts
a directory in a worktree and returns its canonical top level; a bare/Git-only directory is None.
Resolving a reference does not open a terminal, fetch, switch branches, or record a change.

`verifyWorktree` requires the exact recorded root and verifies the actual common directory and
registration without an expensive working-file status scan. `inspectWorktree` performs that same
identity check before reading status. It never follows a branch to some other directory. A missing
root is absence (`None`); wrong owner, permission failure, and malformed Git output are
`RepositoryError`, told apart by message and cause rather than by a class per reason. An observed
HEAD/identity race gets one bounded retry, then `RepositoryError`, not mixed success. Other
processes can still edit files after inspection; a snapshot is not an atomic filesystem view.

Location identity is deliberately not a persisted UUID. Relocation requires an explicit rebind.
Recreating a repository at exactly the same common-directory path cannot always be detected by
this identity alone. Refs and provenance are not deletion authority; destructive workflows must
revalidate ownership and current safety, rather than promise stronger identity guarantees.

`listWorktrees` returns **registrations**, including missing/prunable and locked entries. It does
not claim each directory is usable. The bare repository entry is not a worktree; a bare repository
can still have linked worktrees. Main comes first when present. There is no singular branch lookup:
Git can be forced to attach the same branch more than once. Discovery/migration can filter the list
and must handle zero, one, or multiple matches explicitly.

## 3. Query semantics and I/O

| API | Result and guarantee |
| --- | --- |
| `resolveRepository` | Some: canonical common-directory identity and bare/non-bare storage facts. None: definitively not inside a repository |
| `resolveWorktree` | Some: canonical worktree root and owning repository. None: bare/Git-only or definitively missing |
| `listWorktrees` | Registered locations/HEADs without per-directory status reads; stale, locked, and prunable entries included |
| `verifyWorktree` | Some: the exact recorded root is a registered, usable worktree. None: gone, prunable, or not a worktree. No file-status scan |
| `inspectWorktree` | Some: validated identity plus HEAD, status, and upstream observation. None: no usable worktree at the recorded location |
| `listRemotes` | Locally configured remote names, not network availability |
| `readRemoteDefault` | NotConfigured, Unknown, or a known remote-tracking branch from local metadata |
| `resolveCommit` | Some: a structured revision resolved to a full commit ID. None: missing or unborn. Non-commit targets are `RepositoryError` |
| `assessIntegration` | Evidence for two pinned commit IDs, not an arbitrary moving branch |

Expected absence is `Option.none` in the result; `RepositoryError` means the answer could not be
established, including an identity mismatch between a recorded worktree and the directory it
names. One operational error class carries a safe message, the operation, and optional
diagnostics; adapter errors stay private and are translated at the package boundary. Structured
classification is added only where a caller acts on it. Interruption is never translated into
`RepositoryError`.

Revisions distinguish local branches, remote branches, tags, and full commit IDs. They do not
accept raw revspecs or an implicit HEAD from the common directory. Constructors/codecs validate
shape; the Git adapter validates Git reference syntax and qualifies names. Tags resolving to
non-commit objects are `RepositoryError`, not missing references. Commit IDs support the
repository's object format, rather than assuming only SHA-1.

An absent upstream means no tracking configuration. A configured upstream with no available target,
an unborn HEAD, or incomplete comparison history is **Some with unavailable comparison**, not None
and not zero ahead/behind. Status includes conflicts explicitly as well as staged/modified/untracked.

The query Layer captures two explicit adapter dependencies, exported only from the composition
entrypoint and never from the capability entrypoint:

- `GitObservation`: workspace-bound environment, concurrency limit, timeout, cancellation, and raw
  stdout/stderr. Spawn/timeout failures use its error channel; exit codes remain data for decoding.
- `DirectoryResolution`: filesystem canonicalization, with missing/not-directory/access-denied
  failures. `realpath` is I/O, not a hidden pure helper.

These are adapter requirements, not new shared application packages. Prefer existing platform
services in their implementations. A composition adapter must not delegate to the current Shell's
stdout trimming/ANSI stripping or optional live-service fallback. Preserve whitespace and NULs.

Repository commands explicitly target the common Git directory; worktree commands target the
recorded root. Scrub inherited Git location overrides (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
and related object/namespace overrides), while retaining deliberately configured authentication.
Never concatenate a shell command. Disable optional index writes and lazy fetching in observation
commands; do not launch fetch, remote-set-head, merge simulation, filters, or hooks deliberately.
Validate the actual supported Git version's behavior rather than silently weakening these rules.
This is a local observation policy, not a sandbox against arbitrary repository configuration.

Use NUL-delimited worktree/status porcelain and strict decoding. Status alone cannot establish the
worktree kind/owner, and status without ahead/behind fields must not manufacture zeroes. There is
no promise of one subprocess per inspection. No query memoization is introduced in this slice.
There are no live processes between calls. Workspace Layer construction captures credentials and
can be replaced on configuration updates; sharing one credential-bound instance across workspaces
is forbidden.

## 4. Integration evidence and default-base policy

`assessIntegration` receives **candidate and base commit IDs**. Results carry both IDs so callers
know exactly what was compared. The candidate comes from the observed worktree HEAD, not the
change's intended branch. Ref resolution is separate and never fetches missing objects.

Conservative algorithm:

1. Prove ancestry with Git. Success yields `ProvenIntegrated/ancestor`.
2. If local history is incomplete and no proof was established, return `Indeterminate`.
3. Examine the candidate range. If it contains merge commits, return `NotProvenIntegrated/merge-history`;
   this slice does not prove merge-resolution content with cherry's non-merge patch comparison.
4. Decode `git cherry` strictly. Nonempty all-minus output that accounts for the entire candidate
   non-merge range yields `ProvenIntegrated/patch-equivalent-range`.
5. Plus entries yield `NotProvenIntegrated/unmatched-patches` with the actual unmatched patch count.
   Empty output is not a vacuous proof; return `no-comparable-patches` when there is no usable proof.
6. Unexpected exits or invalid output are `RepositoryError`, not a successful negative answer.

Ancestry/patch equivalence describe history, not semantic tree equality. In particular, a multi-commit
squash can leave plus entries even when the final trees match. A display may conservatively report
no proof; neither this result nor a cached green row authorizes deletion. The stronger merge-based
removal proof is a separate, explicit operation to design with the mutation workflow.

Default-base selection is **application policy**, shown in `resolveDefaultBase`:

- If remotes exist, use the configured preferred remote (currently `origin`). Missing preferred
  remote, missing symbolic HEAD, and missing target commit remain unknown; do not guess `origin/main`.
- Only with no remotes, try configured local branches in order (currently `main`, then `master`).
- No inspection updates remote HEAD, fetches, or falls back to the main worktree's implicit HEAD.
- A workflow that provisions work may explicitly discover/refresh/fetch before selecting its base.
  These operations are outside the query Layer.

The **starting point** selected for stacked work is not automatically the **integration target**.
Current local dashboard integration status compares against the repository default; pull-request
creation/review can use the selected starting base. Do not collapse those policies into one `base`
field. A user-selected branch alone is not evidence that work has landed in the default branch.

## 5. The change owns intent and associations

`ChangeRepository` separates three facts:

1. **Source**: the original worktree used for browsing/provisioning input.
2. **Intent**: create a linked worktree, switch an existing worktree, or use it without switching.
3. **Association**: Pending, Bound to an exact WorktreeRef, or Released with its prior association.

A bound association always stores its directory, including worktrees Corvi creates. Record it when
provisioning succeeds. In-place use is bound as Borrowed before a requested branch switch; if dirty
work prevents switching, the directory is still known and its observed HEAD explains the problem.

Main/linked is Git structure; Created/Borrowed/Unverified is Corvi provenance. `createdBranch` is
separate because Corvi can create a worktree around an existing branch or create a branch in a
borrowed worktree. Finishing a change never deletes or resets a borrowed checkout. Unverified
provenance permits observation, not automatic cleanup. Preserve released associations for archive
readability; do not rebind them by matching a branch later.

`KeepCurrentHead` allows a different branch, unborn branch, or detached HEAD without labeling it
wrong. `SwitchToBranch`/linked-worktree intent retains an expected branch, but inspection only
reports a mismatch; it never switches. These types accommodate adoption without adding a new UI
mode in the reference slice.

`ChangeWorkState` is a **projection** of lifecycle and repository state, not a replacement for the
full persisted Change. The store's narrow `recordAssociation` operation validates membership,
matching repository identities, lifecycle, and transitions. It preserves titles, provider data,
documents, and unknown persisted fields. Its optimistic revision check and update must occur under
one change-owned lock, with atomic file replacement; rereading alone is not sufficient. All writers
to the same data must participate, including other local server processes. There is no transaction
spanning that record and Git. Recording failure after provisioning leaves a recoverable partial
operation, not permission to remove whatever appears at the destination on retry.

The same test was applied to the change APIs: `ChangeStoreError` reports operation, message, and
cause; `ChangeConflict` and `InvalidAssociation` stay structured because callers retry, reconcile,
or explain them, and `CompletionReason` keeps its meaning because acknowledgement acts on it.

## 6. Workflow acceptance examples

**Dashboard:** `inspectChangeRepository` reads the recorded change membership before touching Git.
Ideas return Browsing; finished changes return Archived without requiring their source repositories
to remain online. Active bound work is inspected by its stored directory. Only a definitive `None`
becomes a Missing view; access failures and identity mismatches propagate as `RepositoryError`.
Expected HEAD and observed HEAD are compared separately. Current commit and default-base commit are
pinned before assessing integration. The result contains facts, not WidgetItem, English labels, or
actions.

A web presenter maps those facts to the existing local-change card. A missing checkout, an unreadable
repository, and an unknown comparison must remain distinguishable. Server-side display composition
can support the current renderer temporarily, but never moves into the repository capability.

**Terminal/agent caller:** `resolveChangeWorkingDirectory` checks change membership and active
association, then verifies that exact worktree without scanning working-file status. It remains valid after `git switch` or detach and
performs no branch lookup or switch. It returns a directory only; terminal/agent lifecycle is a
separate caller. Ideation's existing briefing terminal runs at the change directory and is not
replaced by this repository-working-directory operation.

Both examples acquire the `ChangeStore` and `Repositories` services explicitly and declare their
complete error/requirement channels. A Layer captures the workspace ID, policy, and services for `ChangeWorkQueries`. Server
composition selects that workspace from the stored change, not the browser's current filter. The
workflow rechecks the stored workspace before any Git call; a mismatch fails rather than using
another context's credentials. Rebuild/select the right Layer after an explicit workspace move.
The browser receives a named client operation, not a caller-chosen `api<T>` cast.

## 7. Change lifecycle boundary

The [ChangeLifecycle interface](workflows/api.ts) specifies the application surface, not new
production orchestration. Mutating repository APIs and concrete provider ports are extracted with
step 5, not added as unimplemented methods to the query package.

| Operation | Ordering and failure contract |
| --- | --- |
| Create idea | Validate and persist the change/plan; prepare browse links only. No worktree, branch, or ticket transition. |
| Start | Persist In Progress first; bind/provision each target and report partial failures. Existing dirty in-place work is not switched. The change survives failed provisioning. |
| Complete | Revalidate live readiness; obtain acknowledgements; journal; merge eligible PRs sequentially; run required issue steps; release owned safe worktrees/links; stop owned terminal; archive; report observer failures as warnings. |
| Cancel | Revalidate local safety; collect external loose ends; release owned worktrees/links; stop owned terminal; archive. Do not close external issues or merge PRs. |

The workflow consumes narrow provider ports for PR readiness/merge and issue transitions. Adapters
receive provider/repository references, not a command to decide Corvi's lifecycle. Explicit included
composition supplies their order; no external hook registry or generic workflow engine is needed.
The terminal port stops a recorded session ID, never a process selected by name or port.

Readiness returns Ready, AcknowledgementRequired, or Blocked. Dirty/conflicted state, unavailable
safety information, unknown cleanup ownership, and an unexpected HEAD on a managed target block
cleanup. No acknowledgement overrides them. A created worktree referenced by another active
change is not exclusively owned for cleanup; check those associations under the worktree lock and
block deletion. Adopted targets following their current HEAD do not fail merely for changing
branches; workflow cleanup removes only Corvi's own association/link.

Acknowledgements identify reasons and the facts they concern, including relevant refs/commits,
not a global `force: true`. Recheck before acting; changed reasons require fresh acknowledgement.
This strengthens the existing per-reason UI behavior. The public outcome remains structured;
transport adapters can preserve the existing dialog/status-code behavior during migration.

Serialize conflicting operations per change and repository/worktree; reject another same-change
lifecycle operation as `ChangeOperationInProgress`. Record step transitions before/after side effects.
Required-step failure stops later steps. After-commit observer failure is a warning. Interruption
remains interruption with best-effort interrupted progress recording, not false success. Retries
explicitly reconcile external state; uncertain outcomes are not automatically replayed. Git/JSON
progress is not an exactly-once guarantee or a distributed transaction.

## 8. Migration boundary and deliberate differences

The read-only capability can land independently. **Do not enable directory-bound workflows before
association data exists.** This is a small prerequisite extraction from `changes`, not permission
to reintroduce branch-based identity inside a temporary ChangeWorkTargets port.

- Introduce a versioned association encoding and migrate fixtures first. Preserve the complete
  source record and documents. No physical move of worktrees or archive data is required.
- A migration command at application composition may use both repository discovery and the change
  store. The changes package itself performs no Git discovery.
- Prefer deterministic existing location evidence (an in-place source or recorded/supported layout).
  Branch matching may assist this explicit migration only. Multiple matches, missing paths, or
  inconsistent evidence are reported, never silently selected.
- Existing records do not prove who created a directory/branch. Use Unverified unless creation is
  established or ownership is explicitly confirmed. Normal queries do not persist migrations.
- Do not make a read-only legacy adapter implement writes by no-op. Do not expose Pending for an
  unresolved migration in a way that offers to create a duplicate worktree.
- Activate the new reader after conversion; have creation/provisioning record associations through
  the owner from then on. Keep old destructive callers unchanged until their stronger contract and
  regression coverage have been migrated deliberately.

Differences to review before implementation: inspection no longer updates remote HEAD or guesses a
remote default; failed/unreadable observations no longer look like clean/missing work; unsupported
cheap integration proofs remain unproven; directory associations survive branch changes; unsafe
legacy ownership must be resolved before destructive cleanup. No new resume, automation, adoption
UI, or OpenCode feature is part of this slice.

## 9. Behavior coverage and minimum next implementation

| Existing tests | Retain behavior; change test wiring where necessary |
| --- | --- |
| `changes`, `ideation`, `repos`, `tooling` | Idea/start distinction, chosen/default base, no default-branch push tracking, in-place protection, copied tooling, archive readability |
| `complete`, `cancel`, `lifecycle`, `lifecycleFailures` | Fresh checks, ordered steps, acknowledgements, dirty-work refusal, partial failure, observer reporting |
| `review`, `cards`, `github`, `githubChecks` | Status/diff/commit behavior, provider facts and existing rendering |
| `settings`, `env`, `notes`, `wizardDraft` | Workspace/credential separation, secret masking, unknown-field preservation, documents/drafts |
| `terminal`, `events`, `origin`, `clean`, `node-runtime`, `pages` | Session survival, attachment cleanup, origin protection, owned processes, browser/native behavior |

Replace tests that inspect mutable registries, script exact CLI cwd, call private exports, or load
out-of-tree modules with equivalent capability/workflow/adapter coverage. Do not discard behavioral
assertions merely because their current fixture needs replacement.

New acceptance cases: main/linked/bare; unborn/detached; subdirectory/symlink resolution; paths with
spaces/tabs/newlines; missing/locked/prunable worktrees; wrong-repository refs; configured missing
upstream versus no upstream/zero counts; branch switch preserving association; ambiguous branch
matches; multi-commit squash and merge ranges; malformed output/timeout not counted as absence;
Option absence versus `RepositoryError`; read-only command policy; wrong-workspace rejection before
Git; archived reads without Git;
shared-worktree cleanup protection; concurrent association updates and lost
write prevention. Preserve real Git tests in addition to scripted-port tests.

Minimum step 2/3: contracts + repository queries + the association-owning changes entrypoint +
change-work queries; explicit exports, resolved dependency checks with negative fixtures, safe
root test aggregation, browser bundle isolation, and Node package-resolution checks. Supply live
adapters and migration from the application root, never new-package imports into `src/`. Keep
native imports separate and verify Electron when its binary is available. No empty agents/providers,
new generic cache, SDK generator, or wholesale lifecycle rewrite is required to prove this slice.
