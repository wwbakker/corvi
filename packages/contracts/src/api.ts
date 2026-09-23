/** Wire schemas shared by the server routes and the browser client. */
import { Schema } from "effect"

import { BranchPlan, Change, ChangePhase, CheckoutLocation, DirectoryName, RepositoryId } from "./changes.ts"
import { ConfigFile, Resolved, Workspace } from "./config.ts"

export const RepositoryViewSchema = Schema.Struct({
  repositoryId: RepositoryId,
  directoryName: DirectoryName,
  state: Schema.Literal("Concept", "Active", "Archived"),
  checkoutLocation: Schema.String,
  checkout: Schema.Union(
    Schema.Struct({ _tag: Schema.Literal("Missing") }),
    Schema.Struct({
      _tag: Schema.Literal("Present"),
      branch: Schema.optional(Schema.String),
      head: Schema.optional(Schema.String),
    }),
  ),
})
export type RepositoryViewDto = typeof RepositoryViewSchema.Type

export const ProvisionFailureSchema = Schema.Struct({
  repositoryId: RepositoryId,
  code: Schema.Literal("not-a-repository", "checkout-failed"),
  message: Schema.String,
})

/** What one provisioning target reported, shown after a create or a start: the integration,
 * whether it worked, and the first error when it did not. */
export const ProvisionResultSchema = Schema.Struct({
  integration: Schema.String,
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String),
})
export type ProvisionResultDto = typeof ProvisionResultSchema.Type

export const StartOutcomeSchema = Schema.Union(
  Schema.Struct({
    _tag: Schema.Literal("Started"),
    change: Change,
    repositoryIds: Schema.Array(RepositoryId),
  }),
  Schema.Struct({
    _tag: Schema.Literal("PartiallyStarted"),
    change: Change,
    repositoryIds: Schema.Array(RepositoryId),
    failures: Schema.Array(ProvisionFailureSchema),
  }),
)
export type StartOutcomeDto = typeof StartOutcomeSchema.Type

// --- The change record and the change page's reads -------------------------------------------

export const WidgetStateSchema = Schema.Literal("ok", "pending", "warn", "none", "error")
export type WidgetStateDto = typeof WidgetStateSchema.Type

/** Where a change stands. One vocabulary everywhere — record, code, and page (the phase names
 * were renamed in record format v2: "In Progress" is "Implementation", "Awaiting Review" is
 * "Verification"). */
export const ChangeStateSchema = ChangePhase
export type ChangeStateDto = ChangePhase

/** One repository's checkout spec: where it lives, which branch it uses, and the two branch
 * questions split apart — `base` is where a created branch starts, `target` is what a pull
 * request merges into. This shape is the record's `checkouts` entry, the create body's entry,
 * and the setRepos body's entry; one shape everywhere. */
export const CheckoutSpecSchema = Schema.Struct({
  path: Schema.String,
  location: CheckoutLocation,
  branch: BranchPlan,
  base: Schema.optional(Schema.String),
  target: Schema.optional(Schema.String),
})
export type CheckoutSpecDto = typeof CheckoutSpecSchema.Type

/** The change record: what change.json holds (record format `FORMAT_VERSION`), what the store
 * decodes, and what the routes serve. Decode keeps unknown keys (`onExcessProperty: "preserve"`
 * at the decode sites): a record carries whatever wrote it, so rewriting one must not drop
 * fields. */
export const ChangeWireSchema = Schema.Struct({
  id: Schema.String,
  branch: Schema.String,
  /** This change's checkouts, one spec per source repository. */
  checkouts: Schema.optional(Schema.mutable(Schema.Array(CheckoutSpecSchema))),
  workspace: Schema.optional(Schema.String),
  extensions: Schema.optional(Schema.mutable(Schema.Record({ key: Schema.String, value: Schema.Unknown }))),
  title: Schema.optional(Schema.String),
  titleEdited: Schema.optional(Schema.Boolean),
  state: Schema.optional(ChangeStateSchema),
  createdAt: Schema.String,
  completedAt: Schema.optional(Schema.String),
  /** How many times the record has been written; absent on records written before revisioning,
   * which count as 0. Used for the lifecycle's optimistic concurrency check. */
  revision: Schema.optional(Schema.Number),
  /** The record format's version. Absent is format 1 (the pre-checkouts record), which the
   * store migrates on read; a record from a newer Corvi is read best-effort and never written. */
  formatVersion: Schema.optional(Schema.Number),
})
export type ChangeWireDto = typeof ChangeWireSchema.Type

