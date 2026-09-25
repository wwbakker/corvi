/** The action file's fields, documented for the page that edits them: what each field is for,
 * the values it takes, and what an absent one means.
 *
 * The vocabulary this describes is `./model`'s, and the two cannot drift: the entries are keyed
 * by `Action`'s fields (the `satisfies` below fails to compile when the vocabulary learns a
 * field this has not documented, or vice versa), and the possible values are read from the
 * contracts schemas (`ActionKind`, `ActionTarget`, `ChangePhase`) rather than retyped. The
 * words are the manual's (`docs/manual/configuration.md`), so the panel, the parser and the
 * manual answer with one voice.
 *
 * Pure and browser-safe: this is data and the schemas it names, nothing else — the editor's
 * documentation panel renders it (`apps/web/src/actions/ActionDocs.tsx`). */
import type { Action } from "./model.ts";
import { ActionKind, ActionTarget } from "@corvi/contracts/actions";
import { ChangePhase } from "@corvi/contracts/changes";

/** What a field accepts: the vocabulary's own literal values, or words that say what to type. */
export type ActionFieldValues =
  | { readonly kind: "choices"; readonly choices: readonly string[] }
  | { readonly kind: "text"; readonly note: string };

/** One documented entry: a frontmatter field, or the body below the frontmatter. The name is
 * the entry's key below — `Action`'s own field names, and nothing else. */
export type ActionFieldDoc = ActionFieldEntry & {
  /** The frontmatter key, or `body` for the body. */
  readonly name: string;
};

/** What an entry says about its field; the keyed object below holds one per field. */
type ActionFieldEntry = {
  /** Whether a file without it is not an action. */
  readonly required: boolean;
  /** What the field is for — including how it behaves with the others. */
  readonly about: string;
  /** What it accepts. */
  readonly values: ActionFieldValues;
  /** What an absent field means; omitted where absence needs no explanation. */
  readonly defaultValue?: string;
};

/** The possible values as the schema states them. */
const kinds: readonly string[] = ActionKind.literals;
const targets: readonly string[] = ActionTarget.literals;
const phases: readonly string[] = ChangePhase.literals;
const toggle: readonly string[] = ["true", "false"];

/** The documentation, one entry per field of `Action` — keyed by the vocabulary itself, so the
 * compiler is the pin: a field `./model` learns must be documented here, and an entry for a
 * field the vocabulary does not have cannot exist. Declared in reading order. */
const documented = {
  label: {
    required: true,
    about: "How the menu names it.",
    values: { kind: "text", note: "free text" },
  },
  kind: {
    required: true,
    about: "What it delivers: text for an agent, or a shell command.",
    values: { kind: "choices", choices: kinds },
  },
  target: {
    required: false,
    about:
      "Where it goes: the pane you are on (active), the window an agent runs in (agent), or a new window (new). A command cannot target an agent window.",
    values: { kind: "choices", choices: targets },
    defaultValue: "active",
  },
  start: {
    required: false,
    about:
      "What a started window runs. Required for a prompt into a new window — otherwise the text would land in a shell. The fallback for an agent window with none running.",
    values: { kind: "text", note: "a shell command line" },
    defaultValue: "pi, for agent windows",
  },
  submit: {
    required: false,
    about:
      "Prompt only: press Enter after pasting. Without it the text waits in the agent's editor. A command always submits.",
    values: { kind: "choices", choices: toggle },
    defaultValue: "false",
  },
  phases: {
    required: false,
    about: "When the action is offered: a list of the change's phases.",
    values: { kind: "choices", choices: phases },
    defaultValue: "every phase",
  },
  notify: {
    required: false,
    about:
      "Command only: keep the finished window and let it call you. Implies keepOpen.",
    values: { kind: "choices", choices: toggle },
    defaultValue: "false",
  },
  keepOpen: {
    required: false,
    about:
      "Command only: freeze the pane over its output instead of closing the window at the end.",
    values: { kind: "choices", choices: toggle },
    defaultValue: "false",
  },
  body: {
    required: false,
    about: "What the action says or runs: everything below the frontmatter.",
    values: {
      kind: "text",
      note: "free text — {id}, {title}, {branch}, {plan}, {state}, {dir} and {repos} are filled in when the action runs",
    },
  },
} satisfies Record<keyof Action, ActionFieldEntry>;

export const actionFieldDocs: readonly ActionFieldDoc[] = Object.entries(documented).map(
  ([name, entry]): ActionFieldDoc => ({ name, ...entry }),
);
