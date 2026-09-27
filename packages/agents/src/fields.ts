/** The subagent profile's fields, documented for the page that edits them: what each field is
 * for, the values it takes, and what an absent one means.
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
import { SubagentHarness } from "@corvi/contracts/subagents";
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

const harnesses: readonly string[] = SubagentHarness.literals;
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
    required: true,
    about: "Which agent the subagent runs.",
    values: { kind: "choices", choices: harnesses },
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
  phases: {
    required: false,
    about: "When the profile is offered: a list of the change's phases.",
    values: { kind: "choices", choices: phases },
    defaultValue: "every phase",
  },
  body: {
    required: false,
    about:
      "The initial prompt: everything below the frontmatter. When it contains {prompt} the orchestrator's task text is substituted there; otherwise the task is appended as a final `## Task` section.",
    values: {
      kind: "text",
      note: "free text — {id}, {title}, {branch}, {plan}, {state}, {dir}, {repos} and {prompt}",
    },
  },
} satisfies Record<keyof Profile, ProfileFieldEntry>;

export const profileFieldDocs: readonly ProfileFieldDoc[] = Object.entries(documented).map(
  ([name, entry]): ProfileFieldDoc => ({ name, ...entry }),
);