/** One fact on the overview's card: a coloured dot and a phrase. */
export const SummaryFactSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  state: Schema.optional(WidgetStateSchema),
})
export type SummaryFactDto = typeof SummaryFactSchema.Type

/** The overview's card: the core's terminal fact plus what the integrations add, and the worst
 * verdict among them. */
export const ChangeSummarySchema = Schema.Struct({
  facts: Schema.mutable(Schema.Array(SummaryFactSchema)),
  state: WidgetStateSchema,
})
export type ChangeSummaryDto = typeof ChangeSummarySchema.Type

/** One server-drawn card of a change: what the dashboard fetches to know what to render. */
export const CardInfoSchema = Schema.Struct({
  name: Schema.String,
  title: Schema.String,
  perRepo: Schema.Boolean,
  column: Schema.Literal("left", "right"),
  /** The card declares an editor (`Card.editable`); the editor itself is client code. */
  editable: Schema.optional(Schema.Boolean),
})
export type CardInfoDto = typeof CardInfoSchema.Type

export const ChangeTabInfoSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  extension: Schema.String,
})
export type ChangeTabInfoDto = typeof ChangeTabInfoSchema.Type

export const ChangeTabsResponseSchema = Schema.Struct({
  tabs: Schema.mutable(Schema.Array(ChangeTabInfoSchema)),
})
export type ChangeTabsResponseDto = typeof ChangeTabsResponseSchema.Type

export const WidgetInfoSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  extension: Schema.String,
  column: Schema.optional(Schema.Literal("left", "right")),
})
export type WidgetInfoDto = typeof WidgetInfoSchema.Type

export const ChangeWidgetsResponseSchema = Schema.Struct({
  widgets: Schema.mutable(Schema.Array(WidgetInfoSchema)),
})
export type ChangeWidgetsResponseDto = typeof ChangeWidgetsResponseSchema.Type

export const RepoStateSchema = Schema.Struct({
  path: Schema.String,
  location: CheckoutLocation,
  branch: BranchPlan,
  base: Schema.optional(Schema.String),
  target: Schema.optional(Schema.String),
  name: Schema.String,
  unsafe: Schema.optional(Schema.Struct({ kind: Schema.String, text: Schema.String })),
})
export type RepoStateDto = typeof RepoStateSchema.Type

/** A sidecar read or written as text (a plan, a pull-request description): absent is a missing
 * document, not a malformed one. */
export const TextSchema = Schema.Struct({ text: Schema.optional(Schema.String) })
export type TextDto = typeof TextSchema.Type

// --- One card's widget, and the completion's state -------------------------------------------------

/** One action a widget row offers; `arg` travels back to the integration. */
export const WidgetActionSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  arg: Schema.optional(Schema.String),
  confirm: Schema.optional(Schema.String),
})
export type WidgetActionDto = typeof WidgetActionSchema.Type

/** One row inside a widget: a repository, a pull request, a build, with nested rows. Declared as
 * an interface because the schema is recursive (children are rows too). */
export interface WidgetItemDto {
  label: string
  detail?: string
  detailTone?: WidgetStateDto
  url?: string
  state?: WidgetStateDto
  actions?: WidgetActionDto[]
  menu?: WidgetActionDto[]
  progress?: { startedAt: string; expectedMs?: number }
  at?: string
  children?: WidgetItemDto[]
}

export const WidgetItemSchema: Schema.Schema<WidgetItemDto> = Schema.suspend(
  (): Schema.Schema<WidgetItemDto> =>
    Schema.Struct({
      label: Schema.String,
      detail: Schema.optional(Schema.String),
      detailTone: Schema.optional(WidgetStateSchema),
      url: Schema.optional(Schema.String),
      state: Schema.optional(WidgetStateSchema),
      actions: Schema.optional(Schema.mutable(Schema.Array(WidgetActionSchema))),
      menu: Schema.optional(Schema.mutable(Schema.Array(WidgetActionSchema))),
      progress: Schema.optional(
        Schema.Struct({ startedAt: Schema.String, expectedMs: Schema.optional(Schema.Number) }),
      ),
      at: Schema.optional(Schema.String),
      children: Schema.optional(Schema.mutable(Schema.Array(WidgetItemSchema))),
    }),
)

