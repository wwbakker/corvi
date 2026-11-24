/** The harness vocabulary shared by the server and the browser: which agent a harness runs, the
 * four scopes its file can be discovered in, and the mode a section chooses.
 *
 * The model that parses and resolves these values is `@corvi/agents/harness-file` and
 * `@corvi/agents/harness-discovery`; this file is what both sides of the wire agree on. */
import { Schema } from "effect";

import { TerminalWindowSchema } from "./api.ts";

/** The agent a harness runs. Pi is first: it is the environment a harness generates. */
export const HarnessAgent = Schema.Literals(["pi", "opencode"]);
export type HarnessAgent = typeof HarnessAgent.Type;

/** Where a harness file was discovered. Built-in files ship with Corvi; a repository file lives
 * in one of the change's checkouts. */
export const HarnessSource = Schema.Literals(["builtin", "global", "workspace", "repository"]);
export type HarnessSource = typeof HarnessSource.Type;

/** Whether a section starts from everything the base agent directory offers (`all`) or from
 * nothing but what the file includes (`none`). An absent mode means "leave the section as the
 * parent left it". */
export const HarnessSectionMode = Schema.Literals(["all", "none"]);
export type HarnessSectionMode = typeof HarnessSectionMode.Type;

/** The four sections a harness file narrows or widens. */
export const HarnessSectionName = Schema.Literals(["extensions", "skills", "packages", "mcp"]);
export type HarnessSectionName = typeof HarnessSectionName.Type;

/** The persisted discovery key of one harness: `global:review`, `workspace:personal:review`,
 * `repository:orders-api:review`. One builder, because the key is stored in settings and
 * change.json. */
export const harnessKeyOf = (source: HarnessSource, origin: string | undefined, id: string): string =>
  source === "global" || source === "builtin" ? `${source}:${id}` : `${source}:${origin ?? ""}:${id}`;

/** One harness file as the Harnesses page lists it: the file as written, and what it parses to —
 * or why it does not, shown so it can be fixed right there. */
export const HarnessFileSchema = Schema.Struct({
  scope: HarnessSource,
  /** The workspace a workspace file belongs to. */
  workspace: Schema.optional(Schema.String),
  workspaceLabel: Schema.optional(Schema.String),
  /** The repository a repository file belongs to, as its key spells it. */
  repository: Schema.optional(Schema.String),
  /** The filename without `.md`: the harness's id. */
  id: Schema.String,
  /** The discovery key a selector stores; built by `harnessKeyOf`. */
  key: Schema.String,
  path: Schema.String,
  /** Frontmatter and body together, exactly as the file is on disk. */
  text: Schema.String,
  label: Schema.optional(Schema.String),
  problems: Schema.optional(Schema.Array(Schema.String)),
});
export type HarnessFileDto = typeof HarnessFileSchema.Type;

export const HarnessFilesResponseSchema = Schema.Struct({
  workspaces: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  files: Schema.Array(HarnessFileSchema),
});
export type HarnessFilesResponseDto = typeof HarnessFilesResponseSchema.Type;

/** Where a write lands: the global and workspace scopes beside the config file. A repository
 * file is written through the change-scoped routes instead; a built-in is never saved over. */
export const HarnessFileWriteSchema = Schema.Struct({
  scope: Schema.Literals(["global", "workspace"]),
  workspace: Schema.optional(Schema.String),
  id: Schema.String,
  text: Schema.String,
});
export type HarnessFileWriteDto = typeof HarnessFileWriteSchema.Type;

export const HarnessFileRefSchema = Schema.Struct({
  scope: Schema.Literals(["global", "workspace"]),
  workspace: Schema.optional(Schema.String),
  id: Schema.String,
});
export type HarnessFileRefDto = typeof HarnessFileRefSchema.Type;

export const HarnessRepositoryFileWriteSchema = Schema.Struct({
  repository: Schema.String,
  id: Schema.String,
  text: Schema.String,
});
export type HarnessRepositoryFileWriteDto = typeof HarnessRepositoryFileWriteSchema.Type;

export const HarnessRepositoryFileRefSchema = Schema.Struct({
  repository: Schema.String,
  id: Schema.String,
});
export type HarnessRepositoryFileRefDto = typeof HarnessRepositoryFileRefSchema.Type;

export const HarnessRepositoryFilesResponseSchema = Schema.Struct({
  repositories: Schema.Array(
    Schema.Struct({
      repository: Schema.String,
      files: Schema.Array(HarnessFileSchema),
    }),
  ),
});
export type HarnessRepositoryFilesResponseDto = typeof HarnessRepositoryFilesResponseSchema.Type;

