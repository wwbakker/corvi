/** The harness vocabulary shared by the server and the browser: the program a harness is, the
 * four scopes its file can be discovered in, and the mode a section chooses.
 *
 * The model that parses and resolves these values is `@corvi/agents/harness-profile` and
 * `@corvi/agents/harness-profile-discovery`; this file is what both sides of the wire agree on. */
import { Schema } from "effect";

import { TerminalWindowSchema } from "./api.ts";

/** A harness: the program a pane runs. Pi is first: it is the one Corvi generates an environment for. */
export const Harness = Schema.Literals(["pi", "opencode"]);
export type Harness = typeof Harness.Type;

/** Where a harness profile file was discovered. Built-in files ship with Corvi; a repository file lives
 * in one of the change's checkouts. */
export const HarnessProfileSource = Schema.Literals(["builtin", "global", "workspace", "repository"]);
export type HarnessProfileSource = typeof HarnessProfileSource.Type;

/** Whether a section starts from everything the base agent directory offers (`all`) or from
 * nothing but what the file includes (`none`). An absent mode means "leave the section as the
 * parent left it". */
export const HarnessProfileSectionMode = Schema.Literals(["all", "none"]);
export type HarnessProfileSectionMode = typeof HarnessProfileSectionMode.Type;

/** The four sections a harness profile file narrows or widens. */
export const HarnessProfileSectionName = Schema.Literals(["extensions", "skills", "packages", "mcp"]);
export type HarnessProfileSectionName = typeof HarnessProfileSectionName.Type;

/** The persisted discovery key of one harness: `global:review`, `workspace:personal:review`,
 * `repository:orders-api:review`. One builder, because the key is stored in settings and
 * change.json. */
export const harnessProfileKeyOf = (
  source: HarnessProfileSource,
  origin: string | undefined,
  id: string,
): string =>
  source === "global" || source === "builtin" ? `${source}:${id}` : `${source}:${origin ?? ""}:${id}`;

/** One harness profile file as the Harnesses page lists it: the file as written, and what it parses to —
 * or why it does not, shown so it can be fixed right there. */
export const HarnessProfileFileSchema = Schema.Struct({
  scope: HarnessProfileSource,
  /** The workspace a workspace file belongs to. */
  workspace: Schema.optional(Schema.String),
  workspaceLabel: Schema.optional(Schema.String),
  /** The repository a repository file belongs to, as its key spells it. */
  repository: Schema.optional(Schema.String),
  /** The filename without `.md`: the harness's id. */
  id: Schema.String,
  /** The discovery key a selector stores; built by `harnessProfileKeyOf`. */
  key: Schema.String,
  path: Schema.String,
  /** Frontmatter and body together, exactly as the file is on disk. */
  text: Schema.String,
  label: Schema.optional(Schema.String),
  problems: Schema.optional(Schema.Array(Schema.String)),
});
export type HarnessProfileFileDto = typeof HarnessProfileFileSchema.Type;

export const HarnessProfileFilesResponseSchema = Schema.Struct({
  workspaces: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  files: Schema.Array(HarnessProfileFileSchema),
});
export type HarnessProfileFilesResponseDto = typeof HarnessProfileFilesResponseSchema.Type;

/** Where a write lands: the global and workspace scopes beside the config file. A repository
 * file is written through the change-scoped routes instead; a built-in is never saved over. */
export const HarnessProfileFileWriteSchema = Schema.Struct({
  scope: Schema.Literals(["global", "workspace"]),
  workspace: Schema.optional(Schema.String),
  id: Schema.String,
  text: Schema.String,
});
export type HarnessProfileFileWriteDto = typeof HarnessProfileFileWriteSchema.Type;

export const HarnessProfileFileRefSchema = Schema.Struct({
  scope: Schema.Literals(["global", "workspace"]),
  workspace: Schema.optional(Schema.String),
  id: Schema.String,
});
export type HarnessProfileFileRefDto = typeof HarnessProfileFileRefSchema.Type;

export const HarnessProfileRepositoryFileWriteSchema = Schema.Struct({
  repository: Schema.String,
  id: Schema.String,
  text: Schema.String,
});
export type HarnessProfileRepositoryFileWriteDto = typeof HarnessProfileRepositoryFileWriteSchema.Type;

export const HarnessProfileRepositoryFileRefSchema = Schema.Struct({
  repository: Schema.String,
  id: Schema.String,
});
export type HarnessProfileRepositoryFileRefDto = typeof HarnessProfileRepositoryFileRefSchema.Type;

export const HarnessProfileRepositoryFilesResponseSchema = Schema.Struct({
  repositories: Schema.Array(
    Schema.Struct({
      repository: Schema.String,
      files: Schema.Array(HarnessProfileFileSchema),
    }),
  ),
});
export type HarnessProfileRepositoryFilesResponseDto =
  typeof HarnessProfileRepositoryFilesResponseSchema.Type;

/** One link of a resolved chain, nearest first, the built-in end last. */
export const HarnessProfileChainLinkSchema = Schema.Struct({
  key: Schema.String,
  id: Schema.String,
  label: Schema.String,
  source: HarnessProfileSource,
  sourceLabel: Schema.optional(Schema.String),
});
export type HarnessProfileChainLinkDto = typeof HarnessProfileChainLinkSchema.Type;

/** One discovered extension/skill/package/MCP server, its effective state and where it came
 * from. A `file` item is an include path that matched no base entry. */