/** What one integration reports about one change, as the dashboard renders it. */
export const WidgetSchema = Schema.Struct({
  integration: Schema.String,
  title: Schema.String,
  state: WidgetStateSchema,
  summary: Schema.String,
  items: Schema.mutable(Schema.Array(WidgetItemSchema)),
})
export type WidgetDto = typeof WidgetSchema.Type

export const RepoItemsSchema = Schema.Struct({
  items: Schema.mutable(Schema.Array(WidgetItemSchema)),
})
export type RepoItemsDto = typeof RepoItemsSchema.Type

/** One step of a completion, as the journal writes it while it runs. */
export const CompletionStepSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  state: Schema.Literal("waiting", "running", "done", "failed"),
  detail: Schema.optional(Schema.String),
})
export type CompletionStepDto = typeof CompletionStepSchema.Type

export const CompletionProgressSchema = Schema.Struct({
  startedAt: Schema.String,
  finishedAt: Schema.optional(Schema.String),
  steps: Schema.mutable(Schema.Array(CompletionStepSchema)),
  error: Schema.optional(Schema.String),
  forced: Schema.optional(Schema.Boolean),
  overridden: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
})
export type CompletionProgressDto = typeof CompletionProgressSchema.Type

export const CompletionReasonSchema = Schema.Struct({
  text: Schema.String,
  kind: Schema.Literal("forceable", "hard"),
})
export type CompletionReasonDto = typeof CompletionReasonSchema.Type

/** Whether a change can be completed right now: what blocks it, tagged, and what would merge. */
export const CompletionSchema = Schema.Struct({
  ready: Schema.Boolean,
  reasons: Schema.mutable(Schema.Array(Schema.String)),
  tagged: Schema.mutable(Schema.Array(CompletionReasonSchema)),
  toMerge: Schema.mutable(
    Schema.Array(Schema.Struct({ repo: Schema.String, number: Schema.Number })),
  ),
})
export type CompletionDto = typeof CompletionSchema.Type

// --- Terminals, wizard steps, pages, and the directory browser -------------------------------------

export const TerminalWindowSchema = Schema.Struct({
  index: Schema.Number,
  id: Schema.String,
  label: Schema.String,
  detail: Schema.String,
  icon: Schema.optional(Schema.String),
  state: Schema.optional(Schema.Literal("ok", "idle")),
  attention: Schema.Boolean,
  note: Schema.optional(Schema.String),
  active: Schema.Boolean,
  activity: Schema.Boolean,
})
export type TerminalWindowDto = typeof TerminalWindowSchema.Type

/** Every change's windows, keyed by change id: one read for the navigation's terminals. */
export const TerminalsResponseSchema = Schema.mutable(
  Schema.Record({ key: Schema.String, value: Schema.mutable(Schema.Array(TerminalWindowSchema)) }),
)
export type TerminalsResponseDto = typeof TerminalsResponseSchema.Type

export const UrlSchema = Schema.Struct({ url: Schema.String })
export type UrlDto = typeof UrlSchema.Type

export const WizardStepInfoSchema = Schema.Struct({
  id: Schema.String,
  extension: Schema.String,
  title: Schema.String,
  phase: Schema.Literal("issue", "repos"),
})
export type WizardStepInfoDto = typeof WizardStepInfoSchema.Type

export const WizardResponseSchema = Schema.Struct({
  steps: Schema.mutable(Schema.Array(WizardStepInfoSchema)),
})
export type WizardResponseDto = typeof WizardResponseSchema.Type

export const PageInfoSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  extension: Schema.String,
})
export type PageInfoDto = typeof PageInfoSchema.Type

export const PagesResponseSchema = Schema.Struct({
  pages: Schema.mutable(Schema.Array(PageInfoSchema)),
})
export type PagesResponseDto = typeof PagesResponseSchema.Type

/** One directory in the repository browser. */
export const DirectoryEntrySchema = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
  isRepo: Schema.Boolean,
})
export type DirectoryEntryDto = typeof DirectoryEntrySchema.Type

export const DirectoryListingSchema = Schema.Struct({
  path: Schema.String,
  entries: Schema.mutable(Schema.Array(DirectoryEntrySchema)),
})
export type DirectoryListingDto = typeof DirectoryListingSchema.Type

/** The query a listing request may name: an explicit path, a context's start directory, and
 * whether dot-directories are wanted. */
export type DirectoryListingSpec = {
  readonly path?: string
  readonly workspace?: string
  readonly hidden?: boolean
}