/** One link of a resolved chain, nearest first, the built-in end last. */
export const HarnessChainLinkSchema = Schema.Struct({
  key: Schema.String,
  id: Schema.String,
  label: Schema.String,
  source: HarnessSource,
  sourceLabel: Schema.optional(Schema.String),
});
export type HarnessChainLinkDto = typeof HarnessChainLinkSchema.Type;

/** One discovered extension/skill/package/MCP server, its effective state and where it came
 * from. A `file` item is an include path that matched no base entry. */
export const HarnessResolvedItemSchema = Schema.Struct({
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
export type HarnessResolvedItemDto = typeof HarnessResolvedItemSchema.Type;

export const HarnessResolvedSectionSchema = Schema.Struct({
  mode: HarnessSectionMode,
  items: Schema.Array(HarnessResolvedItemSchema),
});
export type HarnessResolvedSectionDto = typeof HarnessResolvedSectionSchema.Type;

/** A value that resolves but will not do what the file says. The message is the sentence the log
 * and the pane print. */
export const HarnessWarningSchema = Schema.Struct({
  kind: Schema.Literals(["unknown-name", "unresolved-path", "unsupported-field"]),
  section: Schema.optional(HarnessSectionName),
  name: Schema.optional(Schema.String),
  entry: Schema.optional(Schema.String),
  field: Schema.optional(Schema.String),
  message: Schema.String,
});
export type HarnessWarningDto = typeof HarnessWarningSchema.Type;

/** The generated environment as the Harnesses page shows it: the chain, what each section ends
 * up containing, the instructions and the warnings. Produced by the same plan the launch writes. */
export const HarnessViewSchema = Schema.Struct({
  key: Schema.String,
  id: Schema.String,
  label: Schema.String,
  source: HarnessSource,
  sourceLabel: Schema.optional(Schema.String),
  agent: HarnessAgent,
  chain: Schema.Array(HarnessChainLinkSchema),
  generatedDir: Schema.String,
  model: Schema.optional(Schema.Struct({ provider: Schema.optional(Schema.String), id: Schema.String })),
  effort: Schema.optional(Schema.String),
  enabledModels: Schema.optional(Schema.Array(Schema.String)),
  instructions: Schema.Struct({
    origin: Schema.Literals(["harness", "base", "none"]),
    text: Schema.optional(Schema.String),
  }),
  sections: Schema.Struct({
    extensions: HarnessResolvedSectionSchema,
    skills: HarnessResolvedSectionSchema,
    packages: HarnessResolvedSectionSchema,
    mcp: HarnessResolvedSectionSchema,
  }),
  warnings: Schema.Array(HarnessWarningSchema),
});
export type HarnessViewDto = typeof HarnessViewSchema.Type;

/** One discovered harness for the selectors and the page: its identity, its label, and — when it
 * resolves — the view. A broken chain carries `problem` instead. */
export const HarnessSummarySchema = Schema.Struct({
  key: Schema.String,
  id: Schema.String,
  source: HarnessSource,
  sourceLabel: Schema.optional(Schema.String),
  label: Schema.String,
  agent: Schema.optional(HarnessAgent),
  model: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String),
  view: Schema.optional(HarnessViewSchema),
  problem: Schema.optional(Schema.String),
});
export type HarnessSummaryDto = typeof HarnessSummarySchema.Type;

/** Which harness a change actually uses: what the record stores (absent means the default), and
 * the default each selector falls back to (workspace, then global, then `pi`). */
export const HarnessSelectionSchema = Schema.Struct({
  userHarness: Schema.optional(Schema.String),
  subagentHarness: Schema.optional(Schema.String),
  userDefault: Schema.String,
  subagentDefault: Schema.String,
});
export type HarnessSelectionDto = typeof HarnessSelectionSchema.Type;

export const HarnessListResponseSchema = Schema.Struct({
  harnesses: Schema.Array(HarnessSummarySchema),
  skipped: Schema.Array(Schema.Struct({ key: Schema.String, reasons: Schema.Array(Schema.String) })),
  selection: HarnessSelectionSchema,
});
export type HarnessListResponseDto = typeof HarnessListResponseSchema.Type;

/** A new harness window: which harness to start, and where. */
export const OpenHarnessWindowSchema = Schema.Struct({
  harness: Schema.String,
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
export const HarnessChoicesResponseSchema = Schema.Struct({
  harnesses: Schema.Array(HarnessSummarySchema),
  skipped: Schema.Array(Schema.Struct({ key: Schema.String, reasons: Schema.Array(Schema.String) })),
});
export type HarnessChoicesResponseDto = typeof HarnessChoicesResponseSchema.Type;
