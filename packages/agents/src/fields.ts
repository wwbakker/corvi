/** The subagent profile's fields, documented for the page that edits them: what each field is
 * for, the values it takes, and what an absent one means.
 *
 * A profile carries the harness vocabulary, so the same fields a harness file documents are here
 * too: `harness` names the harness (rather than the base it inherits from), and the rest overlay
 * that harness's own settings.
 *
 * The vocabulary this describes is `./profile`'s, and the two cannot drift: the entries are
 * keyed by `Profile`'s fields (the `satisfies` below fails to compile when the vocabulary learns
 * a field this has not documented, or vice versa), and the possible values are read from the
 * contracts schemas rather than retyped. The words are the manual's
 * (`docs/manual/configuration.md`), so the panel, the parser and the manual answer with one
 * voice.
 *
 * Pure and browser-safe: this is data and the schemas it names, nothing else. */
import type { Profile } from "./profile.ts";
import { SUBAGENT_EFFORTS } from "./profile.ts";
import type { Harness } from "./harnessFile.ts";
import { HarnessAgent } from "@corvi/contracts/harnesses";
import { ChangePhase } from "@corvi/contracts/changes";

/** What a field accepts: the vocabulary's own literal values, or words that say what to type. */
export type ProfileFieldValues =
  | { readonly kind: "choices"; readonly choices: readonly string[] }
  | { readonly kind: "text"; readonly note: string };

/** What an entry says about its field; the keyed object below holds one per field. */
type ProfileFieldEntry = {
  /** Whether a file without it is not a profile. */
  readonly required: boolean;
  /** What the field is for — including how it behaves with the others. */
  readonly about: string;
  /** What it accepts. */
  readonly values: ProfileFieldValues;
  /** What an absent field means; omitted where absence needs no explanation. */
  readonly defaultValue?: string;
};

/** One documented entry: a frontmatter field, or the body below the frontmatter. */
export type ProfileFieldDoc = ProfileFieldEntry & {
  /** The frontmatter key, or `body` for the body. */
  readonly name: string;
};

const agents: readonly string[] = HarnessAgent.literals;
const phases: readonly string[] = ChangePhase.literals;

/** The documentation, one entry per field of `Profile` — keyed by the vocabulary itself, so the
 * compiler is the pin. Declared in reading order. */
const documented = {
  label: {
    required: true,
    about: "How the Subagents page and the menu name it.",
    values: { kind: "text", note: "free text" },
  },
  harness: {
    required: false,
    about:
      "The harness this subagent runs, by id: `pi`, `pi-bare`, `opencode`, or one of the files on the Harnesses page.",
    values: { kind: "text", note: "a harness id, e.g. pi-bare or review-env" },
    defaultValue: "the change's subagent default (workspace, then global, then pi)",
  },
  agent: {
    required: false,
    about:
      "Which agent runs it. Absent inherits the harness's own; a value that disagrees with the harness is an error.",
    values: { kind: "choices", choices: agents },
    defaultValue: "the harness's agent",
  },
  model: {
    required: false,
    about:
      "The model passed to the harness. An id the harness does not know fails at first launch, not here — model catalogs change.",
    values: { kind: "text", note: "a model id, e.g. zai/glm-5.3-flash" },
    defaultValue: "the harness's own default",
  },
  effort: {
    required: false,
    about: "How hard the harness thinks, mapped to the harness's own setting (pi: --thinking).",
    values: { kind: "choices", choices: [...SUBAGENT_EFFORTS] },
    defaultValue: "the harness's own default",
  },
  enabledModels: {
    required: false,
    about: "The model ids a pi session may switch between.",
    values: { kind: "text", note: "a list of model ids" },
    defaultValue: "the harness's own list",
  },
  instructions: {
    required: false,
    about: "Markdown that replaces the base AGENTS.md instructions; an empty value clears them.",
    values: { kind: "text", note: "free Markdown" },
    defaultValue: "the harness's instructions",
  },
  extensions: {
    required: false,
    about:
      "Which pi extensions to load. `mode: all|none` replaces the harness's section; `include`/`exclude` names add to its lists.",
    values: { kind: "text", note: "mode: all or none; include and exclude name extensions" },
    defaultValue: "the harness's section",
  },
  skills: {
    required: false,
    about:
      "Which skills to load. `mode: all|none` replaces the harness's section; `include`/`exclude` names add to its lists.",
    values: { kind: "text", note: "mode: all or none; include and exclude name skills" },
    defaultValue: "the harness's section",
  },
  packages: {
    required: false,
    about:
      "Which packages to load. `mode: all|none` replaces the harness's section; `include`/`exclude` names add to its lists.",
    values: { kind: "text", note: "mode: all or none; include and exclude name packages" },
    defaultValue: "the harness's section",
  },
  mcp: {
    required: false,
    about:
      "Which MCP servers to load. `mode: all|none` replaces the harness's section; `include`/`exclude` names add to its lists.",
    values: { kind: "text", note: "mode: all or none; include and exclude name MCP servers" },
    defaultValue: "the harness's section",
  },
  phases: {
    required: false,
    about: "When the profile is offered: a list of the change's phases.",
    values: { kind: "choices", choices: phases },
    defaultValue: "every phase",
  },
  body: {
    required: false,
    about:
      'The initial prompt: everything below the frontmatter. When it contains {prompt} the orchestrator\'s task text is substituted there; otherwise the task is appended as a final `## Task` section. With no task, {prompt} becomes "Please await your initial instructions." (a body-less profile sends that text alone).',
    values: {
      kind: "text",
      note: "free text — {id}, {title}, {branch}, {plan}, {state}, {dir}, {repos} and {prompt}",
    },
  },
} satisfies Record<keyof Profile, ProfileFieldEntry>;

export const profileFieldDocs: readonly ProfileFieldDoc[] = Object.entries(documented).map(
  ([name, entry]): ProfileFieldDoc => ({ name, ...entry }),
);

/** The harness file's fields: the same vocabulary a profile carries, with `harness` meaning the
 * base it inherits from, and the body free notes rather than a task. */
const documentedHarness = {
  label: {
    required: true,
    about: "How the Harnesses page and the selectors name it.",
    values: { kind: "text", note: "free text" },
  },
  harness: {
    required: false,
    about:
      "The harness this one inherits from, by id. The chain ends at a built-in (`pi`, `pi-bare`, `opencode`); a file that is not built-in must name a base.",
    values: { kind: "text", note: "a harness id, e.g. pi-bare" },
    defaultValue: "the built-in id itself (only built-in files may omit it)",
  },
  agent: documented.agent,
  model: documented.model,
  effort: documented.effort,
  enabledModels: documented.enabledModels,
  instructions: documented.instructions,
  extensions: documented.extensions,
  skills: documented.skills,
  packages: documented.packages,
  mcp: documented.mcp,
  body: {
    required: false,
    about: "Free-form notes for the reader. Corvi ignores the body of a harness file.",
    values: { kind: "text", note: "free text" },
  },
} satisfies Record<keyof (Harness & { readonly body: string }), ProfileFieldEntry>;

export const harnessFieldDocs: readonly ProfileFieldDoc[] = Object.entries(documentedHarness).map(
  ([name, entry]): ProfileFieldDoc => ({ name, ...entry }),
);