export const BranchesSchema = Schema.Struct({
  branches: Schema.mutable(Schema.Array(Schema.String)),
  default: Schema.optional(Schema.String),
})
export type BranchesDto = typeof BranchesSchema.Type

// --- Request bodies and the write responses -------------------------------------------------------

/** The creation input the wizard sends: the draft, plus the plan document it collected. The core
 * re-validates every invariant before writing, so the schema here is the shape, not the rules. */
export const CreateChangeBodySchema = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  checkouts: Schema.optional(Schema.mutable(Schema.Array(CheckoutSpecSchema))),
  workspace: Schema.optional(Schema.String),
  state: Schema.optional(ChangeStateSchema),
  extensions: Schema.optional(Schema.mutable(Schema.Record({ key: Schema.String, value: Schema.Unknown }))),
  plan: Schema.optional(Schema.String),
})
export type CreateChangeBodyDto = typeof CreateChangeBodySchema.Type

/** The repository list of a change, edited as a whole: the dialog sends the specs it wants. */
export const ReposBodySchema = Schema.Struct({
  checkouts: Schema.mutable(Schema.Array(CheckoutSpecSchema)),
  force: Schema.optional(Schema.Boolean),
})
export type ReposBodyDto = typeof ReposBodySchema.Type

/** `force` on a completion, cancel or repository removal: ask once, repeat with force. */
export const ForceBodySchema = Schema.Struct({ force: Schema.optional(Schema.Boolean) })
export type ForceBodyDto = typeof ForceBodySchema.Type

/** The window actions the terminal bar offers. */
export const WindowActionBodySchema = Schema.Struct({
  action: Schema.Literal("new", "select", "move"),
  index: Schema.optional(Schema.Number),
  from: Schema.optional(Schema.Number),
  to: Schema.optional(Schema.Number),
})
export type WindowActionBodyDto = typeof WindowActionBodySchema.Type

/** The briefing prompt was pasted into the change's terminal. */
export const PromptResponseSchema = Schema.Struct({ pasted: Schema.Boolean })
export type PromptResponseDto = typeof PromptResponseSchema.Type

/** A started change, with what each integration reported while provisioning it. */
export const StartedResponseSchema = Schema.Struct({
  change: ChangeWireSchema,
  provision: Schema.mutable(Schema.Array(ProvisionResultSchema)),
})
export type StartedResponseDto = typeof StartedResponseSchema.Type

export const CompletedResponseSchema = Schema.Struct({
  change: ChangeWireSchema,
  notes: Schema.mutable(Schema.Array(Schema.String)),
})
export type CompletedResponseDto = typeof CompletedResponseSchema.Type

export const CancelledResponseSchema = Schema.Struct({
  change: ChangeWireSchema,
  loose: Schema.mutable(Schema.Array(Schema.String)),
})
export type CancelledResponseDto = typeof CancelledResponseSchema.Type

// --- Settings and workspaces ---------------------------------------------------------------------

/** One setting an integration declares, as the settings page renders it — at both scopes. */
export const ExtensionSettingSchema = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  placeholder: Schema.optional(Schema.String),
  hint: Schema.optional(Schema.String),
  list: Schema.optional(Schema.Boolean),
  secret: Schema.optional(Schema.Boolean),
  env: Schema.optional(Schema.String),
})
export type ExtensionSettingDto = typeof ExtensionSettingSchema.Type

/** The settings page's read: the file as written, what is in effect, what is locked. */
export const SettingsViewSchema = Schema.Struct({
  path: Schema.String,
  file: ConfigFile,
  effective: Resolved,
  overridden: Schema.mutable(Schema.Record({ key: Schema.String, value: Schema.String })),
  overriddenExtensions: Schema.mutable(
    Schema.Record({
      key: Schema.String,
      value: Schema.mutable(Schema.Record({ key: Schema.String, value: Schema.String })),
    }),
  ),
  toolingDefault: Schema.mutable(Schema.Array(Schema.String)),
  extensions: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        title: Schema.String,
        settings: Schema.mutable(Schema.Array(ExtensionSettingSchema)),
      }),
    ),
  ),
})
export type SettingsViewDto = typeof SettingsViewSchema.Type

/** The contexts to switch between, and which desktop the server runs on. */
export const WorkspacesResponseSchema = Schema.Struct({
  workspaces: Schema.mutable(Schema.Array(Workspace)),
  platform: Schema.Literal("mac", "linux", "other"),
})
export type WorkspacesResponseDto = typeof WorkspacesResponseSchema.Type
