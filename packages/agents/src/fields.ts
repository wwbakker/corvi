/** The subagent profile's fields, documented for the page that edits them: what each field is
 * for, the values it takes, and what an absent one means. The harness profile's fields are the
 * same vocabulary with the two profile-specific entries left out.
 *
 * `harness` names the program (`pi` | `opencode`) in both file kinds; `basedOnHarnessProfile`
 * names the harness profile a file is layered on. One key, one meaning.
 *
 * The vocabulary this describes is `./subagent-profile`'s and `./harness-profile-file`'s, and the
 * two cannot drift: the entries are keyed by those types (the `satisfies` below fails to compile
 * when the vocabulary learns a field this has not documented, or vice versa), and the possible
 * values are read from the contracts schemas rather than retyped. The words are the manual's
 * (`docs/manual/configuration.md`), so the panel, the parser and the manual answer with one
 * voice.
 *
 * Pure and browser-safe: this is data and the schemas it names, nothing else. */
import type { SubagentProfile } from "./subagentProfile.ts";
import { SUBAGENT_EFFORTS } from "./subagentProfile.ts";
import type { HarnessProfile } from "./harnessProfileFile.ts";
import { Harness } from "@corvi/contracts/harness-profiles";
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

const harnesses: readonly string[] = Harness.literals;
const phases: readonly string[] = ChangePhase.literals;

/** The entries both file kinds share. The subagent page and the Harness profiles page render the
 * same words for them, so a field cannot mean two things in two places. */
const shared = {
  model: {
    required: false,
    about:
      "The model passed to the harness. An id the harness does not know fails at first launch, not here — model catalogs change.",
    values: { kind: "text", note: "a model id, e.g. zai/glm-5.3-flash" },
    defaultValue: "the harness profile's own default",
  },
  effort: {
    required: false,
    about: "How hard the harness thinks, mapped to the harness's own setting (pi: --thinking).",
    values: { kind: "choices", choices: [...SUBAGENT_EFFORTS] },
    defaultValue: "the harness profile's own default",
  },
  enabledModels: {
    required: false,
    about: "The model ids a pi session may switch between.",
    values: { kind: "text", note: "a list of model ids" },
    defaultValue: "the harness profile's own list",
  },
  instructions: {
    required: false,
    about: "Markdown that replaces the base AGENTS.md instructions; an empty value clears them.",
    values: { kind: "text", note: "free Markdown" },
    defaultValue: "the harness profile's instructions",
  },
  extensions: {
    required: false,
    about:
      "Which pi extensions to load. `mode: all|none` replaces the harness profile's section; `include`/`exclude` names add to its lists.",
    values: { kind: "text", note: "mode: all or none; include and exclude name extensions" },
    defaultValue: "the harness profile's section",
  },
  skills: {
    required: false,
    about:
      "Which skills to load. `mode: all|none` replaces the harness profile's section; `include`/`exclude` names add to its lists.",
    values: { kind: "text", note: "mode: all or none; include and exclude name skills" },
    defaultValue: "the harness profile's section",
  },
  packages: {
    required: false,
    about:
      "Which packages to load. `mode: all|none` replaces the harness profile's section; `include`/`exclude` names add to its lists.",
    values: { kind: "text", note: "mode: all or none; include and exclude name packages" },
    defaultValue: "the harness profile's section",
  },
  mcp: {
    required: false,
    about:
      "Which MCP servers to load. `mode: all|none` replaces the harness profile's section; `include`/`exclude` names add to its lists.",
    values: { kind: "text", note: "mode: all or none; include and exclude name MCP servers" },
    defaultValue: "the harness profile's section",
  },
} satisfies Record<string, ProfileFieldEntry>;

/** The documentation, one entry per field of `SubagentProfile` — keyed by the vocabulary itself,
 * so the compiler is the pin. Declared in reading order. */
const documented = {
  label: {
    required: true,
    about: "How the Subagents page and the menu name it.",
    values: { kind: "text", note: "free text" },
  },
  harness: {
    required: false,
    about:
      "The program this subagent runs: `pi` or `opencode`. It must agree with the harness profile it is based on; a value that disagrees is an error.",
    values: { kind: "choices", choices: harnesses },
    defaultValue: "the harness profile's own program",
  },
  basedOnHarnessProfile: {
    required: false,
    about:
      "The harness profile this subagent is layered on, by id (`subagents-base`) or key (`global:subagents-base`). Its environment comes from that profile; this file's fields overlay it.",
    values: { kind: "text", note: "a harness profile id or key, e.g. subagents-base" },
    defaultValue: "the change's subagent selector, then the settings default, then builtin:pi",
  },
  ...shared,
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
} satisfies Record<keyof SubagentProfile, ProfileFieldEntry>;

export const profileFieldDocs: readonly ProfileFieldDoc[] = Object.entries(documented).map(
  ([name, entry]): ProfileFieldDoc => ({ name, ...entry }),
);

/** The harness profile's fields: the same vocabulary, with `basedOnHarnessProfile` naming the
 * profile this file inherits from and the body free notes rather than a task. */
const documentedHarness = {
  label: {
    required: true,
    about: "How the Harness profiles page and the selectors name it.",
    values: { kind: "text", note: "free text" },
  },
  harness: {
    required: false,
    about:
      "The program the environment runs: `pi` or `opencode`. Only a built-in chain end declares it; every other file inherits it, and a file that switches it is an error.",
    values: { kind: "choices", choices: harnesses },
    defaultValue: "the program of the built-in the chain ends at (pi)",
  },
  basedOnHarnessProfile: {
    required: false,
    about:
      "The harness profile this file inherits from, by id (`pi-bare`) or key (`builtin:pi`). The chain ends at a built-in (`pi`, `pi-bare`, `opencode`); a user file may name one by id or key.",
    values: { kind: "text", note: "a harness profile id or key, e.g. pi-bare" },
    defaultValue: "the built-in pi (a user file without a base inherits pi)",
  },
  ...shared,
  body: {
    required: false,
    about: "Free-form notes for the reader. Corvi ignores the body of a harness profile file.",
    values: { kind: "text", note: "free text" },
  },
} satisfies Record<keyof (HarnessProfile & { readonly body: string }), ProfileFieldEntry>;

export const harnessProfileFieldDocs: readonly ProfileFieldDoc[] = Object.entries(documentedHarness).map(
  ([name, entry]): ProfileFieldDoc => ({ name, ...entry }),
);