export const EnvironmentItemSchema = Schema.Struct({
  name: Schema.String,
  state: Schema.Literals(["included", "excluded"]),
  origin: Schema.Literals(["inherited", "included", "excluded", "added-by-corvi"]),
  location: Schema.Literals([
    "extensions",
    "skills",
    "agents-skills",
    "settings",
    "mcp",
    "corvi",
    "builtin",
    "file",
  ]),
  path: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  byCorvi: Schema.optional(Schema.Boolean),
});
export type EnvironmentItemDto = typeof EnvironmentItemSchema.Type;

export const EnvironmentSectionSchema = Schema.Struct({
  mode: HarnessProfileSectionMode,
  items: Schema.Array(EnvironmentItemSchema),
});
export type EnvironmentSectionDto = typeof EnvironmentSectionSchema.Type;

/** A value that resolves but will not do what the file says. The message is the sentence the log
 * and the pane print. */
export const HarnessProfileWarningSchema = Schema.Struct({
  kind: Schema.Literals(["unknown-name", "unresolved-path", "unsupported-field"]),
  section: Schema.optional(HarnessProfileSectionName),
  name: Schema.optional(Schema.String),
  entry: Schema.optional(Schema.String),
  field: Schema.optional(Schema.String),
  message: Schema.String,
});
export type HarnessProfileWarningDto = typeof HarnessProfileWarningSchema.Type;

/** The generated environment as the Harnesses page shows it: the chain, what each section ends
 * up containing, the instructions and the warnings. Produced by the same plan the launch writes. */
export const HarnessProfileViewSchema = Schema.Struct({
  key: Schema.String,
  id: Schema.String,
  label: Schema.String,
  source: HarnessProfileSource,
  sourceLabel: Schema.optional(Schema.String),
  harness: Harness,
  chain: Schema.Array(HarnessProfileChainLinkSchema),
  generatedDir: Schema.String,
  model: Schema.optional(Schema.Struct({ provider: Schema.optional(Schema.String), id: Schema.String })),
  effort: Schema.optional(Schema.String),
  enabledModels: Schema.optional(Schema.Array(Schema.String)),
  instructions: Schema.Struct({
    origin: Schema.Literals(["profile", "base", "none"]),
    text: Schema.optional(Schema.String),
  }),
  sections: Schema.Struct({
    extensions: EnvironmentSectionSchema,
    skills: EnvironmentSectionSchema,
    packages: EnvironmentSectionSchema,
    mcp: EnvironmentSectionSchema,
  }),
  warnings: Schema.Array(HarnessProfileWarningSchema),
});
export type HarnessProfileViewDto = typeof HarnessProfileViewSchema.Type;

/** One discovered harness for the selectors and the page: its identity, its label, and — when it
 * resolves — the view. A broken chain carries `problem` instead. */
export const HarnessProfileSummarySchema = Schema.Struct({
  key: Schema.String,
  id: Schema.String,
  source: HarnessProfileSource,
  sourceLabel: Schema.optional(Schema.String),
  label: Schema.String,
  harness: Schema.optional(Harness),
  model: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String),
  view: Schema.optional(HarnessProfileViewSchema),
  problem: Schema.optional(Schema.String),
});
export type HarnessProfileSummaryDto = typeof HarnessProfileSummarySchema.Type;

/** Which harness a change actually uses: what the record stores (absent means the default), and
 * the default each selector falls back to (workspace, then global, then `pi`). */
export const HarnessProfileSelectionSchema = Schema.Struct({
  userHarnessProfile: Schema.optional(Schema.String),
  subagentHarnessProfile: Schema.optional(Schema.String),
  userDefault: Schema.String,
  subagentDefault: Schema.String,
});
export type HarnessProfileSelectionDto = typeof HarnessProfileSelectionSchema.Type;

export const HarnessProfileListResponseSchema = Schema.Struct({
  harnessProfiles: Schema.Array(HarnessProfileSummarySchema),
  skipped: Schema.Array(Schema.Struct({ key: Schema.String, reasons: Schema.Array(Schema.String) })),
  selection: HarnessProfileSelectionSchema,
});
export type HarnessProfileListResponseDto = typeof HarnessProfileListResponseSchema.Type;

/** A new harness window: which harness profile to start, and where. */
export const OpenHarnessWindowSchema = Schema.Struct({
  harnessProfile: Schema.String,
  directory: Schema.optional(Schema.String),
});
export type OpenHarnessWindowDto = typeof OpenHarnessWindowSchema.Type;

/** A new window's pane, and the change's windows as they now are. A create answers with the list
 * the page applies, the same way a window action does: the page never has to read the list back to
 * learn about a window it just opened. */
export const HarnessWindowResponseSchema = Schema.Struct({
  window: Schema.String,
  windows: Schema.Array(TerminalWindowSchema),
});
export type HarnessWindowResponseDto = typeof HarnessWindowResponseSchema.Type;

/** The harnesses a selector may offer for a scope, without resolved views: settings and the
 * wizard need keys, labels and problems, not a generated directory per entry. */
export const HarnessProfileChoicesResponseSchema = Schema.Struct({
  harnessProfiles: Schema.Array(HarnessProfileSummarySchema),
  skipped: Schema.Array(Schema.Struct({ key: Schema.String, reasons: Schema.Array(Schema.String) })),
});
export type HarnessProfileChoicesResponseDto = typeof HarnessProfileChoicesResponseSchema.Type;
